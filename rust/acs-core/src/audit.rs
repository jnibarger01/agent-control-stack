//! Audit hash-chain verification. Mirrors `verifyAuditChain` and `auditEventHash` in
//! `packages/shared/src/audit-chain.ts`, using the legacy v1 hash the chain was written with.
//!
//! Verdicts are three-state. `Ok` and `Failed` match the TypeScript shape exactly. `Indeterminate`
//! is returned where the stored data cannot establish corruption or success, because the record's
//! canonicalization is locale-dependent or outside the supported legacy domain. A record that
//! matches no tested collation, and whose canonical text is the same under every tested collation,
//! is `Failed`. Linkage checks use stored hashes only, so they are always decisive.

use std::path::Path;

use serde_json::{Map, Number, Value, json};

use crate::legacy::{LOCALES, LegacyError, legacy_canonical_json_in, legacy_stable_hash_in};
use crate::store::{AuditRow, Store, StoreError};

#[derive(Debug, Clone, PartialEq)]
pub struct AuditEvent {
    pub sequence: i64,
    pub id: String,
    pub name: String,
    pub time_unix_nano: String,
    pub attributes: Value,
    pub body: Value,
    pub previous_hash: String,
    pub event_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failure {
    pub sequence: i64,
    pub reason: &'static str,
    pub expected: String,
    pub actual: String,
}

/// Why a verdict is indeterminate. None of these asserts corruption or success.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Indeterminate {
    /// The record matches under a different collation. The writer's locale is the likely cause.
    LocaleDependent { locale: &'static str },
    /// No tested collation matches, and the canonical text differs across collations. A writer
    /// locale outside the tested set could explain the mismatch.
    LocaleSensitiveMismatch,
    /// The record holds a value outside the supported legacy domain, such as a float.
    UnsupportedCanonicalization { path: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    Ok {
        event_count: usize,
        head_hash: String,
    },
    Failed {
        event_count: usize,
        head_hash: String,
        failure: Failure,
    },
    Indeterminate {
        event_count: usize,
        head_hash: String,
        sequence: i64,
        reason: Indeterminate,
    },
}

impl Verdict {
    /// Ok and Failed use the TypeScript `AuditChainVerification` shape. Indeterminate sets `ok` to
    /// null and adds an `indeterminate` object, so no consumer can read it as a clean pass.
    pub fn to_json(&self) -> Value {
        match self {
            Self::Ok {
                event_count,
                head_hash,
            } => json!({ "ok": true, "eventCount": event_count, "headHash": head_hash }),
            Self::Failed {
                event_count,
                head_hash,
                failure,
            } => json!({
                "ok": false,
                "eventCount": event_count,
                "headHash": head_hash,
                "failure": {
                    "sequence": failure.sequence,
                    "reason": failure.reason,
                    "expected": failure.expected,
                    "actual": failure.actual
                }
            }),
            Self::Indeterminate {
                event_count,
                head_hash,
                sequence,
                reason,
            } => {
                let detail = match reason {
                    Indeterminate::LocaleDependent { locale } => {
                        json!({ "sequence": sequence, "reason": "locale_dependent", "locale": locale })
                    }
                    Indeterminate::LocaleSensitiveMismatch => {
                        json!({ "sequence": sequence, "reason": "locale_sensitive_mismatch" })
                    }
                    Indeterminate::UnsupportedCanonicalization { path } => {
                        json!({ "sequence": sequence, "reason": "unsupported_canonicalization", "path": path })
                    }
                };
                json!({
                    "ok": null,
                    "eventCount": event_count,
                    "headHash": head_hash,
                    "indeterminate": detail
                })
            }
        }
    }
}

#[derive(Debug)]
pub enum AuditError {
    Store(StoreError),
    /// A stored JSON column does not parse. TypeScript throws here too.
    MalformedPayload {
        sequence: i64,
        column: &'static str,
    },
    Hash(LegacyError),
}

impl std::fmt::Display for AuditError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Store(error) => write!(f, "{error}"),
            Self::MalformedPayload { sequence, column } => {
                write!(f, "malformed {column} at sequence {sequence}")
            }
            Self::Hash(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for AuditError {}

impl From<StoreError> for AuditError {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}

impl From<LegacyError> for AuditError {
    fn from(error: LegacyError) -> Self {
        Self::Hash(error)
    }
}

/// The seven fields `auditEventHash` covers, as the object `stableHash` receives.
fn covered_value(event: &AuditEvent) -> Value {
    let mut covered = Map::new();
    covered.insert(
        "sequence".into(),
        Value::Number(Number::from(event.sequence)),
    );
    covered.insert("id".into(), Value::String(event.id.clone()));
    covered.insert("name".into(), Value::String(event.name.clone()));
    covered.insert(
        "timeUnixNano".into(),
        Value::String(event.time_unix_nano.clone()),
    );
    covered.insert("attributes".into(), event.attributes.clone());
    covered.insert("body".into(), event.body.clone());
    covered.insert(
        "previousHash".into(),
        Value::String(event.previous_hash.clone()),
    );
    Value::Object(covered)
}

/// `auditEventHash` under the root collation.
pub fn audit_event_hash(event: &AuditEvent) -> Result<String, LegacyError> {
    legacy_stable_hash_in(&covered_value(event), "und")
}

/// Per-event reproduction data, computed once for the whole chain.
struct Reproduction {
    /// `reproduced[locale_index][event_index]`: the stored hash is reproduced under that collation.
    reproduced: Vec<Vec<bool>>,
    /// Set where the record holds a value outside the supported legacy domain.
    unsupported: Vec<Option<String>>,
    /// Whether the chain as a whole is reproduced under root and not under any alternate.
    root_writer_supported: bool,
}

fn reproduce(events: &[AuditEvent]) -> Result<Reproduction, LegacyError> {
    // hashes[li][i]: the recomputed hash under collation li, or None outside the supported domain.
    let mut hashes: Vec<Vec<Option<String>>> = vec![vec![None; events.len()]; LOCALES.len()];
    let mut unsupported = vec![None; events.len()];
    for (li, &locale) in LOCALES.iter().enumerate() {
        for (i, event) in events.iter().enumerate() {
            match legacy_stable_hash_in(&covered_value(event), locale) {
                Ok(hash) => hashes[li][i] = Some(hash),
                Err(LegacyError::UnsupportedNumber(path)) => unsupported[i] = Some(path),
                Err(other) => return Err(other),
            }
        }
    }
    let reproduced: Vec<Vec<bool>> = hashes
        .iter()
        .map(|column| {
            column
                .iter()
                .zip(events)
                .map(|(hash, event)| hash.as_deref() == Some(event.event_hash.as_str()))
                .collect()
        })
        .collect();

    // Writer evidence. Only records where an alternate collation disagrees with root can tell
    // them apart. Root is supported as the writer when, on those records, it reproduces at least
    // as many as each alternate, and reproduces at least one.
    let mut root_hits = 0usize;
    let mut supported = true;
    for li in 1..LOCALES.len() {
        let (mut root_only, mut alternate_only) = (0usize, 0usize);
        for i in 0..events.len() {
            let (Some(root), Some(alternate)) = (&hashes[0][i], &hashes[li][i]) else {
                continue;
            };
            if root == alternate {
                continue;
            }
            if reproduced[0][i] {
                root_only += 1;
            }
            if reproduced[li][i] {
                alternate_only += 1;
            }
        }
        root_hits += root_only;
        if alternate_only > root_only {
            supported = false;
        }
    }
    Ok(Reproduction {
        reproduced,
        unsupported,
        root_writer_supported: supported && root_hits >= 1,
    })
}

/// `verifyAuditChain` with locale classification, in sequence order. Linkage is checked before the
/// hash, as in TypeScript. A linkage break is always `Failed`.
///
/// A record whose hash does not reproduce under root is classified in this order:
/// 1. unsupported value: `Indeterminate`;
/// 2. reproduced under an alternate collation: `Indeterminate`, locale-dependent;
/// 3. not reproduced by any tested collation: `Failed` when the chain is supported as root-written
///    (root reproduces more records than any alternate) or when the record's canonical text is the
///    same under every tested collation. Otherwise `Indeterminate`.
pub fn verify_chain(events: &[AuditEvent]) -> Result<Verdict, LegacyError> {
    let event_count = events.len();
    let reproduction = reproduce(events)?;
    let mut previous = String::new();
    for (i, event) in events.iter().enumerate() {
        if event.previous_hash != previous {
            return Ok(Verdict::Failed {
                event_count,
                head_hash: previous.clone(),
                failure: Failure {
                    sequence: event.sequence,
                    reason: "previous_hash_mismatch",
                    expected: previous,
                    actual: event.previous_hash.clone(),
                },
            });
        }
        if reproduction.reproduced[0][i] {
            previous = event.event_hash.clone();
            continue;
        }
        if let Some(path) = &reproduction.unsupported[i] {
            return Ok(Verdict::Indeterminate {
                event_count,
                head_hash: previous,
                sequence: event.sequence,
                reason: Indeterminate::UnsupportedCanonicalization { path: path.clone() },
            });
        }
        if let Some(li) = (1..LOCALES.len()).find(|&li| reproduction.reproduced[li][i]) {
            return Ok(Verdict::Indeterminate {
                event_count,
                head_hash: previous,
                sequence: event.sequence,
                reason: Indeterminate::LocaleDependent {
                    locale: LOCALES[li],
                },
            });
        }
        let covered = covered_value(event);
        let root_text = legacy_canonical_json_in(&covered, LOCALES[0])?;
        let mut text_invariant = true;
        for &locale in LOCALES.iter().skip(1) {
            if legacy_canonical_json_in(&covered, locale)? != root_text {
                text_invariant = false;
                break;
            }
        }
        if reproduction.root_writer_supported || text_invariant {
            return Ok(Verdict::Failed {
                event_count,
                head_hash: previous.clone(),
                failure: Failure {
                    sequence: event.sequence,
                    reason: "event_hash_mismatch",
                    expected: legacy_stable_hash_in(&covered, LOCALES[0])?,
                    actual: event.event_hash.clone(),
                },
            });
        }
        return Ok(Verdict::Indeterminate {
            event_count,
            head_hash: previous,
            sequence: event.sequence,
            reason: Indeterminate::LocaleSensitiveMismatch,
        });
    }
    Ok(Verdict::Ok {
        event_count,
        head_hash: previous,
    })
}

/// Parses stored rows into events. A JSON column that does not parse is an error, as in TypeScript.
pub fn events_from_rows(rows: Vec<AuditRow>) -> Result<Vec<AuditEvent>, AuditError> {
    rows.into_iter()
        .map(|row| {
            let attributes = serde_json::from_str(&row.attributes).map_err(|_| {
                AuditError::MalformedPayload {
                    sequence: row.sequence,
                    column: "attributes",
                }
            })?;
            let body =
                serde_json::from_str(&row.body).map_err(|_| AuditError::MalformedPayload {
                    sequence: row.sequence,
                    column: "body",
                })?;
            Ok(AuditEvent {
                sequence: row.sequence,
                id: row.id,
                name: row.name,
                time_unix_nano: row.time_unix_nano,
                attributes,
                body,
                previous_hash: row.previous_hash,
                event_hash: row.event_hash,
            })
        })
        .collect()
}

/// How the database file is opened. See `store.rs` for the filesystem effects of each mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenMode {
    /// `SQLITE_OPEN_READ_ONLY`. Creates an empty `-wal` and a `-shm` beside a WAL database.
    ReadOnly,
    /// `immutable=1`. No sidecars and no locks. Only for files no other process can write.
    Immutable,
}

/// Read-only verification of an entire database file.
pub fn verify_database(path: &Path) -> Result<Verdict, AuditError> {
    verify_database_with(path, OpenMode::ReadOnly)
}

/// Read-only verification of an entire database file in the given open mode.
pub fn verify_database_with(path: &Path, mode: OpenMode) -> Result<Verdict, AuditError> {
    let store = match mode {
        OpenMode::ReadOnly => Store::open_read_only(path)?,
        OpenMode::Immutable => Store::open_immutable(path)?,
    };
    let events = events_from_rows(store.audit_rows()?)?;
    Ok(verify_chain(&events)?)
}
