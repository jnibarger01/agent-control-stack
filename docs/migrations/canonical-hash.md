# Canonical hashing: v1 behavior and the v2 form

Status: v2 implemented in TypeScript (`packages/shared/src/hash.ts`) and Rust (`rust/acs-core`), verified by the shared golden corpus `contracts/canonical-hash/v2.golden.json`. v1 is unchanged and remains the form used by every existing hash and by the audit chain.

## B1. What v1 does today

`canonicalJson` in `packages/shared/src/hash.ts`:

1. Sorts object keys with `String.prototype.localeCompare`, the process's default ICU collation.
2. Rebuilds each object with `Object.fromEntries` and serializes it with `JSON.stringify`.
3. Maps array `undefined` entries to `null` and drops object members whose value is `undefined`.

`stableHash` is SHA-256 of that text. `domainHash` is SHA-256 of `domain + "\n" + text`. The audit chain's `auditEventHash` is `stableHash` over seven fields.

Measured on Node 24.16.0 with probe scripts run during this change (the probes are not committed; the rows are reproducible by importing `packages/shared/src/hash.ts`):

| Input | v1 result | Why it matters |
| --- | --- | --- |
| Keys `ä` and `z` | `en_US` and `C.UTF-8` order `ä` before `z`. `sv_SE` orders `z` before `ä`. | The same object hashes differently by host locale. The same hash on another host then fails verification. |
| Integer-like keys `"10"`, `"9"`, `"2"` | Emitted as `{"2":…,"9":…,"10":…}`. | The engine emits array-index keys numerically, overriding the sort. |
| Canonically equivalent keys `"é"` and `"é"` | Output follows insertion order. Different insertion orders give different hashes. | The sort is stable and these keys compare equal, so the result depends on how the object was built. |
| `NaN`, `Infinity` | `null`. | Silent data loss. |
| `-0` | `0`. | Acceptable, but not stated anywhere. |
| `1.5e-7`, `1e21` | `1.5e-7`, `1e+21`. | Depends on the ECMAScript number algorithm. |
| `9007199254740993` | Hashes as `9007199254740992`. | Precision is lost before hashing. |
| `Date` | `{}`. Every date hashes the same. | `Object.entries` drops the time value. |
| `BigInt` | Throws `TypeError`. | Fail-closed by accident. |
| Lone surrogate `"\uD800"` | `"\ud800"` escape. | Hashed, but not representable in Rust `String`. |

The ledger (`docs/migrations/rust-migration-ledger.md`) records the locale risk. Today the existing audit chain was written and verifies under the root collation. The probe `tr_TR` case shows the risk is real for other locales.

The historical audit chain (`storage/local.db.bak-20261103-182951`, 4,846 events) contains 163 distinct nested keys. Every one has mixed case, underscores or dots, so v1 ICU order matters for verification. It contains no floats, no unsafe integers, and no lone surrogates.

## B2. The v2 canonical form

`stableHashV2(value)` = SHA-256 hex of `PREFIX + canonicalJsonV2(value)`, where `PREFIX` is the ASCII bytes `acs-canonical-json/v2` followed by one LF.

`domainHashV2(domain, value)` = SHA-256 hex of `PREFIX + domain + "\n" + canonicalJsonV2(value)`, with the same domain grammar as v1: `^[a-z0-9][a-z0-9:._-]{0,127}$`, case-insensitive.

`canonicalJsonV2` rules:

