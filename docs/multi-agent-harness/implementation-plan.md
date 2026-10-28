# Implementation Plan: Slice 1 (ACS contract + Claude Code adapter)

Status: **Proposed.** Phase 2 and 3 of spec-driven development (plan, tasks). Implementation does not start until a human accepts the [PRD](prd.md), [contract](acs-integration-contract.md), [adapter spec](claude-code-adapter.md) and [ADR 0029](../adr/0029-desktop-harness-is-an-acs-client.md), and answers the PRD's open questions.

## Working rules for every task

1. **One slice, one worktree.** Start with `npm run slice:new -- <branch>` (AGENTS.md "Slice Workflow"). One writer per area. Run `npm run pr:preflight` before any PR. Draft PR first.
2. **Tests first** (red, green, refactor). Each task's Verify column names the command that must pass.
3. **Done means:** the task's focused tests pass, `npm run typecheck` and `npm run lint` are clean, the invariants it touches have a test, and only the listed paths are staged (path-scoped `git add`).
4. **Ask-first items** (PRD §10) stop the task until a human approves. They are marked **[ASK]**.
5. Tasks touch about five files or fewer. If one grows, split it.

## Dependency graph

```
T0 probe ─────────────────────────────┐
T1 entry gates / reconcile ─┐         │
T1b decisions (human) ──────┼──► Phase B (T2..T6) ──► Phase C (T7,T8) ──► Phase E (T9..T15)
                            └──► Phase D (A1..A6, ACS-side, [ASK]) ──────────┘
```

- Phase B has **no ACS dependency** and can start as soon as T1b answers open questions 4 and 5.
- Phase D tasks are separate ACS slices. Phase E tasks that need them are marked with the gap id.
- T0 can run immediately and in parallel; it changes nothing in production code.

## Phase A: Decide and verify (no production code)

- [ ] **T0: Probe the installed Claude CLI**
  - Acceptance: answers every [U] in adapter spec §2 with evidence (flags exist, stream-json shapes, hook payload and decision schema, settings-source isolation mechanism, how bypass is represented, SIGINT behavior, exit codes for budget/timeout/auth, version format). Real output saved as **scrubbed** fixtures from a read-only task in a throwaway directory; no credential or home path in any fixture.
  - Verify: written findings reviewed by a human; a script asserts fixtures contain no `sk-`, token, or home-directory strings.
  - Files: `docs/multi-agent-harness/t0-claude-probe.md`, `packages/harness-claude-adapter/src/__fixtures__/*.jsonl` (new). Runs on the operator's machine, not in CI.
- [ ] **T1: Entry gates and reconciliation with the other harness worktree**
  - Acceptance: the second-hand findings from the Slice 1 assessment (credential copy into sandbox, bwrap host-root bind, missing or partial consume route, in-memory nonces, unpinned image) are each marked _reproduced / not reproduced / not applicable_ with the command and output, against whatever code actually exists at decision time. Owner of that worktree confirms sequencing (PRD OQ5). ADR renumbering plan agreed.
  - Verify: `git worktree list`; the evidence file lists commit ids examined.
  - Files: `docs/multi-agent-harness/entry-gates.md`.
- [ ] **T1b: Human decisions** (not a code task). Close PRD OQ1 to OQ5; mark ADR 0029 Accepted or revise it.

**Checkpoint A:** T0 findings and T1b decisions are written down. If OQ4 resolves against the work-item anchor, ADR 0029 and the contract are revised before Phase B.

## Phase B: Protocol and core (no ACS changes)

- [ ] **T2: `packages/harness-protocol` scaffold + dependency boundary**
  - Acceptance: package builds in the project references; ESLint forbids `harness-*` packages from importing `@agent-control-stack/work-items`, `policy-gate` and other ACS store packages, and forbids any package importing `apps/**`; `npm run format:check` list extended for new source paths.
  - Verify: `npm run typecheck && npm run lint`; a lint fixture proves the restriction fires. **[ASK]** for the ESLint and `format:check` edits.
  - Files: `packages/harness-protocol/package.json`, `tsconfig.json`, `src/index.ts`, `eslint.config.js`, root `tsconfig.json`.
- [ ] **T3: Protocol schemas (FR-1)**
  - Acceptance: strict schemas for `RunBinding`, `RunRequest`, `RunEvent` (all v1 types), `AgentCapabilities`, `AgentHealth`, `RunStatus`, `CancelResult`, `ReconciliationResult`. Unknown keys rejected. `parentRunId` must be `null`. Golden fixture round-trips. Adapter-source events with forbidden types are rejected by a `validateAdapterEvent` helper.
  - Verify: `npx vitest run packages/harness-protocol`.
  - Files: `src/run.ts`, `src/events.ts`, `src/adapter.ts`, `src/*.test.ts`.
