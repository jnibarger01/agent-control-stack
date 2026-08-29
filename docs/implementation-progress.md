# ACS autonomous execution control plane progress

## Milestone
Implement the first verified ACS execution path: approved work item -> authoritative attempt/lease/fenced workspace -> sandboxed engine -> independent validation -> durable result/audit -> cleanup, with no automatic merge/deploy.

## Repository findings
- Canonical checkout: `~/projects/agent-control-stack`, branch `feat/webhook-ingress-generic`.
- `SqliteWorkItemStore` already owns execution plans, attempts, attempt leases, workspace allocations, result submission, actor registry, heartbeats, scheduler firings, and audit events.
- `WorkspaceManager` already enforces persisted attempt-scoped allocation ownership and fenced cleanup.
- `packages/sandbox` already owns the `EngineIsolation` process boundary; `packages/engine-adapter` has a Codex adapter and a common `EngineAdapter` interface.
- `apps/worker` currently deliberately stops at dry-run/read-only behavior and must not gain a parallel authority path.
- Existing execution plans are constrained to `dry_run`, `network:none`, local Git, and no push; the first implementation slice must extend these contracts deliberately rather than bypassing them.

## Implementation order
1. **DONE (focused slice)** — execution-controller kernel and attempt lifecycle transition API. SQLite-backed controller test passes; result remains pending independent validation.
2. **DONE (routing slice)** — deterministic actor router plus migration-backed, audited, idempotent routing decisions and reliability counters. Controller selection wiring remains TODO.
3. **DONE (adapter boundary slice)** — common CLI adapter/registry plus Claude/Gemini/Grok/OpenCode/Pi classes through `EngineIsolation`; provider integration and registry wiring remain TODO.
4. **DONE (validation slice)** — independent validator rejects forbidden paths and failed checks; validation runs/checks are migration-backed, audited, idempotent, and controller integration transitions attempts from engine execution to validated success/failure.
5. **IN_PROGRESS (recovery slice)** — bounded retry planner, non-retryable classifications, durable recovery decisions, and startup orphan reconciliation are implemented and tested. Automatic retry-attempt creation, lease-aware cleanup execution, and service startup wiring remain TODO.
6. **DONE (Phase A publication)** — durable publication records, GitHub client boundary, mandatory commit/push, branch ownership, crash retry, concurrent serialization, at-most-one PR behavior, and scheduler integration are verified.
7. **DONE (Phase A acceptance)** — the full scheduler → controller → validation → publication → cleanup E2E passes against a real local Git repository and bare remote; operator health/publication CLI surfaces and repository-wide verification pass.

## Verification
- Execution kernel focused: **47 tests passed** across controller, attempts, workspace manager, and Codex adapter.
- Focused #6/#7 tests: **50 passed**.
- Broader repository tests: **731 passed, 18 skipped** (93 test files passed; 2 integration files skipped).
- AgentOS tests: **48 passed**.
- Public-site safety: **passed**.
- Repository lint: **passed**.
- Repository typecheck: **passed**.

## Exact next action
Wire `reconcileStartup()` into the controller/worker service startup path, expose publication/recovery/validation state in the control UI, and add a real local Git/bare-remote publication E2E covering crash/retry/concurrency and at-most-one PR behavior.


## External review note (independent reviewer, appended, not authored by the implementing agent)
Reviewed the repository state mid-implementation (phase 5 in progress) and applied two small,
isolated fixes on top of the existing work. No other change in this note's scope.

1. **Fixed**: `packages/result-validation/src/index.ts` `expectedArtifacts` containment check had
   inverted boolean logic - `isAbsolute(artifact)` short-circuited the AND, so an *absolute*
   artifact path (e.g. `/etc/shadow`) bypassed the "escapes workspace" check entirely and reached
   `access()` directly. Changed the AND to an OR and renamed `safe` -> `escapesWorkspace`. Added
   3 regression tests (absolute escape, relative `../` traversal, in-workspace success). Verified:
   `npx vitest run packages/result-validation/src/index.test.ts` -> 7/7 passed.
