//! Legacy canonical JSON (v1) and its SHA-256, reproducing `canonicalJson` / `stableHash` in
//! `packages/shared/src/hash.ts` byte for byte. It exists only to verify records already written
//! with v1. New hashing uses v2 (`canonical`). v1 is not changed.
//!
//! Reproduced v1 behavior:
//! - Object keys sort with `String.prototype.localeCompare` under the writer's collation. The
//!   default is the root collation (`und`). ICU4X at tertiary strength, non-ignorable alternates,
//!   matches it on the differential corpora recorded in `docs/migrations/canonical-hash.md`, for
//!   root and for each locale in `LOCALES`. The sort is stable, so ties keep JSON insertion order.
//! - Then `JSON.stringify` of the rebuilt object emits array-index keys ("0".."4294967294") first,
//!   in ascending numeric order, regardless of the sort. The other keys keep sorted order.
//! - Only safe integers are supported. Floats and larger integers are rejected as
//!   `UnsupportedNumber`. Their formatting would need the ECMAScript number algorithm, and the
//!   verifier reports such records as unsupported rather than as corrupt.

use std::cmp::Ordering;
use std::sync::OnceLock;

use icu_collator::options::{AlternateHandling, CollatorOptions, Strength};
use icu_collator::{CollatorBorrowed, CollatorPreferences};
use icu_locale_core::Locale;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::canonical::{MAX_SAFE_INTEGER, quote};

/// Collation tags supported by the verifier. Index 0 is the root collation, the default.
pub const LOCALES: [&str; 6] = ["und", "tr", "sv", "da", "lt", "hu"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LegacyError {
    /// A number outside the supported integer domain. Carries a path.
    UnsupportedNumber(String),
    /// A collation tag not in `LOCALES`.
    UnknownLocale(String),
    /// The collator could not be constructed. Should be unreachable with compiled data.
    Collator,
}

impl std::fmt::Display for LegacyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnsupportedNumber(path) => write!(
                f,
                "legacy canonical JSON cannot encode the number at {path}"
            ),
            Self::UnknownLocale(tag) => write!(f, "unsupported collation tag {tag}"),
            Self::Collator => f.write_str("collator unavailable"),
        }
    }
}

impl std::error::Error for LegacyError {}

fn collator(tag: &str) -> Result<&'static CollatorBorrowed<'static>, LegacyError> {
    static CACHE: [OnceLock<Option<CollatorBorrowed<'static>>>; LOCALES.len()] =
        [const { OnceLock::new() }; LOCALES.len()];
    let index = LOCALES
        .iter()
        .position(|&known| known == tag)
        .ok_or_else(|| LegacyError::UnknownLocale(tag.to_owned()))?;
    CACHE[index]
        .get_or_init(|| {
            let locale: Locale = LOCALES[index].parse().ok()?;
            let mut options = CollatorOptions::default();
            options.strength = Some(Strength::Tertiary);
            options.alternate_handling = Some(AlternateHandling::NonIgnorable);
            CollatorBorrowed::try_new(CollatorPreferences::from(&locale), options).ok()
        })
        .as_ref()
        .ok_or(LegacyError::Collator)
}

/// `canonicalJson` (v1) under the root collation.
pub fn legacy_canonical_json(value: &Value) -> Result<String, LegacyError> {
    legacy_canonical_json_in(value, "und")
}

/// `canonicalJson` (v1) under the collation identified by `tag` (one of `LOCALES`).
pub fn legacy_canonical_json_in(value: &Value, tag: &str) -> Result<String, LegacyError> {
    let mut out = String::new();
    encode(value, &JsonPath::Root, collator(tag)?, &mut out)?;
    Ok(out)
}

/// `stableHash` (v1) under the root collation: SHA-256 hex of the canonical text, no prefix.
pub fn legacy_stable_hash(value: &Value) -> Result<String, LegacyError> {
    legacy_stable_hash_in(value, "und")
}

/// `stableHash` (v1) under the collation identified by `tag`.
pub fn legacy_stable_hash_in(value: &Value, tag: &str) -> Result<String, LegacyError> {
    let canonical = legacy_canonical_json_in(value, tag)?;
    Ok(hex(&Sha256::digest(canonical.as_bytes())))
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut text = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        text.push(DIGITS[usize::from(byte >> 4)] as char);
        text.push(DIGITS[usize::from(byte & 0x0f)] as char);
    }
    text
}

