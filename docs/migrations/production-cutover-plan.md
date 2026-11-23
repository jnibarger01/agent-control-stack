# ACS Rust migration: production-safe cutover plan

Status: **plan only. No production cutover is authorized** (decision of 2026-11-22). This replaces the earlier
staging note, which relied on restoring a pre-cutover database backup and so lost any writes made after the
cutover. Do not request production approval until every gate in "Go / no-go" passes.

## Principles

1. **Expand, then switch, then contract.** Schema changes ship before the code that depends on them and are
   tolerated by the code that runs before them. No release may require a database restore to roll back.
2. **TypeScript stays authoritative until a slice's gate passes.** Rust components run as shadows (compare, never
   decide) or behind a selection variable with a TypeScript default, and fail closed.
3. **One variable per slice, per instance.** Rolling back a slice is unsetting its variable and restarting; it
   never needs a schema change.
4. **ACS remains the only authority** for leases, approvals and terminal acceptance (ADR 0032 intent). Moving that
   authority into Rust is a separate, later decision with its own gate.

## Database compatibility

Findings this plan addresses (evidence in `uncommitted-audit-20261122.md` and the session record):

- The new code applies migration 083 (`retry_fence_cleanup_evidence`) on start. It is purely additive: two new
  tables, triggers only on those tables, foreign keys to `execution_attempts` and `attempt_leases`, which no
  release deletes from.
- The current live code reports `migration_mismatch` and `/readyz` 503 on a database that has any migration it
  does not ship (rehearsed on a copy). That strict equality is the only obstacle to a code-only rollback.
- Migration versions 079–083 were claimed by three lineages. Reserved on `chore/migration-reservations-20261122`
  (`0c92231e`, not pushed): JCA2 keeps 079/080, kernel witness 081/082, Rust retry fence 083.

Required changes:

| Step | Release           | Change                                                                                                                                                                                                                                                                                       | Rollback                                                    |
| ---- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| B0   | Bridge (N-1)      | Readiness accepts trailing migrations that appear in a shipped **forward-compatibility list**, keyed by version, name, filename and SHA-256, and only for migrations reviewed as additive (new tables/indexes/triggers on new tables only). Unknown or mismatched trailing rows still fail. Contains no schema change and no Rust | Redeploy N-2 (no schema change)                             |
| B1   | Expand (N)        | Ships migration 083 and the retry-fence store code. The fence stays behind `ACS_RETRY_FENCE=enforce` (default `off`); with the gate off, the store records scope and evidence rows but never refuses. Adds the operator route to record verified cleanup evidence | Redeploy B0. B0 reads 083 as forward-compatible; no restore |
| B2   | Shadows on        | Same binary as B1. Enable `ACS_CORE_BACKEND=rust` (audit shadow, slice R1) after R1b performance gate passes. Integration graph and sandbox supervisor stay at their TypeScript defaults until their own gates pass                                                                           | Unset the variable, restart                                 |
| B3   | Fence enforce     | `ACS_RETRY_FENCE=enforce` after B1 has recorded scope/evidence rows for every new attempt for the soak window                                                                                                                                                                                 | Set `off`, restart                                          |

Mixed-version tests required before B1 (none exist yet):

- B0 code on a database with 083 applied: readiness 200, every public read operation equal to B1, writes succeed.
- B1 code on a B0 database: migration applies once and is idempotent across restart.
- B0 code on a database with a **different** 083 (wrong checksum) or an unlisted 084: readiness 503.

## Rollback without losing post-cutover writes

Every step above rolls back by redeploying the previous binary or unsetting a variable. None restores a database.
Writes made after the step stay in place, because:

- B0 tolerates 083's tables, and nothing the previous code writes touches them.
- Shadows never write.
- The fence gate only changes whether new attempts are refused, not what is stored.

Backups are still taken before every step (`sqlite3 .backup`, verified by `acs-audit-verify` and
`inspectControlPlaneDatabaseFile`), but only for disaster recovery, not as the rollback mechanism.

A restore is the procedure of last resort, used only for corruption. It requires its own authorization because it
discards writes.

## Restart recovery

- systemd `Restart=on-failure`, `RestartSec=5` (unchanged). Readiness gates traffic: the gateway does not report
  ready until migrations, integrity, foreign keys and the audit chain pass.
- On restart, leases past their TTL expire through the existing fenced path. With the fence enforced, an attempt
  whose isolation outcome is unknown blocks replacements until verified cleanup evidence is recorded through the
  operator route (B1). That route must exist before B3.
- Rehearsal required per step: `systemctl --user kill -s KILL` during an active attempt on the staging instance,
  then restart; check readiness, lease expiry, the attempt's terminal state and audit-chain continuity.
- Pin `LANG=C.UTF-8` and `LC_ALL=C.UTF-8` on every ACS unit until canonical hash v1 is retired (locale-dependent
  key order).

## Authorization checks

- Every step needs a separate explicit authorization naming the step (B0–B3), the target instance and the
  revision. Approval of one step does not carry to the next.
- Every step runs a committed, reviewed revision. Uncommitted trees are never deployed.
- After deployment, verify that authentication and authorization are unchanged: the contract suite
  (`contracts/public/v1`), the security-contract conformance test, and an unauthenticated sweep of every
  operation (expect 401/403 exactly where the previous release did).

## Go / no-go (measurable)

All must hold on the staging instance (:3100, production-data copy) for the candidate revision, recorded with
command output.

| Gate | Criterion                                                                                                                         | Status 2026-11-22                                                           |
| ---- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| G1   | Full Vitest suite: 0 failures in two consecutive runs; skips only for absent optional tools, listed by name                       | Baseline fix branch: run 1 one load-induced Hermes timeout, run 2 0 failures |
| G2   | `cargo test` for every crate: 0 failures; `audit-chain-parity`: all fixtures agree                                                | Pass (89/89)                                                                |
| G3   | Mixed-version tests above pass                                                                                                    | **Not written**                                                             |
| G4   | Restart rehearsal per step passes                                                                                                 | **Not done**                                                                |
| G5   | Contract sweep: every public operation's status equals the previous release, authenticated and unauthenticated                     | Unauthenticated GET sweep only                                              |
| G6   | `/health` p95 ≤ previous release + 10% with shadows enabled; event-loop block from a shadow ≤ 50 ms                                | **Fails**: R1 shadow adds ~1.6 s per `health()` on 25,672 events            |
| G7   | Shadow disagreements = 0 over a 7-day staging soak; skipped comparisons < 1%                                                       | 4/4 agree on the production copy; no soak                                   |
| G8   | `npm run security:audit` exits 0, or a recorded, accepted exception                                                               | Fails (ledger)                                                              |
| G9   | Rust CI workflow (`.github/workflows/rust.yml`) green on the candidate revision                                                   | Never run                                                                   |
| G10  | Migration reservations merged on `main`                                                                                           | Prepared locally, not pushed                                                |

No-go if any gate is not met. In particular, G6 currently fails, so the audit shadow must not be enabled in
production.
