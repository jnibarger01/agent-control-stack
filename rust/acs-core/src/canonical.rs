//! Canonical JSON v2 and its SHA-256 digests. Mirrors `packages/shared/src/hash.ts` (v2 section).
//!
//! Rules (docs/migrations/canonical-hash.md):
//! - Keys are ordered by Unicode code point. UTF-8 byte order is code point order, so
//!   `String` ordering is exact. Never locale-dependent.
//! - Safe integers only, |n| <= 2^53 - 1. Integral floats such as `1.0` encode as integers,
//!   matching JavaScript value semantics. Other numbers are rejected.
//! - Strings use the ECMAScript JSON quoting rules. Lone surrogates cannot occur in a Rust
//!   `String`, and `serde_json` rejects them on parse, so they never reach the encoder.
//! - Digest input is `PREFIX` followed by the canonical text (plus `domain\n` for domain hashes).

use std::fmt::Write as _;

use serde_json::Value;
use sha2::{Digest, Sha256};

/// Versioned prefix hashed before the canonical JSON. Matches `CANONICAL_V2_PREFIX` in TypeScript.
pub const PREFIX: &str = "acs-canonical-json/v2\n";

/// Largest integer JavaScript represents exactly: 2^53 - 1.
pub const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CanonicalError {
    /// A number is not a safe integer. Carries a JSON-pointer-like path.
    UnsafeNumber(String),
    /// A domain hash domain is outside the bounded identifier grammar.
    InvalidDomain,
}

impl std::fmt::Display for CanonicalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnsafeNumber(path) => {
                write!(f, "canonical v2 accepts only safe integers at {path}")
            }
            Self::InvalidDomain => {
                f.write_str("hash domain must be a bounded non-empty identifier")
            }
        }
    }
}

impl std::error::Error for CanonicalError {}

/// Canonical JSON v2 text for `value`.
pub fn canonical_json_v2(value: &Value) -> Result<String, CanonicalError> {
    let mut out = String::new();
    encode(value, "$", &mut out)?;
    Ok(out)
}

/// SHA-256 hex of `PREFIX + canonical_json_v2(value)`.
pub fn stable_hash_v2(value: &Value) -> Result<String, CanonicalError> {
    let canonical = canonical_json_v2(value)?;
    Ok(hex_digest(&format!("{PREFIX}{canonical}")))
}

/// SHA-256 hex of `PREFIX + domain + "\n" + canonical_json_v2(value)`.
pub fn domain_hash_v2(domain: &str, value: &Value) -> Result<String, CanonicalError> {
    if !valid_domain(domain) {
        return Err(CanonicalError::InvalidDomain);
    }
    let canonical = canonical_json_v2(value)?;
    Ok(hex_digest(&format!("{PREFIX}{domain}\n{canonical}")))
}

/// Matches `/^[a-z0-9][a-z0-9:._-]{0,127}$/i` in TypeScript.
fn valid_domain(domain: &str) -> bool {
    let bytes = domain.as_bytes();
    (1..=128).contains(&bytes.len())
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b':' | b'.' | b'_' | b'-'))
}

fn hex_digest(text: &str) -> String {
    let digest = Sha256::digest(text.as_bytes());
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        // Writing into a String cannot fail.
        let _ = write!(out, "{byte:02x}");
    }
    out
}

fn encode(value: &Value, path: &str, out: &mut String) -> Result<(), CanonicalError> {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::String(text) => quote(text, out),
        Value::Number(number) => out.push_str(&encode_number(number, path)?),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                encode(item, &format!("{path}[{index}]"), out)?;
            }
            out.push(']');
        }
        Value::Object(members) => {
            // BTreeMap-backed `Map` keys and `String` ordering both use UTF-8 bytes, which is
            // code point order. Sort explicitly so the rule does not depend on the map backend.
            let mut keys: Vec<&String> = members.keys().collect();
            keys.sort_unstable();
            out.push('{');
            for (index, key) in keys.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                quote(key, out);
                out.push(':');
                encode(&members[*key], &format!("{path}.{key}"), out)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

fn encode_number(number: &serde_json::Number, path: &str) -> Result<String, CanonicalError> {
    let unsafe_number = || CanonicalError::UnsafeNumber(path.to_owned());
    if let Some(integer) = number.as_i64() {
        return if integer.unsigned_abs() <= MAX_SAFE_INTEGER as u64 {
            Ok(integer.to_string())
        } else {
            Err(unsafe_number())
        };
    }
    // Integral floats in the safe range encode as integers. Everything else is rejected.
    match number.as_f64() {
        Some(float)
            if float.is_finite()
                && float.fract() == 0.0
                && float.abs() <= MAX_SAFE_INTEGER as f64 =>
        {
            Ok((float as i64).to_string())
        }
        _ => Err(unsafe_number()),
    }
}

/// ECMAScript QuoteJSONString for well-formed text. Lowercase hex for control escapes.
pub(crate) fn quote(text: &str, out: &mut String) {
    out.push('"');
    for character in text.chars() {
        match character {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            '\u{0c}' => out.push_str("\\f"),
            '\r' => out.push_str("\\r"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}