2. **Fixed**: `ExecutionController`'s `validator`/`buildValidationInput` were optional. A
   `"completed"` engine outcome with no validator configured left the attempt permanently stuck in
   `running` - no terminal transition, no audit closure, and (worse) a code path that could treat
   engine exit-code-0 as authoritative if a future caller ever omitted validation. Made both
   fields required in `ExecutionControllerOptions` and rewrote the outcome handling as an
   exhaustive `switch` over `EngineOutcome.status` so every terminal outcome produces exactly one
   attempt transition, with a `never`-typed default case as a compile-time completeness guard.
   Updated the 3 existing tests that omitted a validator (one of them was asserting the bug's
   symptom directly: `status).toBe("running")` after a successful run - now asserts
   `"succeeded"`), and added a dedicated regression test for the dangling-`running` case. Verified:
   `npx vitest run packages/execution-controller/src/index.test.ts` -> 5/5 passed.

Confirmed no other file constructs `ExecutionController` yet (`grep -rl "ExecutionController("`),
so fix 2 has no callers to update. Ran `packages/execution-controller`, `packages/result-validation`,
and `packages/work-items` together afterward: 9 pre-existing failures remain, all in
`work-items/src/concurrency-race.test.ts` and `state-machine.test.ts` (neither touched by these
fixes) - they hardcode the migration-version list at `[1..12]` and are now stale against migrations
13-15 added during this same work session. Not fixed here; flagging for the implementing agent
since it's their migration work the assertions need to catch up to.

Confirmed out of scope for this note, per explicit user sign-off: `packages/procedural-learning`
and the `acs skills` CLI surface are intentional, not scope creep - no action needed. The
`planRecovery()` policy of never auto-retrying a failed independent validation was confirmed as
the intended design - no change needed there either.

