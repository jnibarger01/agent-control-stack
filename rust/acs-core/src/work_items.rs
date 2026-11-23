//! Read-only work items (Phase 1, slice P1.1). Reproduces `rowToWorkItem` in
//! `packages/work-items/src/store.ts`, including the normalization `workItemSchema.parse` applies:
//!
//! - fields TypeScript omits when falsy are omitted (`requesterSubject`, `result`, `metadata`,
//!   `sourceWorkItemId`, `lineageType`, `retryReason`, `rootWorkItemId`, and `retrySequence` when 0);
//! - `target` keeps only `repo`, `cwd`, `files`, `services` (unknown keys are dropped);
//! - each requested action keeps only `kind`, `description`, `params`, and `params` defaults to `{}`;
//! - `metadata` is strict: an unknown key is an error, as in TypeScript;
//! - enum, non-empty and length constraints are checked; lengths count Unicode code points, as
//!   Zod 4's `min`/`max` do (verified: 1,001 emoji pass `max(2000)`, 2,000 decomposed "é" fail);
//! - output keys follow the schema's key order, so the JSON text matches TypeScript's.
//!
//! A row TypeScript would reject is an error here, never a partially read item.

use serde_json::{Map, Value};

use crate::store::{Store, StoreError, WorkItemRow};

#[derive(Debug)]
pub enum WorkItemError {
    Store(StoreError),
    /// The row does not satisfy the work-item schema. Carries the field path.
    Invalid(String),
}

impl std::fmt::Display for WorkItemError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Store(error) => write!(f, "work item store error: {error}"),
            Self::Invalid(path) => write!(f, "work item row is invalid at {path}"),
        }
    }
}

impl std::error::Error for WorkItemError {}

impl From<StoreError> for WorkItemError {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}

const REQUESTERS: &[&str] = &["user", "agent", "system"];
const RISKS: &[&str] = &["low", "medium", "high", "critical"];
const STATUSES: &[&str] = &[
    "draft",
    "pending_policy",
    "needs_approval",
    "approved",
    "running",
    "cancelling",
    "succeeded",
    "failed",
    "blocked",
    "cancelled",
    "rejected",
    "unknown",
    "quarantined",
];
const LINEAGE_TYPES: &[&str] = &["retry", "clone"];

fn invalid(path: &str) -> WorkItemError {
    WorkItemError::Invalid(path.to_owned())
}

/// String length as Zod 4 measures it for `min`/`max`: Unicode code points.
fn zod_len(text: &str) -> usize {
    text.chars().count()
}

fn non_empty(text: &str, path: &str) -> Result<Value, WorkItemError> {
    if text.is_empty() {
        return Err(invalid(path));
    }
    Ok(Value::String(text.to_owned()))
}

fn one_of(text: &str, allowed: &[&str], path: &str) -> Result<Value, WorkItemError> {
    if allowed.contains(&text) {
        Ok(Value::String(text.to_owned()))
    } else {
        Err(invalid(path))
    }
}

fn parse_json(text: &str, path: &str) -> Result<Value, WorkItemError> {
    serde_json::from_str(text).map_err(|_| invalid(path))
}

/// `z.string().min(1)` arrays.
fn string_array(value: &Value, path: &str) -> Result<Value, WorkItemError> {
    let items = value.as_array().ok_or_else(|| invalid(path))?;
    for item in items {
        match item.as_str() {
            Some(text) if !text.is_empty() => {}
            _ => return Err(invalid(path)),
        }
    }
    Ok(value.clone())
}

/// `targetSchema`: an object with optional `repo`, `cwd` (non-empty strings) and `files`,
/// `services` (arrays of non-empty strings). Other keys are dropped.
fn target(value: Value) -> Result<Value, WorkItemError> {
    let members = value.as_object().ok_or_else(|| invalid("target"))?;
    let mut out = Map::new();
    for key in ["repo", "cwd"] {
        if let Some(field) = members.get(key) {
            let text = field
                .as_str()
                .ok_or_else(|| invalid(&format!("target.{key}")))?;
            out.insert(key.to_owned(), non_empty(text, &format!("target.{key}"))?);
        }
    }
    for key in ["files", "services"] {
        if let Some(field) = members.get(key) {
            out.insert(
                key.to_owned(),
                string_array(field, &format!("target.{key}"))?,
            );
        }
    }
    Ok(Value::Object(out))
}

