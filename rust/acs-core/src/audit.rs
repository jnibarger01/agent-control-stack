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

use crate::legacy::{
    LOCALES, LegacyError, collation_sensitive_locales, legacy_canonical_json_in,
    legacy_stable_hash_in,
};
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

/// `hashes[li][i]`: the recomputed hash of event `i` under collation `li`, or `None` outside the supported
/// domain; `unsupported[i]`: the path reported for an unsupported value.
type HashMatrix = (Vec<Vec<Option<String>>>, Vec<Option<String>>);

/// The reference computation: every event hashed under every collation. Kept to prove `hash_matrix`
/// equal to it; the verifier uses `hash_matrix`.
#[cfg(test)]
fn hash_matrix_reference(events: &[AuditEvent]) -> Result<HashMatrix, LegacyError> {
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
    Ok((hashes, unsupported))
}

/// Same result as `hash_matrix_reference`. An alternate collation is hashed only where it may order some
/// object's keys differently from root (`collation_sensitive_locales`); elsewhere its hash is root's.
/// An event with an unsupported value takes the reference path, so its reported path is unchanged
/// (the last collation that reported one).
fn hash_matrix(events: &[AuditEvent]) -> Result<HashMatrix, LegacyError> {
    let mut hashes: Vec<Vec<Option<String>>> = vec![vec![None; events.len()]; LOCALES.len()];
    let mut unsupported = vec![None; events.len()];
    for (i, event) in events.iter().enumerate() {
        let covered = covered_value(event);
        let root = match legacy_stable_hash_in(&covered, LOCALES[0]) {
            Ok(hash) => hash,
            Err(LegacyError::UnsupportedNumber(_)) => {
                for (li, &locale) in LOCALES.iter().enumerate() {
                    match legacy_stable_hash_in(&covered, locale) {
                        Ok(hash) => hashes[li][i] = Some(hash),
                        Err(LegacyError::UnsupportedNumber(path)) => unsupported[i] = Some(path),
                        Err(other) => return Err(other),
                    }
                }
                continue;
            }
            Err(other) => return Err(other),
        };
        let sensitive = collation_sensitive_locales(&covered)?;
        for (li, &locale) in LOCALES.iter().enumerate().skip(1) {
            hashes[li][i] = Some(if sensitive & (1 << li) != 0 {
                legacy_stable_hash_in(&covered, locale)?
            } else {
                root.clone()
            });
        }
        hashes[0][i] = Some(root);
    }
    Ok((hashes, unsupported))
}

fn reproduce(events: &[AuditEvent]) -> Result<Reproduction, LegacyError> {
    let (hashes, unsupported) = hash_matrix(events)?;
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
    match verify_chain_root_only(events)? {
        Some(verdict) => Ok(verdict),
        None => verify_chain_classified(events),
    }
}

/// The common case without alternate collations. Alternate collations only classify an event whose
/// hash does not reproduce under root, so while every event links and reproduces under root the
/// verdict is the same as `verify_chain_classified`. Returns `None` at the first event that does not
/// reproduce under root (or holds an unsupported value): the caller then runs the full classification
/// over the whole chain, which yields exactly the reference verdict.
fn verify_chain_root_only(events: &[AuditEvent]) -> Result<Option<Verdict>, LegacyError> {
    verify_root_only_from(events, 0, String::new())
}

/// `verify_chain_root_only` over events that continue a prefix of `base_count` events ending in
/// `previous`.
fn verify_root_only_from(
    events: &[AuditEvent],
    base_count: usize,
    mut previous: String,
) -> Result<Option<Verdict>, LegacyError> {
    let event_count = base_count + events.len();
    for event in events {
        if event.previous_hash != previous {
            return Ok(Some(Verdict::Failed {
                event_count,
                head_hash: previous.clone(),
                failure: Failure {
                    sequence: event.sequence,
                    reason: "previous_hash_mismatch",
                    expected: previous,
                    actual: event.previous_hash.clone(),
                },
            }));
        }
        match legacy_stable_hash_in(&covered_value(event), LOCALES[0]) {
            Ok(hash) if hash == event.event_hash => previous = hash,
            Ok(_) | Err(LegacyError::UnsupportedNumber(_)) => return Ok(None),
            Err(other) => return Err(other),
        }
    }
    Ok(Some(Verdict::Ok {
        event_count,
        head_hash: previous,
    }))
}