- [ ] **T4: Conformance suite, `FakeAdapter`, lying adapter (FR-2)**
  - Acceptance: obligations 1 to 7 of contract §10 implemented as a reusable suite. `FakeAdapter` passes. A lying adapter (advertises `resume` with no method; reports `terminated` with a live grandchild) fails the corresponding checks.
  - Verify: `npx vitest run packages/harness-protocol/src/conformance`.
  - Files: `src/conformance/suite.ts`, `src/conformance/fake-adapter.ts`, `src/conformance/lying-adapter.ts`, tests.
- [ ] **T5: `packages/harness-core` event log (FR-3)**
  - Acceptance: SQLite-backed append-only log; core assigns `seq`; opaque cursors; redaction before append; replay returns exact suffix then live events with no gap or duplicate; torn-write recovery truncates to the last valid record. Confirms the SQLite driver the repo already uses before adding anything (**[ASK]** if a new dependency is needed).
  - Verify: `npx vitest run packages/harness-core`, including a crash-between-append-and-ack test.
  - Files: `packages/harness-core/{package.json,tsconfig.json}`, `src/event-log.ts`, `src/event-log.test.ts`.
- [ ] **T6: Run state machine with `outcome_unknown` (FR-5)**
  - Acceptance: pure transition function over (ACS authority view, adapter facts). Property tests: no edge from `outcome_unknown` to `succeeded` without a `reconcile.completed` carrying evidence; no edge to a new attempt; `succeeded` requires an ACS-accepted result (INV-8); adapter-source events cannot move terminal state. All entry conditions in contract §8.1 covered.
  - Verify: `npx vitest run packages/harness-core/src/run-state`.
  - Files: `src/run-state.ts`, `src/run-state.test.ts`.

**Checkpoint B:** `npm run typecheck`, `npm run lint`, new vitest suites green; `FakeAdapter` drives a full simulated run through the state machine and event log without ACS or Claude.

## Phase C: ACS client and recovery

- [ ] **T7: ACS HTTP client against a fake gateway (FR-4)**
  - Acceptance: implements claim (`POST /worker/claim`), result submission (`POST /work-items/:id/results`), authority read, lease renewal, cancel observation per contract §4 and §7. First step: read `docs/protocol/worker-results.md` and resolve G5, G7, G8 by inspecting the gateway code; where a route does not exist, stop and open the matching Phase D item. Never sends identity, lease or policy fields it was not given. Every row of contract §9 that concerns ACS has a test.
  - Verify: `npx vitest run packages/harness-core/src/acs-client`.
  - Files: `src/acs-client.ts`, `src/acs-client.test.ts`, `src/fake-gateway.ts`.
- [ ] **T8: Restart reconciliation (FR-9, core part)**
  - Acceptance: on startup every non-terminal run is reconciled using ACS state, adapter `reconcile()`, and process identity (pid plus start time). Unverifiable process is never signalled. Result submission retried idempotently from a durable outbox.
  - Verify: `npx vitest run packages/harness-core/src/recovery`, including `kill -9` of a child test process holding the core.
  - Files: `src/recovery.ts`, `src/outbox.ts`, tests.

**Checkpoint C:** the fake adapter plus the ACS client plus the fake gateway pass every contract §9 row.

## Phase D: ACS-side slices **[ASK] each; separate PRs; each needs its own short spec**

Order is by dependency. These change the authority plane and are not part of the harness packages.

| Slice | Gap        | Change                                                                                                                                             | Gate before merge                                                       |
| ----- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| A1    | G1         | Plan backend for an interactive agent session; policy and hash implications; migration number via `node scripts/pr-preflight.mjs --next-migration` | Human confirms ADR 0029 anchor decision and the ADR 0022 amendment      |
| A2    | G2         | Add `adapterId`, `adapterConfigHash`, `governance`, `policyVersion` to the approved action hash                                                    | Approval-binding tests: changed config invalidates outstanding approval |
| A3    | G3         | Attempt-keyed tool-check; invocation-hash approval; single-use consumption; interactive approval wait                                              | Argument-swap, replay, expiry, self-approval negatives                  |
| A4    | G4         | Atomic per-mutation authority consume (check whether it already exists in the other worktree first, to avoid a duplicate nonce system)             | Concurrent duplicate, restart persistence, cancel, stale epoch tests    |
| A5    | G5, G6, G8 | Authority read model, running-attempt cancel semantics with executor acknowledgement, replayable ACS event stream (or documented polling)          | Contract §7 conformance tests                                           |
| A6    | G9         | Scoped short-lived model credential (model proxy)                                                                                                  | Credential-absence test passes on the real launch path                  |

