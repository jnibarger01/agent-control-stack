# Uncommitted change audit — `feat/acs-rust-authority-cutover-20261121` (2026-11-22)

Base: `7bb5e3ce`. Nothing was committed, reverted or deleted during the audit. The 34 entries that existed before
this session are categorized below. Entries added in this session are marked **(this session)**.

## Implementation

| Path                                                 | Change                                                                                       | Acceptance evidence                                                                        | Gap                                                                                                     |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `rust/acs-core/` (new crate, 15 files)               | Canonical JSON v1 (ICU root order) and v2, audit-chain verifier, read-only store, `acs-audit-verify` bin | `cargo test`: 26 pass. `scripts/audit-chain-parity.ts`: 89/89 fixtures agree with TypeScript, read-only. Live audit chain (25,672 events) verifies `ok` on a copy | No mixed-locale fixture written by a real `tr_TR` host. Read-only; owns no state                        |
| `rust/acs-core-node/` (new, 5 files)                 | Node-API binding of `acs-core`                                                               | `core-backend.test.ts` with `ACS_TEST_CORE_NATIVE=1`: pass                                  | Ledger: Node-API addons are not acceptable in the final native release (interim only)                    |
| `packages/shared/src/core-backend.ts` (new)          | `ACS_CORE_BACKEND=typescript\|rust` selection, fail-closed                                   | `core-backend.test.ts`                                                                     | Not wired to any gateway code path yet. The staged gateway accepts the variable but does not exercise it |
| `packages/shared/src/hash.ts` (+112)                 | Adds `canonicalJsonV2`, `stableHashV2`, `domainHashV2`. v1 unchanged                         | `canonical-hash-v2.test.ts`, `contracts/canonical-hash/v2.golden.json`                     | No v1→v2 migration of stored hashes (by design; see `docs/migrations/canonical-hash.md`)                |
| `packages/shared/src/index.ts` (+1)                  | Re-export                                                                                    | build                                                                                      | —                                                                                                       |
| `packages/work-items/src/retry-fence.ts` (new), `store.ts` (+240) | Retry fence: refuses replacement attempts and retries while an attempt is live/unknown without verified cleanup evidence; one in-flight retry per source | `retry-fence.test.ts` (434 lines), `state-machine.test.ts`                                  | **Behaviour change, not feature-gated.** No gateway/CLI route records cleanup evidence, so a future `unknown` attempt blocks its work item until a privileged store call. Production copy: 0 attempts fenced, 1 in-flight retry (`wrk_1857f2a7…`, approved since 2026-11-05) |
| `packages/integration-manager/src/graph-backend.ts`  | Strict backend selection, no silent TypeScript fallback                                      | `graph-native.test.ts` with `ACS_TEST_INTEGRATION_GRAPH_NATIVE=1`: pass                     | —                                                                                                       |
| `rust/integration-graph/*`, `src/port_cases.rs`      | Port cases, dependency additions                                                             | `cargo test`: 3 pass; 256-graph differential test                                          | —                                                                                                       |
| `packages/shared/src/database-health.ts`, `packages/work-items/src/store.ts` (shadow wiring), `audit-shadow.test.ts` **(this session, slice R1)** | Rust core verifies the audit chain as a non-authoritative shadow under `ACS_CORE_BACKEND=rust`; any disagreement, indeterminate verdict or shadow error fails the audit check closed; comparisons over changed audit data are skipped and counted | 11 tests, one against the compiled core; a mutation that always passes the comparison fails 4 tests; production copy (25,672 events): 4/4 agree, 0 skipped | **Fails gate G6**: the shadow adds ~1.6 s per `health()` on the event loop. Not to be enabled in production until slice R1b |
| `packages/local-advisor/src/egress.ts` **(this session)** | `nodeWouldProxy` exact for Node 24 and 26 undici rules, strictest union otherwise           | Live dispatcher parity on Node 26.13.1 and on `node:24.16.0-bookworm-slim` (17/17)          | —                                                                                                       |

## Migrations

| Path                                                         | Notes                                                                                                                |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `storage/migrations/083_retry_fence_cleanup_evidence.sql` (new) | Renumbered from 079 **(this session)**; additive. Reservation on `chore/migration-reservations-20261122` (`0c92231e`) |
| `packages/shared/src/migration.ts`                           | Registers 083, comment holds 079–082                                                                                 |

Rollback: the earlier rehearsal showed that a code-only rollback fails once the new migration is recorded
(`migration_mismatch`, `/readyz` 503). See `docs/migrations/production-cutover-plan.md`.

## Tests

`packages/shared/src/canonical-hash-v2.test.ts`, `core-backend.test.ts`, `packages/work-items/src/retry-fence.test.ts`,
`state-machine.test.ts` (roster pin), `packages/integration-manager/src/graph-native.test.ts`,
`packages/sandbox/src/rust-supervisor.test.ts` (+10), `rust/scope-supervisor/tests/supervise.rs` (+65).
**(This session)** `egress.test.ts`, `server.test.ts` (OpenCode 2.3 and Hermes 0.23 flags/config),
`openclaw-interoperability.test.ts` (OpenClaw 2026.11 `agents.entries`).

## Configuration, build and CI

| Path                           | Notes                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `package.json` (+2)            | `build:native`, `test:audit-chain-parity` scripts                                                       |
| `rust-toolchain.toml` (new)    | Pins Rust 1.99.1                                                                                         |
| `.github/workflows/rust.yml` (new) | **Never executed.** No CI evidence exists for it                                                     |
| `scripts/build-native.mjs` (new) | Builds addons and supervisor, prints SHA-256 per artifact                                              |
| `scripts/audit-chain-parity.ts`, `audit-chain-open-evidence.ts` (new) | Parity harness (run: 89/89). `audit-chain-open-evidence.ts` **has no recorded run** |
| `packages/shared/native/` | `.gitignore` plus built `acs_core.node`; the binary is ignored and will not be committed |

## Documentation

`docs/migrations/canonical-hash.md`, `rust-core-runbook.md`, `docs/protocol/retry-fence.md` (updated for 083 this
session), `docs/migrations/rust-graph-runbook.md`, `docs/integration-manager.md`.

## Unrelated to the migration — exclude from any commit

| Path                                         | What it is                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------ |
| `.harnesskit/session-start-time.txt` (deleted) | HarnessKit tool state, written by a session hook                              |
| `.harnesskit/session-logs/2026-11-22-1919.json` | HarnessKit session log                                                       |

The interop fixes (egress, OpenCode, Hermes, OpenClaw) are unrelated to Rust. They are also on their own branch,
`fix/acs-interop-toolchain-20261122` off `7bb5e3ce`, so they can land independently.

## Missing acceptance evidence (summary)

1. Retry fence: no operator route for cleanup evidence; no feature gate; no mixed-version test (old code reading a DB
   with 083 present).
2. `rust.yml` never run; `audit-chain-open-evidence.ts` never run.
3. Before slice R1, `ACS_CORE_BACKEND=rust` was accepted but no code path used it. R1 (this session) wires it into
   the store's health inspection as a shadow; no HTTP or MCP operation's result depends on Rust yet.
4. No committed revision exists for this work.
