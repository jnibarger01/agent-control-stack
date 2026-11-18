use std::{
    io::Write,
    process::{Command, Output, Stdio},
};

use serde_json::{Value, json};

fn exchange(input: &[u8]) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_acs-scope-supervisor"))
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(input).unwrap();
    child.wait_with_output().unwrap()
}

fn frame(seq: u32, event: Value) -> String {
    format!("{}\n", json!({ "version": 1, "seq": seq, "event": event }))
}

fn run(events: &[Value]) -> Vec<Value> {
    let input: String = events
        .iter()
        .enumerate()
        .map(|(index, event)| frame(index as u32 + 1, event.clone()))
        .collect();
    let output = exchange(input.as_bytes());
    assert!(output.status.success(), "{:?}", output.stderr);
    let lines: Vec<Value> = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(lines.len(), events.len());
    for (index, reply) in lines.iter().enumerate() {
        assert_eq!(reply["version"], 1);
        assert_eq!(reply["seq"], index + 1);
    }
    lines
        .into_iter()
        .map(|line| line["effects"].clone())
        .collect()
}

#[test]
fn close_during_term_waits_for_reply_and_preserves_first_trigger() {
    let effects = run(&[
        json!({"type": "cancel"}),
        json!({"type": "deadline_elapsed"}),
        json!({"type": "launcher_closed"}),
        json!({"type": "scope_signal_completed", "signal": "term", "failed": true}),
    ]);
    assert_eq!(
        effects,
        [
            json!([{"type":"signal_scope", "signal":"term"}]),
            json!([]),
            json!([{"type":"clear_timers"}]),
            json!([{"type":"finish", "trigger":"cancelled", "signal_failed":true}]),
        ]
    );
}

#[test]
fn close_during_kill_suppresses_late_launcher_signal() {
    let effects = run(&[
        json!({"type": "deadline_elapsed"}),
        json!({"type": "scope_signal_completed", "signal": "term", "failed": false}),
        json!({"type": "grace_elapsed"}),
        json!({"type": "launcher_closed"}),
        json!({"type": "scope_signal_completed", "signal": "kill", "failed": false}),
    ]);
    assert_eq!(
        effects,
        [
            json!([{"type":"signal_scope", "signal":"term"}]),
            json!([{"type":"signal_launcher", "signal":"term"}, {"type":"arm_grace"}]),
            json!([{"type":"signal_scope", "signal":"kill"}]),
            json!([{"type":"clear_timers"}]),
            json!([{"type":"finish", "trigger":"timeout", "signal_failed":false}]),
        ]
    );
}

#[test]
fn invalid_wire_inputs_emit_no_effects() {
    let inputs = [
        format!("{}\n", " ".repeat(1024)),
        frame(2, json!({"type": "cancel"})),
        frame(1, json!({"type": "cancel", "scope": "another.scope"})),
        frame(1, json!({"type": "grace_elapsed"})),
        frame(
            1,
            json!({"type": "scope_signal_completed", "signal": "term", "failed": false}),
        ),
        String::from(r#"{"version":2,"seq":1,"event":{"type":"cancel"}}"#) + "\n",
        String::from(r#"{"version":1,"seq":1,"event":{"type":"launcher_closed"}}"#),
    ];
    for input in inputs {
        let output = exchange(input.as_bytes());
        assert!(!output.status.success());
        assert!(output.stdout.is_empty());
    }
}

#[test]
fn disconnect_before_close_exits_without_finish() {
    let output = exchange(frame(1, json!({"type": "cancel"})).as_bytes());
    assert!(!output.status.success());
    let reply: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(
        reply["effects"],
        json!([{"type":"signal_scope", "signal":"term"}])
    );
}

#[test]
fn replayed_sequence_does_not_publish_a_second_decision() {
    let input = frame(1, json!({"type":"cancel"})) + &frame(1, json!({"type":"launcher_closed"}));
    let output = exchange(input.as_bytes());
    assert!(!output.status.success());
    let reply: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(reply["seq"], 1);
    assert_eq!(
        reply["effects"],
        json!([{"type":"signal_scope", "signal":"term"}])
    );
}

#[test]
fn session_exhaustion_has_no_terminal_observation() {
    let input: String = (1..=17)
        .map(|seq| frame(seq, json!({"type":"cancel"})))
        .collect();
    let output = exchange(input.as_bytes());
    assert!(!output.status.success());
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert_eq!(stdout.lines().count(), 16);
    assert!(!stdout.contains("finish"));
}