/// Bit `li` (for `li` in `1..LOCALES.len()`) is set when some object in `value` may order its keys
/// differently under `LOCALES[li]` than under root. An unset bit is exact: that collation produces the
/// same v1 canonical text as root, so the same hash. A set bit may be a false positive (root ties, or an
/// alternate tie or reversal), which only means the caller computes that collation in full.
///
/// Why an unset bit is exact: the root stable sort yields keys k1..kn. If root and the alternate both
/// compare every adjacent pair as strictly `Less`, the order is strictly increasing under the
/// alternate, so its stable sort of any insertion order yields the same k1..kn. The later array-index
/// partition depends only on that order and the keys, so the emitted text is identical.
pub fn collation_sensitive_locales(value: &Value) -> Result<u32, LegacyError> {
    let root = collator(LOCALES[0])?;
    let mut alternates = Vec::with_capacity(LOCALES.len() - 1);
    for &tag in &LOCALES[1..] {
        alternates.push(collator(tag)?);
    }
    let all: u32 = ((1u32 << LOCALES.len()) - 1) & !1;
    let mut mask = 0u32;
    sensitivity(value, root, &alternates, all, &mut mask);
    Ok(mask)
}

fn sensitivity(
    value: &Value,
    root: &CollatorBorrowed<'_>,
    alternates: &[&CollatorBorrowed<'_>],
    all: u32,
    mask: &mut u32,
) {
    if *mask == all {
        return;
    }
    match value {
        Value::Array(items) => {
            for item in items {
                sensitivity(item, root, alternates, all, mask);
            }
        }
        Value::Object(members) => {
            if members.len() > 1 {
                let mut keys: Vec<&String> = members.keys().collect();
                keys.sort_by(|left, right| root.compare(left, right));
                let root_strict = keys
                    .windows(2)
                    .all(|pair| root.compare(pair[0], pair[1]) == Ordering::Less);
                for (offset, alternate) in alternates.iter().enumerate() {
                    let bit = 1u32 << (offset + 1);
                    if *mask & bit != 0 {
                        continue;
                    }
                    if !root_strict
                        || !keys
                            .windows(2)
                            .all(|pair| alternate.compare(pair[0], pair[1]) == Ordering::Less)
                    {
                        *mask |= bit;
                    }
                }
            }
            for member in members.values() {
                sensitivity(member, root, alternates, all, mask);
            }
        }
        _ => {}
    }
}

/// The JSON path of the value being encoded, rendered only when an error needs it.
enum JsonPath<'a> {
    Root,
    Index(&'a JsonPath<'a>, usize),
    Key(&'a JsonPath<'a>, &'a str),
}

impl JsonPath<'_> {
    fn render(&self) -> String {
        match self {
            Self::Root => "$".to_owned(),
            Self::Index(parent, index) => format!("{}[{index}]", parent.render()),
            Self::Key(parent, key) => format!("{}.{key}", parent.render()),
        }
    }
}

fn encode(
    value: &Value,
    path: &JsonPath<'_>,
    collator: &CollatorBorrowed<'_>,
    out: &mut String,
) -> Result<(), LegacyError> {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::String(text) => quote(text, out),
        Value::Number(number) => out.push_str(&integer_text(number, path)?),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                encode(item, &JsonPath::Index(path, index), collator, out)?;
            }
            out.push(']');
        }
        Value::Object(members) => {
            // Insertion order is the JSON document order (serde_json `preserve_order`).
            let mut entries: Vec<(&String, &Value)> = members.iter().collect();
            // Stable sort, as V8's Array.prototype.sort is, so ties keep insertion order.
            entries.sort_by(|(left, _), (right, _)| collator.compare(left, right));
            // JSON.stringify emits array-index keys first, in ascending numeric order.
            let (mut indices, others): (Vec<_>, Vec<_>) = entries
                .into_iter()
                .partition(|(key, _)| array_index(key).is_some());
            indices.sort_by_key(|(key, _)| array_index(key));
            out.push('{');
            for (position, (key, member)) in indices.into_iter().chain(others).enumerate() {
                if position > 0 {
                    out.push(',');
                }
                quote(key, out);
                out.push(':');
                encode(member, &JsonPath::Key(path, key), collator, out)?;
            }
            out.push('}');
        }
    }
    Ok(())
}

/// The canonical array-index form: no leading zeros, at most 4294967294.
fn array_index(key: &str) -> Option<u32> {
    if key.is_empty()
        || (key.len() > 1 && key.starts_with('0'))
        || !key.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    key.parse::<u32>().ok().filter(|&index| index < u32::MAX)
}

fn integer_text(number: &serde_json::Number, path: &JsonPath<'_>) -> Result<String, LegacyError> {
    match number.as_i64() {
        Some(integer) if integer.unsigned_abs() <= MAX_SAFE_INTEGER as u64 => {
            Ok(integer.to_string())
        }
        _ => Err(LegacyError::UnsupportedNumber(path.render())),
    }
}
