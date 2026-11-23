//! Node-API bridge for `acs-core`. Read-only audit verification only.
//!
//! The TypeScript implementation remains the only authority and the only writer. This addon is
//! consulted only when `ACS_CORE_BACKEND=rust`, and the TypeScript selector fails closed if it is
//! missing or its ABI differs.
#![deny(unsafe_code)]

use std::path::Path;

use acs_core::audit::{AuditError, verify_database};
use napi::{Error, Result, Status};
use napi_derive::napi;

/// ABI version of this bridge. The TypeScript loader rejects any other value.
#[napi]
pub fn core_abi_version() -> u32 {
    1
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

fn category(error: &AuditError) -> &'static str {
    match error {
        AuditError::Store(_) => "store",
        AuditError::MalformedPayload { .. } => "malformed_payload",
        AuditError::Hash(_) => "hash",
    }
}