/// The full verification with locale classification (the reference behavior).
fn verify_chain_classified(events: &[AuditEvent]) -> Result<Verdict, LegacyError> {
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
/// A verified prefix of the chain: its event count, the sequence of its last event and that
/// event's hash.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Anchor {
    pub event_count: usize,
    pub sequence: i64,
    pub head_hash: String,
}

/// Verifies only the events after `anchor`, when the anchor still holds: the database has exactly
/// `event_count` rows through `sequence`, and the row at `sequence` stores `head_hash`. Returns the
/// same verdict as `verify_database` whenever the anchored prefix is unchanged. Otherwise, and at
/// any linkage or hash problem in the tail, it runs the full verification, so a non-`Ok` verdict
/// is always the full reference verdict. A change inside the prefix that keeps the anchor row is not
/// detected here; the authoritative TypeScript verification reads the whole chain.
pub fn verify_database_after(path: &Path, anchor: &Anchor) -> Result<Verdict, AuditError> {
    let store = Store::open_read_only(path)?;
    let (count, hash) = store.audit_prefix(anchor.sequence)?;
    let anchored = usize::try_from(count).ok() == Some(anchor.event_count)
        && hash.as_deref() == Some(anchor.head_hash.as_str());
    if anchored {
        let tail = events_from_rows(store.audit_rows_after(anchor.sequence)?)?;
        if let Some(verdict @ Verdict::Ok { .. }) =
            verify_root_only_from(&tail, anchor.event_count, anchor.head_hash.clone())?
        {
            return Ok(verdict);
        }
    }
    let events = events_from_rows(store.audit_rows()?)?;
    Ok(verify_chain(&events)?)
}

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

#[cfg(test)]
mod hash_matrix_equivalence {
    //! Slice R1b acceptance: the fast hash matrix equals the reference on every input, including keys
    //! whose order differs between the tested collations, ties, array-index keys and unsupported values.

    use super::{
        AuditEvent, Verdict, covered_value, hash_matrix, hash_matrix_reference, verify_chain,
        verify_chain_classified,
    };
    use crate::legacy::{LOCALES, legacy_stable_hash_in};
    use serde_json::{Map, Value, json};

