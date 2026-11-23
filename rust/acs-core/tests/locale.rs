//! Locale classification of legacy audit records. Oracles are `tests/fixtures/locale-chains.json`,
//! hashed by the TypeScript `auditEventHash` under each named process locale.

use acs_core::audit::{AuditEvent, Indeterminate, Verdict, verify_chain};
use acs_core::legacy::{legacy_canonical_json_in, legacy_stable_hash_in};
use serde_json::{Value, json};

const FIXTURES: &str = include_str!("fixtures/locale-chains.json");

fn fixture(name: &str) -> AuditEvent {
    let all: Value = serde_json::from_str(FIXTURES).unwrap();
    let event = &all["events"][name];
    assert!(event.is_object(), "missing fixture {name}");
    AuditEvent {
        sequence: event["sequence"].as_i64().unwrap(),
        id: event["id"].as_str().unwrap().into(),
        name: event["name"].as_str().unwrap().into(),
        time_unix_nano: event["timeUnixNano"].as_str().unwrap().into(),
        attributes: event["attributes"].clone(),
        body: event["body"].clone(),
        previous_hash: event["previousHash"].as_str().unwrap().into(),
        event_hash: event["eventHash"].as_str().unwrap().into(),
    }
}

#[test]
fn root_writer_verifies_as_ok() {
    assert!(matches!(
        verify_chain(&[fixture("en.trWriter")]).unwrap(),
        Verdict::Ok { event_count: 1, .. }
    ));
}

#[test]
fn turkish_writer_is_locale_dependent_not_corrupt() {
    // Root verification disagrees with the stored hash, and the tr collation reproduces it exactly.
    match verify_chain(&[fixture("tr.trWriter")]).unwrap() {
        Verdict::Indeterminate {
            reason: Indeterminate::LocaleDependent { locale },
            ..
        } => assert_eq!(locale, "tr"),
        other => panic!("expected locale-dependent indeterminate, got {other:?}"),
    }
}

#[test]
fn swedish_writer_is_locale_dependent_not_corrupt() {
    match verify_chain(&[fixture("sv.svWriter")]).unwrap() {
        Verdict::Indeterminate {
            reason: Indeterminate::LocaleDependent { locale },
            ..
        } => assert_eq!(locale, "sv"),
        other => panic!("expected locale-dependent indeterminate, got {other:?}"),
    }
}

#[test]
fn locale_invariant_record_with_a_corrupt_hash_is_failed() {
    let mut event = fixture("en.invariant");
    event.event_hash = "0".repeat(64);
    match verify_chain(&[event]).unwrap() {
        Verdict::Failed { failure, .. } => assert_eq!(failure.reason, "event_hash_mismatch"),
        other => panic!("expected corruption, got {other:?}"),
    }
}

#[test]
fn locale_sensitive_record_with_a_corrupt_hash_is_indeterminate() {
    // Keys I and i order differently under tr, so the canonical text depends on the collation.
    // A corrupt hash cannot be told apart from an untested writer locale, so no claim is made.
    let mut event = fixture("en.trWriter");
    event.event_hash = "0".repeat(64);
    match verify_chain(&[event]).unwrap() {
        Verdict::Indeterminate {
            reason: Indeterminate::LocaleSensitiveMismatch,
            ..
        } => {}
        other => panic!("expected locale-sensitive indeterminate, got {other:?}"),
    }
}

#[test]
fn a_float_is_unsupported_canonicalization_not_corruption() {
    match verify_chain(&[fixture("en.floatWriter")]).unwrap() {
        Verdict::Indeterminate {
            reason: Indeterminate::UnsupportedCanonicalization { path },
            ..
        } => assert_eq!(path, "$.attributes.f"),
        other => panic!("expected unsupported indeterminate, got {other:?}"),
    }
}

#[test]
fn linkage_breaks_are_decisive_regardless_of_locale() {
    // Linkage compares stored hashes only. A broken link is corruption whatever the collation.
    let mut broken = fixture("tr.trWriter");
    broken.previous_hash = "not-the-head".into();
    assert!(matches!(
        verify_chain(&[broken]).unwrap(),
        Verdict::Failed { failure, .. } if failure.reason == "previous_hash_mismatch"
    ));
}

#[test]
fn collation_tags_reproduce_the_typescript_orders() {
    // From hash.ts under LANG=tr_TR and LANG=sv_SE. Root is shown for contrast.
    let tr_key = json!({ "I": 1, "i": 2 });
    assert_eq!(
        legacy_canonical_json_in(&tr_key, "tr").unwrap(),
        r#"{"I":1,"i":2}"#
    );
    assert_eq!(
        legacy_canonical_json_in(&tr_key, "und").unwrap(),
        r#"{"i":2,"I":1}"#
    );
    let sv_key = json!({ "ä": 1, "z": 2 });
    assert_eq!(
        legacy_canonical_json_in(&sv_key, "sv").unwrap(),
        r#"{"z":2,"ä":1}"#
    );
    assert_eq!(
        legacy_stable_hash_in(&sv_key, "sv").unwrap(),
        "896b8dd27b9b539d56c30c96acce8910a2293d7bef3fc3ef87195bc2eb778073"
    );
}
