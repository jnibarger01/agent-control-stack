//! Read-only audit chain verifier. Prints one JSON verdict on stdout.
//!
//! Usage: acs-audit-verify [--immutable] <path-to-sqlite-file>
//!
//! Default: `SQLITE_OPEN_READ_ONLY`. For a WAL database this creates an empty `-wal` and a `-shm`
//! beside the file if they are absent. `--immutable` opens with `immutable=1`: no sidecars, no
//! locks. Use it only for files that no other process can write.
//!
//! Exit 0: a verdict was produced (ok, failed or indeterminate). Exit 1: the database could not be
//! verified. Exit 2: bad usage.

use std::path::Path;
use std::process::ExitCode;

use acs_core::audit::{AuditError, OpenMode, verify_database_with};
use serde_json::json;

fn main() -> ExitCode {
    let mut mode = OpenMode::ReadOnly;
    let mut paths = Vec::new();
    for argument in std::env::args().skip(1) {
        if argument == "--immutable" {
            mode = OpenMode::Immutable;
        } else {
            paths.push(argument);
        }
    }
    let [path] = paths.as_slice() else {
        eprintln!("usage: acs-audit-verify [--immutable] <sqlite-file>");
        return ExitCode::from(2);
    };
    match verify_database_with(Path::new(path), mode) {
        Ok(verdict) => {
            println!("{}", verdict.to_json());
            ExitCode::SUCCESS
        }
        Err(error) => {
            // Print the category only. Paths and payload text stay out of the output.
            let category = match error {
                AuditError::Store(acs_core::store::StoreError::UncheckpointedWal) => {
                    "uncheckpointed_wal"
                }
                AuditError::Store(_) => "store",
                AuditError::MalformedPayload { .. } => "malformed_payload",
                AuditError::Hash(_) => "hash",
            };
            println!("{}", json!({ "error": category }));
            ExitCode::from(1)
        }
    }
}
