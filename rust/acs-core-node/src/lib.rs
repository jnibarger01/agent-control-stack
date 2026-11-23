//! Node-API bridge for `acs-core`. Read-only audit verification only.
//!
//! The TypeScript implementation remains the only authority and the only writer. This addon is
//! consulted only when `ACS_CORE_BACKEND=rust`, and the TypeScript selector fails closed if it is
//! missing or its ABI differs.
#![deny(unsafe_code)]

use std::path::Path;

use acs_core::audit::{Anchor, AuditError, verify_database, verify_database_after};
use napi::{Error, Result, Status};
use napi_derive::napi;

/// ABI version of this bridge. The TypeScript loader rejects any other value.
#[napi]
pub fn core_abi_version() -> u32 {
    2
}

/// Verifies the audit chain of a SQLite file, read-only. Returns the verdict as JSON text in the
/// same shape as `AuditChainVerification`. On failure, throws with a category code only.
#[napi]
pub fn verify_audit_database(path: String) -> Result<String> {
    match verify_database(Path::new(&path)) {
        Ok(verdict) => Ok(verdict.to_json().to_string()),
        Err(error) => Err(Error::new(Status::GenericFailure, category(&error))),
    }
}

/// Verifies only the events after a previously verified anchor; see `verify_database_after`. A
/// stale anchor or any problem falls back to the full verification. Same JSON shape and errors as
/// `verify_audit_database`.
#[napi]
pub fn verify_audit_database_after(
    path: String,
    anchor_event_count: i64,
    anchor_sequence: i64,
    anchor_head_hash: String,
) -> Result<String> {
    let event_count = usize::try_from(anchor_event_count)
        .map_err(|_| Error::new(Status::InvalidArg, "anchor"))?;
    let anchor = Anchor {
        event_count,
        sequence: anchor_sequence,
        head_hash: anchor_head_hash,
    };
    match verify_database_after(Path::new(&path), &anchor) {
        Ok(verdict) => Ok(verdict.to_json().to_string()),
        Err(error) => Err(Error::new(Status::GenericFailure, category(&error))),
    }
}

fn category(error: &AuditError) -> &'static str {
    match error {
        AuditError::Store(_) => "store",
        AuditError::MalformedPayload { .. } => "malformed_payload",
        AuditError::Hash(_) => "hash",
    }
}
