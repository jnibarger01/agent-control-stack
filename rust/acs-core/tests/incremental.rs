//! Slice R1c: anchored (incremental) verification. On the tracked historical backup, copied first.
//! Acceptance: whenever the anchored prefix is unchanged the anchored verdict equals the full verdict;
//! a stale anchor or any problem in the tail falls back to the full verdict; the one documented limit
//! (a prefix change that keeps the anchor row) is asserted so it cannot change silently.

use std::fs;
use std::path::{Path, PathBuf};

use acs_core::audit::{Anchor, Verdict, verify_database, verify_database_after};
use acs_core::store::Store;
use rusqlite::Connection;

const HISTORICAL: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../storage/local.db.bak-20261103-182951"
);

struct Copy(PathBuf);
impl Drop for Copy {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(self.0.parent().unwrap());
    }
}

fn copy_historical(tag: &str) -> Copy {
    let dir = std::env::temp_dir().join(format!(
        "acs-core-incremental-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    fs::create_dir_all(&dir).unwrap();
    let copy = dir.join("historical.db");
    fs::copy(HISTORICAL, &copy).unwrap();
    Copy(copy)
}

/// The anchor after the first `count` events.
fn anchor_at(path: &Path, count: usize) -> Anchor {
    let rows = Store::open_read_only(path).unwrap().audit_rows().unwrap();
    let row = &rows[count - 1];
    Anchor {
        event_count: count,
        sequence: row.sequence,
        head_hash: row.event_hash.clone(),
    }
}

fn sequence_at(path: &Path, index: usize) -> i64 {
    Store::open_read_only(path).unwrap().audit_rows().unwrap()[index].sequence
}

fn tamper_body(path: &Path, sequence: i64) {
    let connection = Connection::open(path).unwrap();
    connection
        .execute(
            "UPDATE audit_events SET body = '{\"tampered\":true}' WHERE sequence = ?1",
            [sequence],
        )
        .unwrap();
}

#[test]
fn anchored_verdict_equals_full_verdict_for_unchanged_prefixes() {
    let copy = copy_historical("equal");
    let full = verify_database(&copy.0).unwrap();
    assert!(matches!(
        full,
        Verdict::Ok {
            event_count: 4846,
            ..
        }
    ));
    for count in [1, 2, 100, 2423, 4845, 4846] {
        let anchored = verify_database_after(&copy.0, &anchor_at(&copy.0, count)).unwrap();
        assert_eq!(anchored, full, "anchor after {count} events");
    }
}

#[test]
fn tail_damage_yields_the_full_verdict() {
    let copy = copy_historical("tail");
    let anchor = anchor_at(&copy.0, 4000);
    tamper_body(&copy.0, sequence_at(&copy.0, 4500));
    let full = verify_database(&copy.0).unwrap();
    assert!(matches!(full, Verdict::Failed { .. }), "{full:?}");
    assert_eq!(verify_database_after(&copy.0, &anchor).unwrap(), full);
}

#[test]
fn a_stale_anchor_yields_the_full_verdict() {
    let copy = copy_historical("stale");
    let full = verify_database(&copy.0).unwrap();
    let mut wrong_hash = anchor_at(&copy.0, 3000);
    wrong_hash.head_hash = "0".repeat(64);
    assert_eq!(verify_database_after(&copy.0, &wrong_hash).unwrap(), full);
    let mut wrong_count = anchor_at(&copy.0, 3000);
    wrong_count.event_count += 1;
    assert_eq!(verify_database_after(&copy.0, &wrong_count).unwrap(), full);
    let missing = Anchor {
        event_count: 1,
        sequence: i64::MAX,
        head_hash: String::new(),
    };
    assert_eq!(verify_database_after(&copy.0, &missing).unwrap(), full);
}

#[test]
fn a_tampered_anchor_row_yields_the_full_failed_verdict() {
    let copy = copy_historical("anchor-row");
    let anchor = anchor_at(&copy.0, 3000);
    // Rewriting the anchor row's hash breaks the anchor, so the full verification runs.
    let connection = Connection::open(&copy.0).unwrap();
    connection
        .execute(
            "UPDATE audit_events SET event_hash = ?1 WHERE sequence = ?2",
            rusqlite::params!["1".repeat(64), anchor.sequence],
        )
        .unwrap();
    drop(connection);
    let full = verify_database(&copy.0).unwrap();
    assert!(matches!(full, Verdict::Failed { .. }));
    assert_eq!(verify_database_after(&copy.0, &anchor).unwrap(), full);
}

#[test]
fn documented_limit_prefix_change_behind_an_intact_anchor_is_left_to_the_full_check() {
    let copy = copy_historical("limit");
    let anchor = anchor_at(&copy.0, 3000);
    tamper_body(&copy.0, sequence_at(&copy.0, 10));
    // The full verification (and the authoritative TypeScript one) fails; the anchored one does not
    // look behind the anchor. Callers must keep a full authoritative check.
    assert!(matches!(
        verify_database(&copy.0).unwrap(),
        Verdict::Failed { .. }
    ));
    assert!(matches!(
        verify_database_after(&copy.0, &anchor).unwrap(),
        Verdict::Ok {
            event_count: 4846,
            ..
        }
    ));
}
