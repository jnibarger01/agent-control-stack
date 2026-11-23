//! Replays `cases.jsonl` against the native port.
//!
//! Strings are interned exactly as `packages/integration-manager/native/bridge.cjs` does:
//! ids start at 1 in first-seen order, cross-repository heads take id 0, and the target is
//! interned after the rows. Expected values use the recorded tagged encoding: `$map` as
//! ordered pairs, `$set` as insertion order, and `$utf16` for lone surrogate code units.
//! Comparison is by UTF-16 code unit, the same order JavaScript's default sort uses.

use std::collections::HashMap;

use serde_json::Value;

use crate::port;

type Text = Vec<u16>;

const RECORDED_CASES: usize = 16;

fn text(value: &Value) -> Text {
    match value {
        Value::String(s) => s.encode_utf16().collect(),
        Value::Object(map) => map["$utf16"]
            .as_array()
            .expect("$utf16 array")
            .iter()
            .map(|unit| u16::try_from(unit.as_u64().expect("code unit")).expect("u16 code unit"))
            .collect(),
        other => panic!("expected text, found {other}"),
    }
}

fn integers(value: &Value) -> Vec<i64> {
    value
        .as_array()
        .expect("array")
        .iter()
        .map(|n| n.as_i64().expect("integer"))
        .collect()
}

fn set(value: &Value) -> Vec<i64> {
    integers(&value["$set"])
}

fn pairs(value: &Value) -> Vec<(i64, Value)> {
    value
        .as_array()
        .expect("$map pairs")
        .iter()
        .map(|pair| (pair[0].as_i64().expect("key"), pair[1].clone()))
        .collect()
}

/// Mirrors the bridge's string table. Index 0 is the reserved empty placeholder.
struct Interner {
    ids: HashMap<Text, u32>,
    texts: Vec<Text>,
}

impl Interner {
    fn new() -> Self {
        Self {
            ids: HashMap::new(),
            texts: vec![Vec::new()],
        }
    }

    fn id(&mut self, value: Text) -> u32 {
        if let Some(&id) = self.ids.get(&value) {
            return id;
        }
        self.texts.push(value.clone());
        let id = u32::try_from(self.texts.len() - 1).expect("id fits u32");
        self.ids.insert(value, id);
        id
    }
}

fn check_analysis(case: &Value, args: &[Value]) {
    let prs = args[0].as_array().expect("pull requests");
    let mut refs = Interner::new();
    let mut numbers = Vec::new();
    let mut heads = Vec::new();
    let mut bases = Vec::new();
    for pr in prs {
        numbers.push(pr["number"].as_i64().expect("number"));
        let cross = pr["isCrossRepository"].as_bool().expect("boolean");
        heads.push(if cross {
            0
        } else {
            refs.id(text(&pr["headRef"]))
        });
        bases.push(refs.id(text(&pr["baseRef"])));
    }
    let target = refs.id(text(&args[1]));

    let actual = port::analyze_dependencies(&numbers, &heads, &bases, target);
    let expected = &case["ok"];

    let depends = pairs(&expected["dependsOn"]["$map"]);
    assert_eq!(depends.len(), numbers.len(), "dependsOn row count");
    for (row, (number, parents)) in depends.iter().enumerate() {
        assert_eq!(*number, numbers[row], "dependsOn key order");
        assert_eq!(
            integers(parents),
            actual.parents[row],
            "parents of {number}"
        );
    }
    assert_eq!(set(&expected["cyclic"]), actual.cyclic, "cyclic");
    assert_eq!(
        set(&expected["blockedByCycle"]),
        actual.blocked_by_cycle,
        "blockedByCycle"
    );
    assert_eq!(set(&expected["detached"]), actual.detached, "detached");
    assert_eq!(integers(&expected["order"]), actual.order, "order");
}

fn check_overlaps(case: &Value, args: &[Value]) {
    let prs = args[0].as_array().expect("pull requests");
    let mut paths = Interner::new();
    let mut numbers = Vec::new();
    let mut files: Vec<Vec<u32>> = Vec::new();
    for pr in prs {
        numbers.push(pr["number"].as_i64().expect("number"));
        let row = pr["changedFiles"]
            .as_array()
            .expect("changed files")
            .iter()
            .map(|file| paths.id(text(file)))
            .collect();
        files.push(row);
    }

    let actual = port::find_overlaps(&numbers, &files);
    let expected = pairs(&case["ok"]["$map"]);
    assert_eq!(expected.len(), numbers.len(), "overlap row count");
    for (row, (number, overlaps)) in expected.iter().enumerate() {
        assert_eq!(*number, numbers[row], "overlap key order");
        let want: Vec<(i64, Vec<Text>)> = overlaps
            .as_array()
            .expect("overlap list")
            .iter()
            .map(|overlap| {
                (
                    overlap["number"].as_i64().expect("overlap number"),
                    overlap["files"]
                        .as_array()
                        .expect("files")
                        .iter()
                        .map(text)
                        .collect(),
                )
            })
            .collect();
        let got: Vec<(i64, Vec<Text>)> = actual[row]
            .iter()
            .map(|overlap| {
                let mut names: Vec<Text> = overlap
                    .files
                    .iter()
                    .map(|&id| paths.texts[id as usize].clone())
                    .collect();
                names.sort();
                (overlap.number, names)
            })
            .collect();
        assert_eq!(got, want, "overlaps of {number}");
    }
}

#[test]
fn replays_every_recorded_case_against_the_port() {
    let mut analysis_cases = 0;
    let mut overlap_cases = 0;
    let lines: Vec<&str> = include_str!("../cases.jsonl")
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect();
    assert_eq!(
        lines.len(),
        RECORDED_CASES,
        "recorded fixture count changed"
    );
    for (index, line) in lines.iter().enumerate() {
        let case: Value =
            serde_json::from_str(line).unwrap_or_else(|e| panic!("case {index}: {e}"));
        assert!(case.get("error").is_none(), "case {index} records an error");
        let args = case["args"].as_array().expect("args");
        match case["fn"].as_str().expect("fn") {
            "analyzeDependencies" => {
                check_analysis(&case, args);
                analysis_cases += 1;
            }
            "findOverlaps" => {
                check_overlaps(&case, args);
                overlap_cases += 1;
            }
            other => panic!("case {index}: unknown function {other}"),
        }
    }
    assert!(analysis_cases > 0 && overlap_cases > 0);
}