/// `z.array(actionRequestSchema)`: `kind`, `description` non-empty strings, `params` a record
/// (default `{}`). Other keys are dropped.
fn requested_actions(value: Value) -> Result<Value, WorkItemError> {
    let items = value
        .as_array()
        .ok_or_else(|| invalid("requestedActions"))?;
    let mut out = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        let path = format!("requestedActions[{index}]");
        let members = item.as_object().ok_or_else(|| invalid(&path))?;
        let mut action = Map::new();
        for key in ["kind", "description"] {
            let text = members
                .get(key)
                .and_then(Value::as_str)
                .ok_or_else(|| invalid(&format!("{path}.{key}")))?;
            action.insert(key.to_owned(), non_empty(text, &format!("{path}.{key}"))?);
        }
        let params = match members.get("params") {
            None => Value::Object(Map::new()),
            Some(params @ Value::Object(_)) => params.clone(),
            Some(_) => return Err(invalid(&format!("{path}.params"))),
        };
        action.insert("params".to_owned(), params);
        out.push(Value::Object(action));
    }
    Ok(Value::Array(out))
}

/// `workItemMetadataSchema` (strict).
fn metadata(value: Value) -> Result<Value, WorkItemError> {
    let members = value.as_object().ok_or_else(|| invalid("metadata"))?;
    let mut out = Map::new();
    for key in members.keys() {
        if key != "webhookSource" && key != "correlationId" {
            return Err(invalid(&format!("metadata.{key}")));
        }
    }
    if let Some(field) = members.get("webhookSource") {
        let text = field
            .as_str()
            .ok_or_else(|| invalid("metadata.webhookSource"))?;
        let valid = (1..=64).contains(&text.len())
            && text
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
        if !valid {
            return Err(invalid("metadata.webhookSource"));
        }
        out.insert("webhookSource".to_owned(), field.clone());
    }
    if let Some(field) = members.get("correlationId") {
        let text = field
            .as_str()
            .ok_or_else(|| invalid("metadata.correlationId"))?;
        if !(1..=512).contains(&zod_len(text)) {
            return Err(invalid("metadata.correlationId"));
        }
        out.insert("correlationId".to_owned(), field.clone());
    }
    Ok(Value::Object(out))
}

/// Truthiness of an optional TEXT column, as `row.x ? ... : {}` sees it.
fn present(text: &Option<String>) -> Option<&str> {
    text.as_deref().filter(|value| !value.is_empty())
}