- **Keys** are ordered by Unicode code point, not UTF-16 unit order and not locale. The two differ above U+FFFF. Keys must be well-formed Unicode.
- **Strings** use the ECMAScript JSON quoting rules: `"` and `\` are escaped, control characters U+0000 to U+001F use `\b \t \n \f \r` or `\u00xx` in lowercase hex, and everything else (including U+007F and U+2028) is emitted as UTF-8. Lone surrogates are rejected.
- **Numbers** must be safe integers, |n| ≤ 2^53 − 1. `-0` encodes as `0`. Non-integers, `NaN`, `±Infinity`, and larger integers throw. Nothing is silently rounded or converted to `null`.
- **Arrays** keep order. `undefined` entries become `null`, as in v1.
- **Objects** must be plain objects (prototype `Object.prototype` or `null`). Members whose value is `undefined` are omitted, as in v1.
- **Other types** (`bigint`, `symbol`, functions, `Date`, `Map`, class instances, top-level `undefined`) throw `TypeError`.

Output has no whitespace. Commas and colons are the only separators.

v1 is not changed. Existing digests are unchanged. The versioned prefix guarantees a v2 digest never equals a v1 digest for the same value. Callers are not migrated by this change. Moving a v1 record to v2 requires a migration that recomputes and re-anchors the chain, which is a separate, approved slice.

### Verification

- `contracts/canonical-hash/v2.golden.json`: 17 cases (empty and scalar values, ASCII case and punctuation, integer-like keys, non-ASCII and supplementary keys, escapes, numeric edge cases, nested structures, two domain-separated cases). Each has the canonical text and the SHA-256.
- TypeScript: `packages/shared/src/canonical-hash-v2.test.ts` replays every case, checks the locale-independence property in a child process under `sv_SE`, checks that v1 does differ there (so the test is not vacuous), checks every rejection class, and pins a v1 regression digest.
- Rust: `rust/acs-core/tests/canonical.rs` replays every case byte for byte.
- Independent check: `sha256sum` of `acs-canonical-json/v2\n{}` gives `9ed9eb3a…`, matching the golden digest of `{}`.
- Mutation: changing the Rust key sort to UTF-16 order fails the golden replay in both tests.

## Legacy v1 verification in Rust

The Rust audit verifier must reproduce v1, because the existing chain was written with it. `rust/acs-core/src/legacy.rs` does that:

- Key order is ICU root collation, tertiary strength, non-ignorable alternates. ICU4X (`icu_collator` 2.4.0) was compared with V8 `localeCompare` on 33,203 pairs: the real historical key pairs plus 20,000 random mixed-case, punctuation and Unicode pairs. There were zero mismatches.
- Ties keep JSON insertion order. Requires serde_json `preserve_order`.
- Array-index keys come first, in numeric order.
- Non-integers, unsafe integers and `undefined` are not encoded. Floats and unsafe integers are reported as `indeterminate` with reason `unsupported_canonicalization`, which is neither corruption nor success. No historical payload contains one.

### Three-state verdicts (R1.1)

A mismatch under root collation is not automatically corruption. Locale-dependent sorting means a record written under another collation can fail the root check while being intact. The verifier therefore returns one of three outcomes:

- **`ok`**: every record reproduces under root. Same shape as TypeScript.
- **`failed`** (`event_hash_mismatch` or `previous_hash_mismatch`): corruption is claimed. Linkage breaks are always decisive. A hash mismatch is claimed only when no tested collation reproduces the stored hash, and either:
  - the chain as a whole is root-written (root reproduces at least one record whose text differs under an alternate collation, and no alternate reproduces more such records), or
  - the record's canonical text is identical under every tested collation.
- **`indeterminate`** (`ok` is `null`): the record is reproduced by a tested alternate collation (`locale_dependent`), or no tested collation reproduces it while the chain's writer is undetermined (`locale_sensitive_mismatch`), or the record is outside the supported domain (`unsupported_canonicalization`).

The tested set is `und, tr, sv, da, lt, hu`. Each was differentially checked against V8 `localeCompare` under the matching `LANG`, with zero mismatches. A writer locale outside this set can still produce a `failed` verdict. This is the residual risk, and it is stated in the verdict's basis.

### Measured locale effects

The TypeScript verifier is host-locale dependent. It was run on the historical chain under six `LANG` values (`en_US`, `C.UTF-8`, `sv_SE`, `tr_TR`, `da_DK`, `lt_LT`). All six returned `ok`, because the historical keys never change order under those collations. Under `hu_HU`, 4,784 of 4,846 records differ in canonical text (`acs.` sorts after `act.` under the Hungarian digraph `cs`). Those records are still reproduced under root.

Records written under a non-root collation show the failure directly. The harness writes three single-record chains under `tr_TR`, `sv_SE` and `hu_HU`. The TypeScript verifier, fixed to root, reports `failed` (`event_hash_mismatch`) for each. This is a false corruption claim. The Rust verifier reports `indeterminate` with `locale_dependent` and the explaining locale.

**Open item, not changed here:** the TypeScript `verifyAuditChain` still reports `ok: false` for locale-written records. Any consumer that reads TypeScript output as corruption will misreport them until the TypeScript verifier adopts the same three-state classification. That is a change to the authoritative verifier and needs its own approval.

### Parity and fixtures

Parity is checked by `scripts/audit-chain-parity.ts` (`npm run test:audit-chain-parity`). It covers 89 fixtures:

- the historical chain (real, 4,846 events) and six tampered copies;
- crafted edge-key chains (integer-like keys, canonically equivalent keys, case, punctuation, supplementary characters) and a tampered variant;
- three locale-written single-record chains (`tr_TR`, `sv_SE`, `hu_HU`), a locale-sensitive corrupt-hash record, and a locale-invariant corrupt-hash record;
- a float writer and an unsafe integer stored as text (both `unsupported_canonicalization`);
- empty and missing-table databases, and the second tracked database (pre-audit schema);
- one database for each of the 71 migration entries in `migration.ts`. These are **reconstructed** by replaying the shipped migration SQL, because the repository tracks only two database files. They are not captured from production.

Each fixture declares an expected outcome for each verifier. The harness requires the TypeScript and Rust verdicts to agree where both are definite, requires a declared divergence where Rust is `indeterminate`, requires the database and sidecar files to be unchanged across warm verifier reads, and requires cold opens to reproduce the warm verdict. Immutable cold opens must create no sidecar files.

Mutation checks: changing the Rust corruption gate to require locale-invariant text fails the historical tamper fixture. Changing the key order to code-point order fails five fixtures.
