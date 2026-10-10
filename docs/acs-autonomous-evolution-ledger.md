# ACS autonomous evolution ledger

Resumable state for the 10-capability "autonomous evolution" mission. Source of truth is Git plus this file plus live
runtime evidence, never conversational memory. Nothing here is authoritative over code; where they disagree, fix this file.

Last updated: 2026-10-10 (session `acs-autonomous-operations-146dab`).

## Session anchor

| Item       | Value                                                                                         |
| ---------- | --------------------------------------------------------------------------------------------- |
| Worktree   | `/home/jacen/projects/agent-control-stack/.claude/worktrees/acs-autonomous-operations-146dab` |
| Branch     | `claude/acs-autonomous-operations-146dab`                                                     |
| Base       | `origin/main` = `f7e4f77` (merge of #323, child-work authority)                               |
| Deployment | Not authorized in this mission. Stop at verified, merge-ready artifacts.                      |

## Baseline (main `f7e4f77`, `ACS_GATEWAY_TOKEN` unset, Node 24.18.0)

| Gate                | Result                                |
| ------------------- | ------------------------------------- |
| `npm ci`            | pass                                  |
| `npm run typecheck` | pass                                  |
| `npm run lint`      | pass                                  |
| `npx vitest run`    | 2859 passed, 90 skipped, **1 failed** |

Known baseline failure (environment-dependent, not caused by this work): `apps/gateway/src/server.test.ts` >
"proves real Hermes CLI interoperability through the tool-search bridge and gateway" times out at 30s (needs a real
Hermes CLI). Not run: `npm run check` aggregate (contracts, audit, release-integrity), CodeQL.

## Decisions and constraints found in reconnaissance

1. **Admin mode.** `docs/superpowers/plans/2026-10-02-retire-global-admin-mode.md` records the product decision that
   admin mode is sticky with no implicit TTL, which matches mission rule B. `STATE.md` still says "time-boxed"; it is
   stale on this point. Work here must preserve the current behavior and must not add a TTL.
2. **Concurrent sessions.** Many feature branches and open PRs already cover parts of this mission (table below). Do
   not duplicate them. Build on merged `main`, and rebase/integrate only after those PRs land or by explicit decision.
3. **CodeQL blocks the merge gate repo-wide** (see memory `jc-stack-concurrent-sessions`). Merging is therefore not
   expected to be available; deliver merge-ready PRs.
4. **Nimble routing flag** `ACS_NIMBLE_ROUTING_ENABLED=1` makes bridge claims 409 (memory
   `acs-nimble-routing-blocks-jc-dc-claims`). Keep it out of any test environment.
5. **JC independence** is being delivered by #324, #325, #326, #329. This mission must not touch the JC authority path
   other than adding regression checks once those land.
6. Existing hash-chained `audit_events` (`packages/shared/src/audit-chain.ts`, CLI `audit export|verify`, `/readyz`
   check) is the tamper-evidence primitive. The Flight Recorder extends it; it does not create a parallel store.

## External field report (pasted by operator, 2026-10-10; not independently reproduced here)

Provenance: a separate session's readiness review of the live host. Treat figures as claims until re-measured.

- **Verified in code on `f7e4f77`:** `apps/gateway/src/server.ts:1174` serves `GET /health` with `deepHealth`, while
  `/livez` and `/readyz` are cheap. `docs/protocol/execution-mode.md` already states admin mode is sticky with no
  default TTL (the live-row details below are the report's, not mine).
- **Reported, not verified by me:** live `/health` takes about 7s (546 MB database, about 203k audit events, full
  audit replay). Jace Commander aborts its status probe at 3s (`status()`) and 2s (`jc_doctor`), and
  `requestJson` maps the abort to `upstream_unreachable`. Result: JC reports the control plane down while it is up.
  The running gateway is release `3ccbf20-pr274-live`, JC is `3f274c0`.
- **Fix already exists, uncommitted, in another session's dirty worktree** (`feat/antigravity-agent-card`): `/health`
  to the cached readiness handler, audit replay moved to authenticated `POST /internal/health/deep`. Do not
  duplicate or touch it. Owner needs to commit it; this mission picks it up only after it lands.
- **Reported exposure to review under Feature 8:** Funnel serves `/health`, `/healthz`, `/ready` unauthenticated and
  they include `pid` and `issuanceReady`; `/mobile` returns 502 with nothing listening; Hermes listens on
  `0.0.0.0:8644`; the swarm view at `127.0.0.1:9711` is not listening. Gateway auth failures fail closed (401).
- **Reported coverage:** sequential run, 2570 passed, authority coverage gate exit 0. My own baseline is 2859 passed
  (parallel, different worktree), so the counts differ because of different trees; neither is a regression signal.
- **Residual uncovered security branches reported:** `store.ts` ~7556/7589 (unparseable admin timestamp, unknown
  stored mode), `server.ts` ~5521-5523 (TTL env parsing), ~1204 and ~2013 (unreadable mode row, missing credential),
  and arms in `execute-approved.ts` and `apps/worker/src/index.ts`. Candidate negative-test slice under Feature 9.
- **Not done by the reporter:** no immutable-tree smoke, no activation, no live rollback. Deploy/rollback is verified
  only against stubs (`deploy-gateway-release.test.sh`) and a fixture SQLite drill.

Consequences for the plan: Feature 8 slice 8.1 must make probe cost explicit (cheap liveness vs authenticated deep
check) and report `STALE`/`UNAVAILABLE` rather than down when a probe times out. Add a JC-side regression check that
a slow control plane is not reported as `upstream_unreachable` once the gateway fix lands. No live restart or deploy
is authorized by this mission.

## Related work already in flight (do not duplicate)

| Ref               | Branch                                             | State at recon                                            | Overlaps feature |
| ----------------- | -------------------------------------------------- | --------------------------------------------------------- | ---------------- |
| PR #306           | `feat/innovation-02-execution-receipts`            | open, CI mostly green, `PR review and merge gate` failing | 4                |
| PR #305           | `feat/innovation-07-time-travel-debugger`          | draft                                                     | 4, 10            |
| PR #328           | `test/child-work-multiprocess-race`                | draft                                                     | 9, 5             |
| PR #330           | `test/child-work-real-grant-integration`           | draft                                                     | 9                |
| PR #329           | `claude/jace-commander-architecture-8b8339`        | open                                                      | rule A           |
| PR #324/#325/#326 | `feat/jc-*-20261009`                               | draft                                                     | rule A, B        |
| PR #309           | `fix/291-migration-059-ambiguous-upgrade-hold`     | open                                                      | 5                |
| PR #303           | `fix/policy-argv-readonly`                         | open                                                      | rule C           |
| Worktree          | `acs-worktrees/innovation-01-mission-intelligence` | no commits ahead of main                                  | 1                |

## Feature matrix

Status key: NOT STARTED, IN PROGRESS, IMPLEMENTED, VERIFIED, INTEGRATED, BLOCKED. Nothing is COMPLETE.

| #   | Feature                           | Status      | Existing code on main                                                                                                                                                  | Gap (to be confirmed per slice)                                                                                  |
| --- | --------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 4   | Execution Flight Recorder         | IN PROGRESS | hash-chained `audit_events`; `packages/evidence` (manifest, observation outbox, reader); `mission-trace.ts`                                                            | mission-level ordered replay API, retention policy, redaction audit, trust-assumption doc, UI                    |
| 9   | Delegated Authority Graph         | NOT STARTED | migration 060 `mission_authority`, `work_unit_authority` (intersection-only, write-once); `child-work.ts`; `authority-narrowing.ts`; autonomous authority grants (047) | graph query/history API, cascade revocation proof, cycle rejection test, restart/stale-claim negative tests, UI  |
| 5   | Self-Healing Mission Runtime      | NOT STARTED | `packages/recovery` (bounded retry planner, startup reconciliation); lease/fencing (migration 058); `liveness.ts`                                                      | durable checkpoints, backoff scheduling, poison-work detection, operator escalation, duplicate-side-effect proof |
| 2   | Dynamic Agent Swarm Builder       | NOT STARTED | `coding-mission` units/DAG/stages; `child-work.ts`; `actor-router`; `moa-orchestrator`; `adr/0017` Codex swarm                                                         | role-based composition, depth/child limits, resource-aware scheduling, teardown                                  |
| 3   | Autonomous Integration Manager    | NOT STARTED | `packages/publication`, `scripts/pr-preflight.mjs`, `slice-workflow`                                                                                                   | PR discovery/reconcile engine, merge simulation, repo-level serialization, gate evaluator                        |
| 7   | Model and Compute Broker          | NOT STARTED | `actor-router` (+ Nimble, `route-metrics`), `agent-cli`, `engine-adapter`, `secret-broker`                                                                             | capability/latency/cost evidence store, GPU/CPU probes, privacy classes, rationale record                        |
| 1   | Mission Intelligence Engine       | NOT STARTED | `coding-mission/src/mission-intelligence.ts` (non-authoritative plan **preview** only), `procedural-learning`, `temporal-memory`                                       | outcome learning, failure classification, grounded recommendations, evidence threshold                           |
| 6   | Mission Simulation / Digital Twin | NOT STARTED | `packages/eval-harness`, `packages/sandbox`                                                                                                                            | fault-injection harness, isolated store, simulation report format                                                |
| 8   | Infrastructure Guardian           | NOT STARTED | `/readyz`, `database-health.ts`, `system-probes.ts` (control-ui), `gateway-post-deploy-healthcheck.sh`                                                                 | probe set, dependency map, incident history, remediation policy                                                  |
| 10  | Mission Control Command Center    | NOT STARTED | `apps/control-ui` (dashboard, coding-mission panel, execution-mode, audit timeline, work-item controls)                                                                | views for recorder, authority graph, swarm, routing, health, simulation, intelligence                            |

## Slice plan (dependency order)

Phase 1 first. Each slice is a vertical, separately reviewable PR off the then-current `origin/main`.

| Slice | Scope                                                                                                                                                  | Depends on                   | Status      |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------- | ----------- |
| 4.1   | Mission-scoped Flight Recorder read model (chain, verifier, replay API, `GET /coding-missions/:id/flight-record`; design in `docs/flight-recorder.md`) | none                         | IMPLEMENTED |
| 4.2   | Retention policy + redaction verification + trust-assumptions doc (documents external anchor need)                                                     | 4.1                          | NOT STARTED |
| 9.1   | Authority graph query API + history + cycle/escalation/revocation-propagation adversarial tests                                                        | merged #323                  | NOT STARTED |
| 5.1   | Durable checkpoint + backoff + poison-work classification in recovery, with fenced-resume test                                                         | 9.1 (authority revalidation) | NOT STARTED |
| 2.1   | Swarm composition planner with depth/child/resource limits                                                                                             | 9.1, 5.1                     | NOT STARTED |
| 3.1   | Integration manager read-only reconcile (PR discovery, merge simulation, gate evaluation, no merge)                                                    | none (parallel)              | NOT STARTED |
| 7.1   | Evidence-driven provider selection with recorded rationale                                                                                             | none (parallel)              | NOT STARTED |
| 1.1   | Outcome-grounded recommendations (advisory only)                                                                                                       | 4.1                          | NOT STARTED |
| 6.1   | Fault-injection simulation harness on an isolated in-memory store                                                                                      | 5.1                          | NOT STARTED |
| 8.1   | Real health probes, dependency map, incident log                                                                                                       | none (parallel)              | NOT STARTED |
| 10.x  | Mission Control views and controls, one panel per backend slice                                                                                        | each backend                 | NOT STARTED |

## Slice log

| Slice                       | Branch                                    | Commit        | Tests          | CI      | Integration | Remaining risks                                                        |
| --------------------------- | ----------------------------------------- | ------------- | -------------- | ------- | ----------- | ---------------------------------------------------------------------- |
| 0 (recon, baseline, ledger) | `claude/acs-autonomous-operations-146dab` | _this commit_ | baseline above | not run | not pushed  | Baseline vitest has 1 environment failure; `npm run check` not yet run |

Slice 4.1 (branch above, draft PR): migration **062** (061 is reserved by open draft #333, per `pr:preflight`),
`packages/coding-mission/src/flight-recorder.ts`, all coding-mission event and evidence writes routed through it.

Evidence so far (local, not yet CI): `typecheck`, `lint`, `contracts:check` clean. Full vitest on the pre-rebase tree:
2885 passed, 0 failed, 90 skipped. Targeted vitest after rebase and renumber: 442 passed in 26 files. 24 recorder
tests cover edit, delete-middle, delete-newest, reorder, edited and deleted operational rows, event and evidence
written around the recorder, redaction, rollback atomicity, legacy rows, paging. One gateway test completes a real
mission, replays it (17 records, derived state `COMPLETED` equals live), edits the database underneath, and gets
`tampered`.

**What 4.1 does not do yet (remaining risks, do not claim as done):**

- No external integrity anchor. A consistent full-chain rewrite is detectable only by comparing `headHash` to a value
  held elsewhere; the test `documents the limit` proves the gap. Needed: publish head hash to an append-only sink.
- Tool-call parameters, target, file and commit changes are recorded only to the extent the existing mission events
  carry them. Per-tool-invocation capture with authorization reference and policy decision is slice 4.3.
- Only coding missions are covered; change-set missions keep `mission-trace.ts`, and receipts stay with #306.
- No retention job (policy is "keep everything", documented). No Mission Control evidence viewer (Feature 10).
- `acs:read` guards the endpoint. A dedicated audit scope is a contract-baseline decision, not made here.
- Migration 062 leaves a gap at 061 until #333 lands. #331, #332, #333 touch `index.ts`, `worker-execution.ts`,
  `migration.ts`, `state-machine.test.ts`; expect trivial conflicts on whichever lands second.
- `work_unit.completed` in `store.ts` stamps wall-clock time rather than the injected clock (pre-existing; seen in the
  replay). Not changed here.

## Next action

Push the branch, open the draft PR (reserves 062), read CI. Then slice 9.1 (authority graph query, history, cycle and
escalation negative tests) on a fresh slice off `origin/main`, or 4.3 if CI shows a recorder problem first.