/// The work item for one row, in TypeScript's shape and key order.
pub fn work_item_from_row(row: &WorkItemRow) -> Result<Value, WorkItemError> {
    let mut out = Map::new();
    out.insert("title".into(), non_empty(&row.title, "title")?);
    out.insert(
        "requester".into(),
        one_of(&row.requester, REQUESTERS, "requester")?,
    );
    if let Some(subject) = present(&row.requester_subject) {
        out.insert(
            "requesterSubject".into(),
            non_empty(subject, "requesterSubject")?,
        );
    }
    out.insert("status".into(), one_of(&row.status, STATUSES, "status")?);
    out.insert("intent".into(), non_empty(&row.intent, "intent")?);
    out.insert(
        "target".into(),
        target(parse_json(&row.target_json, "target")?)?,
    );
    out.insert(
        "requestedActions".into(),
        requested_actions(parse_json(&row.requested_actions_json, "requestedActions")?)?,
    );
    out.insert("risk".into(), one_of(&row.risk, RISKS, "risk")?);
    if let Some(text) = present(&row.metadata_json) {
        out.insert("metadata".into(), metadata(parse_json(text, "metadata")?)?);
    }
    out.insert("id".into(), non_empty(&row.id, "id")?);
    if let Some(text) = present(&row.result_json) {
        let result = parse_json(text, "result")?;
        if !result.is_object() {
            return Err(invalid("result"));
        }
        out.insert("result".into(), result);
    }
    if let Some(source) = present(&row.source_work_item_id) {
        out.insert("sourceWorkItemId".into(), Value::String(source.to_owned()));
    }
    if let Some(lineage) = present(&row.lineage_type) {
        out.insert(
            "lineageType".into(),
            one_of(lineage, LINEAGE_TYPES, "lineageType")?,
        );
    }
    if let Some(reason) = present(&row.retry_reason) {
        if zod_len(reason) > 2_000 {
            return Err(invalid("retryReason"));
        }
        out.insert("retryReason".into(), Value::String(reason.to_owned()));
    }
    match row.retry_sequence {
        Some(sequence) if sequence < 0 => return Err(invalid("retrySequence")),
        Some(sequence) if sequence > 0 => {
            out.insert("retrySequence".into(), Value::from(sequence));
        }
        _ => {}
    }
    if let Some(root) = present(&row.root_work_item_id) {
        out.insert("rootWorkItemId".into(), Value::String(root.to_owned()));
    }
    out.insert("createdAt".into(), non_empty(&row.created_at, "createdAt")?);
    out.insert("updatedAt".into(), non_empty(&row.updated_at, "updatedAt")?);
    Ok(Value::Object(out))
}

/// `get(id)`: the work item, or `None` when no row has that id.
pub fn read_work_item(store: &Store, id: &str) -> Result<Option<Value>, WorkItemError> {
    match store.work_item_row(id)? {
        Some(row) => Ok(Some(work_item_from_row(&row)?)),
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::{WorkItemError, work_item_from_row};
    use crate::store::WorkItemRow;

    fn row() -> WorkItemRow {
        WorkItemRow {
            id: "wrk_1".into(),
            title: "t".into(),
            requester: "user".into(),
            requester_subject: None,
            status: "pending_policy".into(),
            intent: "i".into(),
            target_json: r#"{"services":["s"],"cwd":"/r","extra":1}"#.into(),
            requested_actions_json: r#"[{"description":"d","kind":"k","extra":true}]"#.into(),
            risk: "low".into(),
            result_json: None,
            metadata_json: None,
            source_work_item_id: None,
            lineage_type: None,
            retry_reason: None,
            retry_sequence: Some(0),
            root_work_item_id: None,
            created_at: "c".into(),
            updated_at: "u".into(),
        }
    }

    #[test]
    fn keeps_schema_key_order_drops_unknown_keys_and_defaults_params() {
        let item = work_item_from_row(&row()).expect("valid row");
        assert_eq!(
            item.to_string(),
            r#"{"title":"t","requester":"user","status":"pending_policy","intent":"i","target":{"cwd":"/r","services":["s"]},"requestedActions":[{"kind":"k","description":"d","params":{}}],"risk":"low","id":"wrk_1","createdAt":"c","updatedAt":"u"}"#
        );
    }

    #[test]
    fn rejects_unknown_metadata_keys_like_the_strict_schema() {
        let mut bad = row();
        bad.metadata_json = Some(r#"{"correlationId":"c","sneaky":1}"#.into());
        assert!(
            matches!(work_item_from_row(&bad), Err(WorkItemError::Invalid(path)) if path == "metadata.sneaky")
        );
    }

    #[test]
    fn counts_retry_reason_length_in_code_points() {
        let mut ok = row();
        ok.lineage_type = Some("retry".into());
        ok.source_work_item_id = Some("wrk_0".into());
        ok.retry_reason = Some("\u{1F600}".repeat(1001));
        assert!(work_item_from_row(&ok).is_ok());
        let mut too_long = ok.clone();
        too_long.retry_reason = Some("e\u{301}".repeat(1001));
        assert!(work_item_from_row(&too_long).is_err());
    }
}
