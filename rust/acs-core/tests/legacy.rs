//! Legacy v1 canonical text and digests. Expected values come from `packages/shared/src/hash.ts`
//! (`canonicalJson` and `stableHash`), not from this crate.

use acs_core::legacy::{LegacyError, legacy_canonical_json, legacy_stable_hash};
use serde_json::{Value, json};

fn parse(text: &str) -> Value {
    serde_json::from_str(text).expect("valid JSON fixture")
}

#[test]
fn integer_like_keys_are_emitted_numerically_first() {
    let value = json!({ "10": 1, "2": 3, "9": 2, "x": 4 });
    assert_eq!(
        legacy_canonical_json(&value).unwrap(),
        r#"{"2":3,"9":2,"10":1,"x":4}"#
    );
    assert_eq!(
        legacy_stable_hash(&value).unwrap(),
        "1ae0ca5fbafc672a7c9d1d863b8221f43ea3b03637d5c70401fb2dbbc4698c11"
    );
}

#[test]
fn keys_follow_icu_root_collation_not_code_points() {
    let value =
        json!({ "b": 1, "B": 2, "a": 3, "A": 4, "work_item.id": 5, "work.item": 6, "a-b": 7 });
    assert_eq!(
        legacy_canonical_json(&value).unwrap(),
        r#"{"a":3,"A":4,"a-b":7,"b":1,"B":2,"work_item.id":5,"work.item":6}"#
    );
    assert_eq!(
        legacy_stable_hash(&value).unwrap(),
        "dfaa804d7411fd4cda078f67112a3b995e22a2856a97d14936b45a9b741171cb"
    );
}

#[test]
fn nested_arrays_and_objects_match_v1() {
    let value = json!({ "z": [null, true, false, { "y": 1, "x": [] }], "a": { "c": 0, "b": "s" } });
    assert_eq!(
        legacy_canonical_json(&value).unwrap(),
        r#"{"a":{"b":"s","c":0},"z":[null,true,false,{"x":[],"y":1}]}"#
    );
    assert_eq!(
        legacy_stable_hash(&value).unwrap(),
        "4b13665bd687c603d0724a63fd7aa05e9c91ed66b357473009528ec9b5af0e09"
    );
}

#[test]
fn canonically_equivalent_keys_keep_document_order() {
    // Both keys collate as equal, so the stable sort keeps JSON insertion order.
    let precomposed_first = parse("{\"\u{e9}\":1,\"e\u{301}\":2}");
    let decomposed_first = parse("{\"e\u{301}\":2,\"\u{e9}\":1}");
    assert_eq!(
        legacy_canonical_json(&precomposed_first).unwrap(),
        "{\"\u{e9}\":1,\"e\u{301}\":2}"
    );
    assert_eq!(
        legacy_canonical_json(&decomposed_first).unwrap(),
        "{\"e\u{301}\":2,\"\u{e9}\":1}"
    );
    assert_eq!(
        legacy_stable_hash(&precomposed_first).unwrap(),
        "f126472a603049b5f986bb8f35ba8b5fbace9e37c2d5b2abf5ad131a166835b6"
    );
    assert_eq!(
        legacy_stable_hash(&decomposed_first).unwrap(),
        "a7962fb10dc1255be368ece9c22b2256605921dc6d0a8c9409d3ee406bcb86e5"
    );
}

#[test]
fn floats_and_unsafe_integers_fail_closed() {
    assert!(matches!(
        legacy_canonical_json(&json!(1.5)),
        Err(LegacyError::UnsupportedNumber(_))
    ));
    assert!(legacy_canonical_json(&json!(9_007_199_254_740_992_i64)).is_err());
}