If a slice is refused, the matching Phase E capability is removed from the adapter's report (contract: "Slice 1 scope shrinks to what ACS supports").

## Phase E: Claude Code adapter and driver

- [ ] **T9: Launch, environment, preflight, `health()` (FR-6)**
  - Acceptance: adapter spec §3 and §4. Seeded bypass in argv, user, project and managed settings each yield `unsafe` and `start()` throws. Child environment and mounts contain no host credential and no disallowed key (asserted on the actual spawn arguments). Pinned binary path and version allowlist. Own process group.
  - Verify: `npx vitest run packages/harness-claude-adapter/src/launch`.
  - Files: `packages/harness-claude-adapter/{package.json,tsconfig.json}`, `src/launch.ts`, `src/health.ts`, tests.
- [ ] **T10: Event translation from fixtures (FR-6)**
  - Acceptance: adapter spec §6 finalized from T0 fixtures; unknown kinds become `adapter.warning`; malformed lines do not crash; in-flight tool calls tracked.
  - Verify: `npx vitest run packages/harness-claude-adapter/src/translate`.
  - Files: `src/translate.ts`, `src/translate.test.ts`, fixtures.
- [ ] **T11: Gate hook and approval flow (FR-7)** (needs A3 for the real gate; uses the fake gateway until then)
  - Acceptance: adapter spec §7 (M1). Fail closed on every error path. `invocationHash` matches contract §5.1 test vectors. No code path in the harness approves anything (a test greps the exported surface).
  - Verify: `npx vitest run packages/harness-claude-adapter/src/gate`.
  - Files: `src/gate-hook.ts`, `src/invocation-hash.ts`, tests.
- [ ] **T12: Cancel and reconcile (FR-8)**
  - Acceptance: adapter spec §8. Grandchild tree killed; `terminated` never returned while a descendant lives; reconcile is read-only; pid reuse is not signalled.
  - Verify: `npx vitest run packages/harness-claude-adapter/src/cancel`.
  - Files: `src/cancel.ts`, `src/reconcile.ts`, tests.
- [ ] **T13: `apps/harness-cli` and E2E (FR-10, FR-11)**
  - Acceptance: `run`, `events --cursor`, `cancel`, `status`, `reconcile`; no domain logic in the app; governance label printed and recorded. E2E drives a fake `claude` script through a real gateway in test mode.
  - Verify: `npx vitest run apps/harness-cli`.
  - Files: `apps/harness-cli/{package.json,tsconfig.json}`, `src/cli.ts`, `src/e2e.test.ts`.
- [ ] **T14: Fault-injection suite (FR-9)**
  - Acceptance: `kill -9` of the harness mid-run and mid-tool-call; ACS outage during submission; orphan agent; duplicate cancel and submit; torn event log. Each ends in a correct terminal state or `outcome_unknown` with reconcile evidence; no duplicate or missing events.
  - Verify: `npx vitest run apps/harness-cli/src/fault-injection.test.ts`.
  - Files: `src/fault-injection.test.ts`, helpers.
- [ ] **T15: Slice 1 gate and evidence (FR-12)**
  - Acceptance: PRD §11 criteria 1 to 8 each shown by a command and its recorded output; independent review run (`agent-protocols:security-auditor` and `code-review` on the diff); no regression in `npm run test:vitest`.
  - Verify: `docs/multi-agent-harness/slice-1-evidence.md` complete; reviewer findings resolved or recorded.
  - Files: evidence document only.

**Checkpoint E (release gate for Slice 1):** every PRD §11 criterion shown by running it. Anything not run is listed as not verified, not claimed.

## Parallelism

- T0, T1 in parallel with each other and with T2/T3.
- T3 then (T4, T5, T6) in parallel; T6 depends on T3 only.
- T7 depends on T3 and T5. T8 depends on T5, T6, T7.
- Phase D slices run in their own worktrees in dependency order A1 then A2, A3; A4, A5, A6 independent of each other.
- T9 and T10 start once T4 and T0 are done; T11 to T12 follow.

## What is deliberately left out and why

- Electron shell, conversation store, Mission Control embedding: they sit on top of this contract and should not start until the contract has run end to end.
- Multi-agent orchestration: needs `parentRunId`, artifact handoff and a delegation authority model; reserved fields exist so adding it is not a breaking change.
- Other adapters: the conformance suite is the on-ramp.
