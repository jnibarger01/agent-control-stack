use acs_core::canonical::{
    CanonicalError, PREFIX, canonical_json_v2, domain_hash_v2, stable_hash_v2,
};
use serde_json::{Value, json};

const GOLDEN: &str = include_str!("../../../contracts/canonical-hash/v2.golden.json");

#[test]
fn replays_the_shared_golden_fixtures_byte_for_byte() {
    let golden: Value = serde_json::from_str(GOLDEN).expect("golden file is JSON");
    assert_eq!(golden["schema"], "acs.canonical-hash.golden.v2");
    assert_eq!(golden["prefix"], PREFIX);
    let cases = golden["cases"].as_array().expect("cases");
    assert!(cases.len() >= 17, "golden corpus shrank");
    for case in cases {
        let id = case["id"].as_str().unwrap();
        let input = &case["input"];
        assert_eq!(
            canonical_json_v2(input).unwrap(),
            case["canonical"].as_str().unwrap(),
            "canonical text for {id}"
        );
        let digest = match case.get("domain").and_then(Value::as_str) {
            Some(domain) => domain_hash_v2(domain, input).unwrap(),
            None => stable_hash_v2(input).unwrap(),
        };
        assert_eq!(digest, case["sha256"].as_str().unwrap(), "digest for {id}");
    }
}

#[test]
fn non_ascii_keys_follow_code_point_order() {
    let value = json!({ "\u{1F600}": 2, "\u{E000}": 1, "z": 3 });
    assert_eq!(
        canonical_json_v2(&value).unwrap(),
        "{\"z\":3,\"\u{E000}\":1,\"\u{1F600}\":2}"
    );
}

#[test]
fn rejects_non_integers_and_unsafe_integers() {
    assert!(matches!(
        canonical_json_v2(&json!(1.5)),
        Err(CanonicalError::UnsafeNumber(_))
    ));
    assert!(matches!(
        canonical_json_v2(&json!({ "a": [1e300] })),
        Err(CanonicalError::UnsafeNumber(path)) if path == "$.a[0]"
    ));
    assert!(canonical_json_v2(&json!(9_007_199_254_740_992_i64)).is_err());
    assert!(canonical_json_v2(&json!(-9_007_199_254_740_992_i64)).is_err());
    assert!(canonical_json_v2(&json!(9_007_199_254_740_992.0)).is_err());
}

#[test]
fn integral_floats_encode_as_integers_like_javascript_values() {
    assert_eq!(canonical_json_v2(&json!(1.0)).unwrap(), "1");
    assert_eq!(canonical_json_v2(&json!(-0.0)).unwrap(), "0");
    assert_eq!(canonical_json_v2(&json!(2e3)).unwrap(), "2000");
}

#[test]
fn lone_surrogates_cannot_reach_the_encoder() {
    // A Rust String is well-formed by construction, and serde_json rejects the escape on parse.
    assert!(serde_json::from_str::<Value>("\"\\ud800\"").is_err());
}

#[test]
fn rejects_domains_outside_the_identifier_grammar() {
    let too_long = "a".repeat(129);
    for bad in [
        "",
        " leading",
        "-leading",
        "has space",
        "bad/slash",
        too_long.as_str(),
    ] {
        assert_eq!(
            domain_hash_v2(bad, &json!({})),
            Err(CanonicalError::InvalidDomain),
            "domain {bad:?}"
        );
    }
    assert!(domain_hash_v2("a".repeat(128).as_str(), &json!({})).is_ok());
}

#[test]
fn v1_and_v2_digests_never_collide_for_the_empty_object() {
    // v1 hashes "{}" with no prefix. v2 hashes the prefix first.
    assert_ne!(
        stable_hash_v2(&json!({})).unwrap(),
        "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a"
    );
}