    /// Keys that reorder under at least one of tr, sv, da, lt, hu, plus ties and array indices.
    const KEYS: &[&str] = &[
        "I", "i", "ı", "İ", "Ia", "ia", "aa", "å", "ab", "ä", "ae", "z", "zz", "ö", "o", "oz", "w",
        "v", "vb", "wa", "cs", "c", "cz", "d", "dz", "dzs", "gy", "g", "y", "j", "ch", "h", "0",
        "1", "10", "2", "01", "_", "-", "A", "a", "a ", "ǅ", "ß", "ss",
    ];

    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> u64 {
            self.0 = self
                .0
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            self.0 >> 33
        }
        fn below(&mut self, n: u64) -> usize {
            usize::try_from(self.next() % n).unwrap_or(0)
        }
    }

    fn value(rng: &mut Lcg, depth: u32) -> Value {
        match rng.below(if depth >= 3 { 4 } else { 7 }) {
            0 => Value::from(rng.below(1000) as i64 - 500),
            1 => Value::from(KEYS[rng.below(KEYS.len() as u64)]),
            2 => Value::Bool(rng.below(2) == 0),
            3 if rng.below(40) == 0 => json!(1.5),
            3 => Value::Null,
            4 | 5 => {
                let mut members = Map::new();
                for _ in 0..rng.below(7) {
                    members.insert(
                        KEYS[rng.below(KEYS.len() as u64)].to_owned(),
                        value(rng, depth + 1),
                    );
                }
                Value::Object(members)
            }
            _ => Value::Array((0..rng.below(4)).map(|_| value(rng, depth + 1)).collect()),
        }
    }

    fn event(sequence: i64, attributes: Value, body: Value) -> AuditEvent {
        AuditEvent {
            sequence,
            id: format!("evt-{sequence}"),
            name: "fixture.r1b".into(),
            time_unix_nano: "1790000000000000000".into(),
            attributes,
            body,
            previous_hash: String::new(),
            event_hash: String::new(),
        }
    }

    #[test]
    fn equals_reference_on_generated_collation_sensitive_events() {
        let mut rng = Lcg(0x5eed_acc0_2026_1122);
        let events: Vec<AuditEvent> = (0..3000)
            .map(|sequence| event(sequence, value(&mut rng, 0), value(&mut rng, 0)))
            .collect();
        let fast = hash_matrix(&events).expect("fast matrix");
        let reference = hash_matrix_reference(&events).expect("reference matrix");
        assert_eq!(fast, reference);
        // The corpus must actually exercise collation-sensitive and unsupported records.
        let differing = (0..events.len())
            .filter(|&i| (1..reference.0.len()).any(|li| reference.0[li][i] != reference.0[0][i]))
            .count();
        let unsupported = reference.1.iter().filter(|path| path.is_some()).count();
        assert!(
            differing > 100,
            "only {differing} collation-sensitive events"
        );
        assert!(unsupported > 10, "only {unsupported} unsupported events");
    }

    #[test]
    fn equals_reference_on_the_locale_fixtures() {
        let text = include_str!("../tests/fixtures/locale-chains.json");
        let fixtures: Value = serde_json::from_str(text).expect("fixtures parse");
        let events: Vec<AuditEvent> = fixtures["events"]
            .as_object()
            .expect("events object")
            .values()
            .map(|fixture| AuditEvent {
                sequence: fixture["sequence"].as_i64().unwrap_or(0),
                id: fixture["id"].as_str().unwrap_or_default().to_owned(),
                name: fixture["name"].as_str().unwrap_or_default().to_owned(),
                time_unix_nano: fixture["timeUnixNano"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned(),
                attributes: fixture["attributes"].clone(),
                body: fixture["body"].clone(),
                previous_hash: fixture["previousHash"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned(),
                event_hash: fixture["eventHash"].as_str().unwrap_or_default().to_owned(),
            })
            .collect();
        assert!(events.len() >= 4);
        assert_eq!(
            hash_matrix(&events).expect("fast"),
            hash_matrix_reference(&events).expect("reference")
        );
    }

    /// A correctly linked chain whose hashes are written under `writer` collation for each event.
    fn chain(rng: &mut Lcg, len: i64, writer: impl Fn(i64) -> &'static str) -> Vec<AuditEvent> {
        let mut previous = String::new();
        let mut events = Vec::new();
        for sequence in 1..=len {
            let mut event = event(sequence, value(rng, 0), value(rng, 0));
            event.previous_hash = previous.clone();
            event.event_hash = legacy_stable_hash_in(&covered_value(&event), writer(sequence))
                .unwrap_or_else(|_| "unsupported".to_owned());
            previous = event.event_hash.clone();
            events.push(event);
        }
        events
    }

    #[test]
    fn fast_verdict_equals_classified_verdict_on_valid_and_damaged_chains() {
        let mut rng = Lcg(0x00c0_ffee_2026_1122);
        let mut kinds = std::collections::BTreeMap::<&'static str, usize>::new();
        for round in 0..400 {
            let len = 1 + i64::try_from(rng.below(25)).unwrap_or(0);
            let mut events = chain(&mut rng, len, |_| LOCALES[0]);
            let k = rng.below(events.len() as u64);
            match round % 7 {
                0 => {}
                1 => events[k].body = json!({ "tampered": round }),
                2 => events[k].event_hash = "0".repeat(64),
                3 => events[k].previous_hash = "f".repeat(64),
                4 => events[k].attributes = json!({ "ratio": 0.25 }),
                5 => {
                    // One event written under an alternate collation, re-linked after it.
                    let locale = LOCALES[1 + rng.below(LOCALES.len() as u64 - 1)];
                    if let Ok(hash) = legacy_stable_hash_in(&covered_value(&events[k]), locale) {
                        events[k].event_hash = hash;
                    }
                    for i in k + 1..events.len() {
                        events[i].previous_hash = events[i - 1].event_hash.clone();
                        if let Ok(hash) =
                            legacy_stable_hash_in(&covered_value(&events[i]), LOCALES[0])
                        {
                            events[i].event_hash = hash;
                        }
                    }
                }
                _ => {
                    events = chain(&mut rng, len, |sequence| {
                        LOCALES[usize::try_from(sequence).unwrap_or(0) % LOCALES.len()]
                    })
                }
            }
            let fast = verify_chain(&events).expect("fast verdict");
            let classified = verify_chain_classified(&events).expect("classified verdict");
            assert_eq!(fast, classified, "round {round}");
            *kinds
                .entry(match fast {
                    Verdict::Ok { .. } => "ok",
                    Verdict::Failed { .. } => "failed",
                    Verdict::Indeterminate { .. } => "indeterminate",
                })
                .or_default() += 1;
        }
        // Every verdict kind must be exercised, so equality is not vacuous.
        for kind in ["ok", "failed", "indeterminate"] {
            assert!(
                kinds.get(kind).copied().unwrap_or(0) >= 10,
                "{kind}: {kinds:?}"
            );
        }
    }
}
