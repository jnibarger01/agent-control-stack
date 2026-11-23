//! Read-only execution attempts (Phase 1, slice P1.2). Reproduces `rowToExecutionAttempt` in
//! `packages/work-items/src/store.ts` and the strict `executionAttemptSchema`:
//!
//! - the stored columns `cancellation_requested_at`, `terminal_at`, `outcome_code` and `recovery_reason` are not part
//!   of the attempt view and are never emitted;
//! - `claimedByWorkerId` and `startedAt` are omitted only when NULL (an empty string is kept, then rejected);
//! - identifiers, hashes, timestamps, the protocol literal, the status enum and integer bounds are validated with the
//!   exact Zod ports in `zod`.

use serde_json::{Map, Value};

use crate::store::{AttemptRow, Store, StoreError};
use crate::zod::{is_hash, is_identifier, is_timestamp};

pub const WORKER_PROTOCOL_VERSION: &str = "acs.worker.v2";

const STATUSES: &[&str] = &[
    "pending",
    "leased",
    "running",
    "cancellation_requested",
    "interrupted",
    "succeeded",
    "failed",
    "cancelled",
    "unknown",
    "quarantined",
];

#[derive(Debug)]
pub enum AttemptError {
    Store(StoreError),
    Invalid(&'static str),
}

impl std::fmt::Display for AttemptError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Store(error) => write!(f, "attempt store error: {error}"),
            Self::Invalid(field) => write!(f, "attempt row is invalid at {field}"),
        }
    }
}

impl std::error::Error for AttemptError {}

impl From<StoreError> for AttemptError {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}

fn checked(ok: bool, field: &'static str, value: &str) -> Result<Value, AttemptError> {
    if ok {
        Ok(Value::String(value.to_owned()))
    } else {
        Err(AttemptError::Invalid(field))
    }
}

/// The attempt for one row, in TypeScript's shape and key order.
pub fn attempt_from_row(row: &AttemptRow) -> Result<Value, AttemptError> {
    let mut out = Map::new();
    out.insert(
        "attemptId".into(),
        checked(is_identifier(&row.attempt_id), "attemptId", &row.attempt_id)?,
    );
    out.insert(
        "workItemId".into(),
        checked(
            is_identifier(&row.work_item_id),
            "workItemId",
            &row.work_item_id,
        )?,
    );
    out.insert(
        "planId".into(),
        checked(is_identifier(&row.plan_id), "planId", &row.plan_id)?,
    );
    out.insert(
        "planHash".into(),
        checked(is_hash(&row.plan_hash), "planHash", &row.plan_hash)?,
    );
    if row.attempt_number < 1 {
        return Err(AttemptError::Invalid("attemptNumber"));
    }
    out.insert("attemptNumber".into(), Value::from(row.attempt_number));
    out.insert(
        "protocolVersion".into(),
        checked(
            row.protocol_version == WORKER_PROTOCOL_VERSION,
            "protocolVersion",
            &row.protocol_version,
        )?,
    );
    out.insert(
        "inputHash".into(),
        checked(is_hash(&row.input_hash), "inputHash", &row.input_hash)?,
    );
    out.insert(
        "status".into(),
        checked(
            STATUSES.contains(&row.status.as_str()),
            "status",
            &row.status,
        )?,
    );
    if row.current_fencing_epoch < 0 {
        return Err(AttemptError::Invalid("currentFencingEpoch"));
    }
    out.insert(
        "currentFencingEpoch".into(),
        Value::from(row.current_fencing_epoch),
    );
    if let Some(worker) = &row.claimed_by_worker_id {
        out.insert(
            "claimedByWorkerId".into(),
            checked(is_identifier(worker), "claimedByWorkerId", worker)?,
        );
    }
    if let Some(started) = &row.started_at {
        out.insert(
            "startedAt".into(),
            checked(is_timestamp(started), "startedAt", started)?,
        );
    }
    out.insert(
        "createdAt".into(),
        checked(is_timestamp(&row.created_at), "createdAt", &row.created_at)?,
    );
    out.insert(
        "updatedAt".into(),
        checked(is_timestamp(&row.updated_at), "updatedAt", &row.updated_at)?,
    );
    Ok(Value::Object(out))
}

/// `getAttempt(attemptId)`: the attempt, or `None` when no row has that id.
pub fn read_attempt(store: &Store, attempt_id: &str) -> Result<Option<Value>, AttemptError> {
    match store.attempt_row(attempt_id)? {
        Some(row) => Ok(Some(attempt_from_row(&row)?)),
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::attempt_from_row;
    use crate::store::AttemptRow;

    fn row() -> AttemptRow {
        AttemptRow {
            attempt_id: "attempt_1".into(),
            work_item_id: "wrk_1".into(),
            plan_id: "plan_1".into(),
            plan_hash: "a".repeat(64),
            attempt_number: 1,
            protocol_version: "acs.worker.v2".into(),
            input_hash: "b".repeat(64),
            status: "running".into(),
            current_fencing_epoch: 2,
            claimed_by_worker_id: Some("worker-1".into()),
            started_at: Some("2026-11-23T08:30:26.123Z".into()),
            created_at: "2026-11-23T08:30:26Z".into(),
            updated_at: "2026-11-23T08:30:26+05:30".into(),
        }
    }

    #[test]
    fn emits_the_view_fields_in_schema_order() {
        let text = attempt_from_row(&row()).expect("valid").to_string();
        assert!(
            text.starts_with(r#"{"attemptId":"attempt_1","workItemId":"wrk_1","planId":"plan_1""#)
        );
        assert!(text.ends_with(r#""claimedByWorkerId":"worker-1","startedAt":"2026-11-23T08:30:26.123Z","createdAt":"2026-11-23T08:30:26Z","updatedAt":"2026-11-23T08:30:26+05:30"}"#));
    }

    #[test]
    fn omits_null_optionals_but_rejects_empty_ones() {
        let mut nulls = row();
        nulls.claimed_by_worker_id = None;
        nulls.started_at = None;
        let text = attempt_from_row(&nulls).expect("valid").to_string();
        assert!(!text.contains("claimedByWorkerId") && !text.contains("startedAt"));
        let mut empty = row();
        empty.claimed_by_worker_id = Some(String::new());
        assert!(attempt_from_row(&empty).is_err());
    }

    #[test]
    fn rejects_values_the_strict_schema_rejects() {
        for mutate in [
            (|r: &mut AttemptRow| r.protocol_version = "acs.worker.v1".into())
                as fn(&mut AttemptRow),
            |r| r.attempt_number = 0,
            |r| r.current_fencing_epoch = -1,
            |r| r.input_hash = "A".repeat(64),
            |r| r.status = "exploded".into(),
            |r| r.created_at = "2026-02-29T00:00:00Z".into(),
            |r| r.updated_at = "2026-11-23T08:30:26+0530".into(),
        ] {
            let mut bad = row();
            mutate(&mut bad);
            assert!(attempt_from_row(&bad).is_err());
        }
    }
}
