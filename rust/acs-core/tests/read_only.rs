//! Read-only guarantees for the store and verifier.

use std::fs;
use std::path::{Path, PathBuf};

use acs_core::store::Store;
use rusqlite::{Connection, OpenFlags};

const SRC: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/src");

fn scratch(name: &str) -> PathBuf {
    let unique = format!(
        "acs-core-{name}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let dir = std::env::temp_dir().join(unique);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn collect_sources(dir: &Path, out: &mut Vec<(PathBuf, String)>) {
    for entry in fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            collect_sources(&path, out);
        } else if path.extension().is_some_and(|ext| ext == "rs") {
            out.push((path.clone(), fs::read_to_string(&path).unwrap()));
        }
    }
}

#[test]
fn the_crate_source_contains_no_write_statements_or_execute_calls() {
    let mut sources = Vec::new();
    collect_sources(Path::new(SRC), &mut sources);
    assert!(!sources.is_empty());
    // Keywords that begin a mutating statement, plus the rusqlite call that runs arbitrary SQL.
    let forbidden = [
        "INSERT ",
        "UPDATE ",
        "DELETE ",
        "DROP ",
        "ALTER ",
        "CREATE ",
        "REPLACE ",
        "execute(",
        "execute_batch(",
        "transaction(",
    ];
    for (path, text) in &sources {
        for word in forbidden {
            assert!(
                !text.contains(word),
                "{} contains forbidden write construct {word:?}",
                path.display()
            );
        }
    }
}

#[test]
fn opening_a_missing_database_does_not_create_it() {
    let dir = scratch("missing");
    let path = dir.join("absent.db");
    assert!(Store::open_read_only(&path).is_err());
    assert!(
        !path.exists(),
        "read-only open must not create a database file"
    );
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn read_only_connections_reject_writes_at_the_engine() {
    // Confirms the engine-level guarantee the store relies on: SQLITE_OPEN_READ_ONLY refuses writes.
    let dir = scratch("engine");
    let path = dir.join("probe.db");
    Connection::open(&path)
        .unwrap()
        .execute_batch("CREATE TABLE probe (id INTEGER); INSERT INTO probe VALUES (1);")
        .unwrap();
    let readonly = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
    let refused = readonly.execute("INSERT INTO probe VALUES (2)", []);
    assert!(refused.is_err(), "a read-only connection accepted a write");
    fs::remove_dir_all(dir).unwrap();
}
