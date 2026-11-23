# AI Factory F0–F12 implementation status

**As of:** 2026-11-18
**ACS base:** `2221c971` (PR #460 head) plus the uncommitted F1–F12 work on branch `feat/ai-factory-f1-f12-20261118`.
**Codex Swarm base:** `dfbfa686` (`feat/p03-swarm-acs-mode`, local only) plus uncommitted work on `feat/p04-acs-transport-parity`.
**Host:** Linux, Node v26.13.1 locally (CI pins 24.16.0), bubblewrap 0.13.1, systemd user scopes.

Every row is grounded in a command run on these trees. "Done" means the slice's code and its stated acceptance tests exist and pass here. It does **not** mean reviewed, merged, deployed, or production-certified. No commit, push, merge or deploy was made.

## Slice summary

| Slice | Status | Evidence (tests run here) | Remaining before the slice can be called production-ready |
|---|---|---|---|
| F0 contract + PRD | Done; PR CI red for repo-wide reasons | `packages/ai-factory` 13→48 unit/architecture tests; `tsc -b`, `eslint` clean; source scan: no spawn/network/persistence | PR #460 `check` fails on `npm audit --audit-level=high` (picomatch GHSA-fc5q-39xc-vjpf, no patched release; dev-tooling only; affects `main` too). Merge gate fails on a repository ruleset setting. Both need an owner decision. Independent review. |
| F1 authenticated preview intake | Done | `apps/gateway/src/factory-intake.test.ts` (preview: auth, forged actor, malformed/oversized, ref drift, rate-limit audit, 2-user isolation, CSRF); read-only GitHub reader tests | Live GitHub resolution not exercised (fake fetch only). Flag `ACS_FACTORY_INTAKE_ENABLED` defaults off. |
| F2 admission + idempotency | Done | Concurrent duplicates single-create, changed payload conflicts, stale/foreign preview hash refused, crash-window reconciliation, IDOR 404s | — |
| F3 plan DAG + budget | Done | `packages/ai-factory/src/dag.test.ts` (cycle, unknown dep, depth and fan-out boundaries, forbidden-wins scope, lineage); gateway plan/accept tests incl. exact wall-clock budget boundary and per-claim parallel cap | — |
| F4 Codex Swarm transport | Done on both sides; cross-repo parity verified locally | ACS `codex-swarm.test.ts` (10); Swarm `test/acs-transport.test.ts` (6) incl. shared fixture parity; Swarm full suite 257/257; **live parity**: ACS adapter ↔ real `swarm-acs-serve` build PASS | Live parity is not in CI (needs both checkouts). Swarm work is uncommitted on a local branch built on an unpushed branch from another session. ADR 0017 is still Proposed. |
| F5 host isolation | Done for `networkPolicy: none` | `codex-swarm.isolation.test.ts` under `ACS_SANDBOX_INTEGRATION=1` in a real systemd scope + bwrap: no host home, symlink escape denied, no writes outside workspace, no host /proc, no inherited host fds, no TCP/DNS egress, cleared env, secret not in env/cmdline, TasksMax enforced, SIGTERM-ignoring lane killed with the scope | **Scoped egress and single-credential injection are not implemented** in `codex-swarm-v1` (refused). Real model-backed lanes need them. Swarm's ACS handler still refuses execution (`isolation_profile_unavailable`). |
| F6 dispatch + fencing | Done | `ai-factory-runtime` dispatch tests: claim fence, late result fenced, 2 concurrent + third refused by budget, overlap/order → blocked integration, out-of-scope refused despite PASS, lane cap; fence oracle tests on both sides | Swarm does not yet call `checkAcsFence` from real lane mutations (no real lane execution in ACS mode yet). |
| F7 independent verification | Done | Real git: fabricated tree, corrupted diff hash, zero tests, hidden file, missing commit, malicious exit 0, divergent verifier, Swarm-derived verifier, stale snapshot, forbidden file — all block | Production verifier and sandboxed acceptance runner are injected interfaces; only test doubles exist. |
| F8 draft PR publication | Done | Single PR on replay; 10 unauthorized/mis-bound approval cases refused with no remote calls; target advanced; rate limit → uncertain → reconcile; draft-only client | No live GitHub run (would be an external side effect; not authorized). Approval *issuance* UI/flow for publication is not built; F8 consumes an approval record. |
| F9 reconciliation | Done | Real `kill -9` child processes at three publication crash windows; orphaned attempt killed by pid+start-time identity; unknown never retried; cancellation never claims rollback | Store-level `completeOperation` still accepts an `unknown` unit under its old claim token (existing semantics); the factory path never calls it there. |
| F10 Mission Control + metrics | Done | Gateway view/backlog tests (stage progression, concurrent sessions identical, IDOR, no secret/objective text in view/backlog/audit/`/metrics`, route-template metric labels); web `FactoryPage` tests (accessible table, unknown shown as Unknown, contract failure renders nothing, 401) | Not visually verified in a browser this session. No OpenTelemetry tracing added. |
| F11 pilot / chaos | **Rehearsal only (simulated)** | `factory-pilot-rehearsal.test.ts`: 1 then 3 concurrent missions with engine crash, remote drift, rate limit; 8/8 security negatives deny; backup/restore drill with audited write; no unaudited terminal states | **Not done as specified.** Requires real Swarm execution, real repositories and draft PRs, manual review of every result, reconciled model billing (currently unknown → blocked), independent security review, production config, alerts, backups on the real host. |
| F12 production launch | **NO-GO** | See [go-no-go.md](go-no-go.md) | Every P0 blocker listed there. |

## Defects found and fixed during this work

- **Codex Swarm `/acs/v1` scaffold accepted the MAC secret in the request** (`params.secret`). Any socket peer could mint envelopes with its own key. Fixed on `feat/p04-acs-transport-parity`: the secret comes only from an inherited fd; requests carrying `secret` are refused (`secret_on_wire`).
- **Cross-repo canonicalization mismatch.** Swarm used a different key sort and an HMAC-based "domain hash", so it could not verify ACS envelopes. Fixed to be byte-identical; proven by the shared fixture and the live run.
- **F8 reservation wedge** (found in my own code): an owned reservation refused before any push stayed `unknown` forever. Now released when provably nothing external happened.
- **F9 reconciliation key** (found by the F11 rehearsal): a reconciled PR was recorded without the idempotency key, so the next replay reported a conflict. Fixed with a regression test.

## Planning amendment: Maximum Adaptive Autonomy (MAA, 2026-11-17)

PR #460's body records an MAA amendment and asks for these documents to be revisited. How this implementation reconciles it:

- **Coordination vs enforcement.** Agents (planner, Swarm lanes) own goals, decomposition and within-attempt coordination. ACS remains the enforcement authority for leases, fencing, budgets, approvals and terminal acceptance. That matches both MAA ("ACS is reusable infrastructure … policy enforcement where deployed") and the standing rule that ACS stays the only authority for leases, approvals and terminal acceptance.
- **Human approval at genuine boundaries.** The only human gates in F1–F10 are plan acceptance and the external side effect (draft PR publication). Routine dispatch, verification and reconciliation are unattended.
- **Adaptive trust** (MAA item 4) is **not implemented**. No grant expansion based on verified outcomes exists. Any future design must stay bounded by a human-authorized ceiling.
- ADR 0017 and ADR 0030 remain **Proposed**. This work does not change their status.
