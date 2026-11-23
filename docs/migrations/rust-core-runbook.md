# ACS core (read-only audit verifier) runbook

Scope: `rust/acs-core` (store, legacy v1 and v2 canonical hashing, audit chain verifier, `acs-audit-verify` binary) and `rust/acs-core-node` (Node-API bridge). The crate contains no write path. A test scans the source for write SQL and `execute` calls.

TypeScript remains the only writer and the only authority over the audit chain. The Rust verifier computes a read-only verdict and is selected only for that read path. Nothing in production calls it yet.

## Build and verify

```sh
npm ci
npm run build:native            # builds graph, scope supervisor, acs-audit-verify, acs_core addon
npm run test:audit-chain-parity # 89 fixtures, cold and warm opens; exit 0 means every fixture matched
ACS_TEST_CORE_NATIVE=1 ACS_CORE_BACKEND=rust npm run test:vitest -- packages/shared/src/core-backend.test.ts
cargo test --locked --manifest-path rust/acs-core/Cargo.toml
```

`build:native` runs on explicit request only, never on install. It fails off Linux x64 glibc.

## Selecting the Rust verifier

`ACS_CORE_BACKEND` is read by `verifyAuditChainFromDatabaseFileWithBackend` in `packages/shared/src/core-backend.ts`.

- unset, empty or `typescript`: the TypeScript verifier. The addon is not loaded.
- `rust`: the acs_core addon. A missing or ABI-mismatched addon throws `ACS_CORE_ADDON_UNAVAILABLE`. A failing native call throws `ACS_CORE_CALL_FAILED`, with a category only. There is no silent fallback.
- any other value throws `ACS_CORE_BACKEND_INVALID`.

The Rust result is a three-state verdict. See `canonical-hash.md`:

- `ok: true` or `ok: false` with a `failure`, in the same shape as TypeScript;
- `ok: null` with an `indeterminate` object, when the data cannot establish corruption or success. Consumers must not read `null` as a pass or as corruption.

## Open modes and filesystem effects

`acs-audit-verify` has two modes. Both were measured on disposable copies, not inferred.

| Mode | SQLite open | Cold, writable dir | Cold, read-only dir | Warm, read-only dir |
| --- | --- | --- | --- | --- |
| default | `SQLITE_OPEN_READ_ONLY`, `SQLITE_OPEN_NO_MUTEX`, `PRAGMA query_only` | verdict; creates `-shm` (32 KiB) and empty `-wal` | **fails** `store` (needs to create `-shm`) | verdict; no new files |
| `--immutable` | `SQLITE_OPEN_READ_ONLY`, `SQLITE_OPEN_URI`, `immutable=1`, `query_only` | verdict; **no** new files | verdict; no new files | not applicable |

Measured with `scripts/audit-chain-open-evidence.ts` on a copy of the tracked backup (SHA-256 `f3b4a398…`, mode 0644, uid 1000). In every mode the database file's bytes, size, mtime and inode were unchanged. The TypeScript verifier on a cold copy also created `-shm` and `-wal`.

What this does and does not show:

- A default open of a WAL database **is** a filesystem write. It creates sidecars unless they already exist, and the directory must be writable for that.
- The "warm" result shows only that existing sidecars are not rewritten by a read-only open. It is not a zero-write proof for a cold open.
- `--immutable` refuses a database whose `-wal` is non-empty (`uncheckpointed_wal`). It ignores the WAL, so it is safe only for files no other process can write: archives, copies and forensic snapshots. Live databases must use the default mode.
- Without `strace`, the directory-permission experiment above is the observable test. A syscall trace was not captured.

## Parity and read-only guarantees

`scripts/audit-chain-parity.ts` builds its fixtures in a scratch directory and never writes to a tracked file. For each fixture it:

1. copies only the main file and opens it cold, in the default mode and in `--immutable` mode, in fresh directories;
2. warms the SQLite sidecars once, then records SHA-256 of the database, `-wal` and `-shm`;
3. computes the TypeScript verdict (under `LANG=C.UTF-8`, in a child process) and the Rust verdict;
4. requires the three hashes to be unchanged across the warm verifier reads;
5. requires both cold modes to reproduce the warm Rust verdict, and immutable cold opens to create no files;
6. requires each verdict to meet its declared expectation, and requires agreement where both are definite. A declared divergence covers the case where Rust is `indeterminate`.

The warm step is a parity precondition. It is not a proof of zero filesystem writes. The cold results and the open-mode table above are the write evidence.

### Fixture coverage

- **Real:** the tracked historical backup (4,846 events, schema head of migration 74 when it was written), and the tracked one-page pre-audit database.
- **Derived from the real backup:** six tampered copies (body, link, deleted row, head hash, emptied chain).
- **Constructed:** crafted chains with edge-case keys; locale-written records (`tr_TR`, `sv_SE`, `hu_HU`); a float; an unsafe integer stored as text; an empty chain; a database without the audit table.
- **Reconstructed schema versions:** one database per entry in `migration.ts` (71 entries, versions 1 to 79 with gaps). Built by replaying the shipped migration SQL. The repository tracks no per-version database, so these are not captured from production.

## Limits

- Floats and integers beyond 2^53 − 1 are `indeterminate` (`unsupported_canonicalization`). TypeScript verifies them, so the two verifiers differ on such data. The historical data has neither.
- Lone surrogates cannot be represented in Rust. The TypeScript verifier can hash them, so a chain containing one would diverge. The historical data does not contain one.
- Historical verdicts depend on collation. The Rust verifier tests root and five alternate collations and reports what it can establish. A writer locale outside the tested set can still yield a `failed` verdict; the basis is stated in the verdict.
- The TypeScript `verifyAuditChain` does not yet classify locale-dependent mismatches. Its `ok: false` on locale-written records is a false corruption claim. This is an open item for the authoritative verifier.
- `ACS_TEST_CORE_NATIVE=1` tests are opt-in. CI runs them in `.github/workflows/rust.yml`.