Also observed live: `apps/cli/src/dispatch.ts` currently fails typecheck (`status`/`doctor` CLI
command kinds added to `parse.ts` without a matching case in `dispatch.ts`'s exhaustive switch).
This is unrelated to the two fixes above and was mid-edit by the implementing agent at the time of
this review (phase 7 operator-CLI slice); flagging rather than fixing since it's someone else's
active edit.


## External review follow-up: reconcileStartup now inspects real evidence (independent reviewer)
Patched the blocking gap from the previous review note: `packages/recovery/src/startup.ts`
previously hardcoded every `RecoveryInput` field (`validationPresent: false`, `leaseActive: false`,
`leaseExpired: true`, `cleanupComplete: false`) for *every* orphaned workspace, regardless of what
actually happened to that attempt. That meant a crash occurring just after a passing independent
validation would have been silently reclassified as a plain `process_gone` retry candidate -
exactly the double-execution risk the validation-before-success invariant exists to prevent.

Changes:
- Added `SqliteWorkItemStore.getActiveLeaseForAttempt(attemptId)` (most recent lease row for an
  attempt, whatever its status) alongside the existing `getValidationRunForAttempt` and
  `getActiveWorkspaceAllocationForAttempt`, which were already present but never called from
  startup reconciliation.
- `ReconciliationStore` in `startup.ts` now requires all three lookups; `reconcileStartup` builds
  `leaseActive`/`leaseExpired`/`validationPresent`/`validationPassed`/`cleanupComplete` from real
  store data per orphan instead of constants. `processAlive: false` remains a hardcoded input - a
  fresh process at startup genuinely cannot have a live child from a prior run, so that one is a
  legitimate assumption, not evidence to look up.
- `cleanupComplete` fails closed on missing evidence: it is only `true` when the store positively
  confirms a non-active allocation, never merely because no allocation record was found.
- Added 3 tests to `packages/recovery/src/startup.test.ts` (validated-success is not retried;
  validated-failure terminates instead of retrying; idempotency key is stable across repeated runs
  for the same attempt) and 2 tests to `packages/work-items/src/recovery.test.ts` proving
  `getActiveLeaseForAttempt` against a real SQLite-backed lease (undefined when none issued;
  returns the real lease when one exists).

Verified: `npx vitest run packages/recovery packages/work-items/src/recovery.test.ts` -> 11/11
passed. `npx tsc -b` and `npx eslint packages/recovery packages/work-items --max-warnings=0` ->
both clean. Confirmed no other file imports `reconcileStartup`/`ReconciliationStore` yet
(`grep -rl`), so this had no external callers to update.

Everything else flagged as "done and can stay as-is" in the prior review (backoff formula,
non-retryable failure classes, `recordRecoveryDecision`/`getRecoveryDecisionForAttempt`
idempotency and audit wiring) was not touched.

## Review note: phase 6 publication + phase 7 doctor fix (reviewer pass)

Reviewed phase 6 (publication) and phase 7 (operator/runtime CLI) against the master
plan. Found and patched a real "bad outcome" gap: `publishValidatedAttempt` resolved
`git rev-parse HEAD` against whatever the pre-existing HEAD happened to be, with commit
and push either entirely absent or gated behind an easy-to-forget opt-in flag. A real
`PullRequestClient` (already wired into `packages/publication/src/github.ts` by the other
agent in parallel) would have opened/updated PRs referencing unpushed or stale content.

Patched `packages/publication/src/index.ts`:
- Branch-ownership check: `input.branch` must equal `acs/attempt/${attemptId}` (the
  convention `WorkspaceManager` already checks out branches under, confirmed via
  `packages/workspace-manager/src/index.ts:173`). Fails closed before any git call.
- Commit + push are now mandatory, not opt-in: `git add -A` -> verify non-empty staged
  diff (`git diff --cached --name-only`) -> `git diff --cached --check` -> `git commit`
  with an explicit bot author identity -> `git rev-parse HEAD` for the real new SHA ->
  re-check `leaseIsCurrent()` immediately before the push -> `git push --set-upstream
  <remote> HEAD:refs/heads/<branch>`.
- "No staged changes after `git add -A`" is now a hard failure, not a silent no-op.

Added 6 tests to `packages/publication/src/index.test.ts` (9 total, all real assertions
against a recording `gitRunner`, no network/process spawned): branch-ownership rejection
before any git call, no-staged-changes rejection, commit+push actually happening in the
right order (commit strictly before push, push strictly before `createOrUpdate`) with the
real `rev-parse` SHA flowing through to both the PR client call and the stored record,
`git commit` failure surfaced, `git push` failure surfaced without opening a PR, and the
pre-push lease recheck refusing to push once the lease goes stale mid-flight.

Fixed `apps/cli/src/dispatch.ts`'s `doctor` case: it was ignoring `command.json` entirely
and always printing raw JSON, inconsistent with `status`'s `--json`/text split (same
parser, `parseStatusArgs`, backs both commands). Added `describe("status")` /
`describe("doctor")` blocks to `apps/cli/src/dispatch.test.ts` (8 new tests) covering both
commands with and without `--json` and both healthy/unhealthy exit codes — this command
pair had zero prior test coverage.

Verification: `npx tsc -b` clean repo-wide; `npx eslint packages/publication apps/cli
--max-warnings=0` clean; `npx vitest run packages/publication apps/cli` — 5 files, 37/37
passing; `grep -rn "commitAndPush|publishValidatedAttempt"` outside
`packages/publication/src/` — only a stale `dist/*.d.ts` reference, zero live external
callers, so this had zero blast radius outside the two files touched.

Confirmed scope question with Jace: `packages/work-items/src/publication.ts`'s
`UNIQUE INDEX ... ON publication_records(work_item_id)`, combined with
`publishValidatedAttempt`'s idempotency short-circuit, means `github.createOrUpdate` is
called at most once ever per work item, even across re-attempts. Confirmed: this is the
intended permanent design (one PR per work item, forever; a materially different result
should be a new work item, not a silent PR mutation). No code change needed for this —
documenting the decision here since it wasn't obvious from the code alone.

Not touched: `packages/work-items/src/publication.ts`,
`storage/migrations/016_publication_records.sql`, `packages/publication/src/github.ts` —
all active, in-progress work by the other agent, out of this review's patch scope.
