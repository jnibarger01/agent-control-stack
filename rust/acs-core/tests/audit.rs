//! Audit chain verification on the tracked historical backup, plus in-memory tampering.
//! The database is copied to a scratch directory first. The tracked file is never opened.

use std::fs;
use std::path::PathBuf;

use acs_core::audit::{AuditError, Verdict, events_from_rows, verify_chain, verify_database};
use acs_core::store::{AuditRow, Store};

const HISTORICAL: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../storage/local.db.bak-20261103-182951"
);

fn copy_historical() -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "acs-core-historical-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&dir).unwrap();
    let copy = dir.join("historical.db");
    fs::copy(HISTORICAL, &copy).unwrap();
    copy
}

#[test]
fn verifies_the_historical_chain_with_the_same_verdict_as_typescript() {
    let copy = copy_historical();
    let verdict = verify_database(&copy).unwrap();
    // Verdict recorded from packages/shared verifyAuditChain on this file: 4,846 events, ok.
    assert_eq!(
        verdict,
        Verdict::Ok {
            event_count: 4846,
            head_hash: "c8dd69fde18793310d9103c2709ef73d6aebc7e23b3d01e48503fbbd1c6829a0".into(),
        }
    );
    fs::remove_dir_all(copy.parent().unwrap()).unwrap();
}

#[test]
fn in_memory_tampering_is_caught_at_the_right_sequence() {
    let copy = copy_historical();
    let rows: Vec<AuditRow> = Store::open_read_only(&copy).unwrap().audit_rows().unwrap();
    let events = events_from_rows(rows).unwrap();
    assert_eq!(events.len(), 4846);
    assert!(matches!(verify_chain(&events).unwrap(), Verdict::Ok { .. }));

    // A changed body breaks the event's own hash.
    let mut body = events.clone();
    body[2000].body = serde_json::json!({ "tampered": true });
    match verify_chain(&body).unwrap() {
        Verdict::Failed { failure, .. } => {
            assert_eq!(failure.reason, "event_hash_mismatch");
            assert_eq!(failure.sequence, events[2000].sequence);
        }
        other => panic!("expected failure, got {other:?}"),
    }

    // A changed link breaks linkage before the hash is checked.
    let mut link = events.clone();
    link[100].previous_hash = "deadbeef".into();
    match verify_chain(&link).unwrap() {
        Verdict::Failed { failure, .. } => {
            assert_eq!(failure.reason, "previous_hash_mismatch");
            assert_eq!(failure.sequence, events[100].sequence);
        }
        other => panic!("expected failure, got {other:?}"),
    }

    // A deleted row shows up as a broken link at the next event.
    let mut gap = events.clone();
    gap.remove(3000);
    match verify_chain(&gap).unwrap() {
        Verdict::Failed {
            failure,
            event_count,
            ..
        } => {
            assert_eq!(failure.reason, "previous_hash_mismatch");
            assert_eq!(failure.sequence, events[3001].sequence);
            assert_eq!(event_count, 4845);
        }
        other => panic!("expected failure, got {other:?}"),
    }
    fs::remove_dir_all(copy.parent().unwrap()).unwrap();
}

#[test]
fn a_stored_payload_that_does_not_parse_is_an_error_not_a_verdict() {
    let row = AuditRow {
        sequence: 7,
        id: "x".into(),
        name: "x".into(),
        time_unix_nano: "1".into(),
        attributes: "{not json".into(),
        body: "{}".into(),
        previous_hash: String::new(),
        event_hash: String::new(),
    };
    assert!(matches!(
        events_from_rows(vec![row]),
        Err(AuditError::MalformedPayload {
            sequence: 7,
            column: "attributes"
        })
    ));
}
