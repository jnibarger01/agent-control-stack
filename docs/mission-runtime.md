# Mission runtime

One durable runtime drives every mission. It is the existing coding mission store (`packages/coding-mission`,
migration 049) generalized in place by migration 054. There is no second mission engine and no `_v2` table.

## Model

- **Mission** (`coding_missions`): a version-guarded record. `mission_kind` is `coding` (the existing profile, driven
  by `CodingMissionController`) or `general` (created in `CREATED`, driven by whatever owns it). Coding-profile columns
  (`repository`, `base_ref`, ...) are required by the table and hold `''` for `general` missions.
- **Work unit** (`coding_operations`): the successor to a coding operation. `unit_kind` is one of `planning`,
  `coding`, `shell`, `tool`, `desktop`, `cua`, `verification`, `agent`, `swarm`, `recovery`. Each kind has a typed
  payload (`parseWorkUnitPayload`); unknown fields are rejected so a payload cannot carry authority.
- **Dependencies**: `depends_on` (all must have `succeeded` before a claim) and `parent_unit_id`/`depth` for child work.
- **Budget** (`mission_budgets`, `mission_budget_usage`): see below.
- **Events**: `coding_events` carries the structured stream (`mission.created`, `mission.state_changed`,
  `work_unit.created|ready|claimed|completed|failed|cancelled|retry_scheduled`, `budget.set|threshold_reached|exhausted`).
  Coding-profile events keep their `coding_mission.*` names.

## States

Mission: `CREATED PLANNING READY RUNNING WAITING_FOR_DEPENDENCY WAITING_FOR_APPROVAL VERIFYING RECOVERING COMPLETED FAILED CANCELLED`,
plus the coding phases `RECONCILING VALIDATING PREPARING_CHANGE_SET PUBLISHING_PROPOSAL APPROVED EXECUTING DEGRADED`.
`general` missions follow an explicit transition table; coding missions keep the controller's ordering. For both,
`COMPLETED`, `FAILED` and `CANCELLED` are terminal, `CANCELLED` is reachable from anywhere else, and every transition is a
version-guarded `UPDATE`. An illegal transition throws and changes nothing.

Work unit: `pending ready claimed running checkpointed verifying succeeded failed retryable cancelled`, plus the
coding outcomes `conflict` and `unknown`. `succeeded` and `cancelled` are terminal.

## Claims, retries, failure

A claim is one `UPDATE ... WHERE status IN ('pending','ready')` inside an IMMEDIATE transaction that also checks mission
activity, dependency satisfaction and budgets, then bumps `attempt` and stores a fresh claim token. Every later write
(`completeOperation`, `failUnit`) must present that token, so a stale or wrong worker is rejected. `failUnit` records a
normalized `failure_category`; `policy_denied`, `authority_expired`, `retry_budget_exhausted` and `cancelled` can never
be retried. `retryUnit` refuses `unknown`/`conflict` units (their external effect is unproven) and refuses past the retry cap.

## Budgets

`MissionBudget` caps wall clock, tool calls, work units, parallel units, retries per unit, child depth, child units,
tokens and spend. Limits must be non-negative safe integers in their stored units; dollar amounts are validated
before conversion to micro-dollars. Limits are written once (trigger-enforced); a missing limit means uncapped, never
zero. ACS measures work units, parallelism, retries, depth, children and wall clock from durable rows, inside the same
transaction as the action. Tool calls, tokens and spend are worker-reported: a capped metric that was never reported is returned as
`unaccounted`, not as zero. A refusal is an explicit `{ ok: false, outcome: "budget_exhausted", decision }` result and
a `budget.exhausted` event. `DEFAULT_DELEGATION_BUDGET` (depth 2, parallel 4, children 8, retries 2) applies only when a
mission asks for it, and policy can override any value.

## Cancellation

`cancelMission` moves the mission to `CANCELLED` and every unfinished unit to `cancelled` in one transaction. Units that
may have started external work are marked `cancel_external_state = 'uncertain'` and returned in `uncertain`: cancellation
never claims side effects were rolled back. Claim tokens are kept, so a late result from the old worker fails on status.

## Unified execution contract (PR3)

Mission work now has a transport-neutral execution boundary in `worker-execution.ts`.

- `DispatchEnvelope` binds mission, work unit, durable unit attempt, worker, executor lane, payload/route hashes, verification policy, and ACS authority references. The raw claim token never enters the durable attempt tables; only its stable hash is persisted.
- Migration 055 adds `work_unit_execution_attempts` and `work_unit_execution_receipts`. One durable execution attempt is allowed per mission/unit attempt, so restart/replay can distinguish never-dispatched, started, completed, failed, cancelled, unknown, and stale execution.
- `ResultEnvelope` normalizes success, failure, cancellation and unknown outcomes plus receipts and normalized failure categories. Applying a result re-checks the live claim, worker and unit-attempt fence in the same transaction that advances the work unit.
- A stale result is retained as `rejected_stale` evidence and cannot overwrite a cancelled or superseded work unit. An unknown external outcome stays `unknown` and cannot be blindly retried.
- Successful execution does not bypass verification: any work unit whose verification policy is not `none` moves to `verifying`; the executor is not its own verifier.
- `CoderExecutionAdapter` normalizes the existing coding port. `ToolLaneExecutionAdapter` is the thin result-normalization facade for already-authorized Jace Commander, Desktop Commander and MCP composition roots. It does not authorize calls, mint capabilities, widen scopes, or bypass their existing lease/fencing checks.

The execution contract deliberately does **not** add swarm delegation or CUA. Those future executors must enter through the same dispatch/result/receipt boundary.

## Not yet in this runtime

Checkpoint/resume, CUA, recovery policy and any HTTP or MCP route for `request_child_work` are separate slices. Today
the legacy coding path has no budget row (uncapped) and the `general` kind has no driver of its own.

## Child work and per-unit authority

`request_child_work` is `CodingMissionStore.requestChildWork`. An agent asks; ACS decides. Nothing is spawned by the
agent and no authority is minted by it.

**Authority model (migration 060, `work_unit_authority`).** One immutable, append-only row per unit that carries
authority. A `root` row binds a top-level, unclaimed unit to a human-issued autonomous authority grant (migration 047) and
can only be written by `bindRootAuthority`, an operator-side call that re-verifies the grant (hash, audit event, expiry,
revocation), requires the grant to be issued for the same mission id, refuses self-binding, and refuses a unit that has
already been claimed. A `child` row is written only by `requestChildWork`, stores the narrowed definition, its parent row,
the shared root grant and the requester's claim evidence (worker, attempt, a hash of the claim token; the raw token is never
stored). Triggers make rows immutable, require a child to chain to a parent row in the same mission and root grant, and
refuse a child that outlives its parent. Agent-requested work therefore cannot create or widen a root.

**Admission, in one `BEGIN IMMEDIATE` transaction:**

1. mission active; the parent holds a live claim (token compared in constant time, worker matches, attempt matches the fence);
2. an identical retry of a `requestId` replays; a changed request under the same id is `request_conflict`;
3. the parent's persisted authority verifies: intact hash, every ancestor unexpired, root grant live, and the requester is
   the actor that authority names;
4. the requested authority is a subset of the parent's (`authority-narrowing.ts`). A broader request is `authority_escalation`
   and is never trimmed;
5. depth, total children, live parallel children and unit totals stay inside the caps. Limits come from the mission budget;
   where a mission budget leaves a delegation limit unset, fallback caps apply (depth 2, parallel 4, children 8), so
   delegation is never uncapped. A refusal is an explicit `budget_exhausted` outcome plus `budget.exhausted` and
   `child.denied` events;
6. only then are the child unit and its authority row written together.

Every denial returns an explicit outcome and records a `child.denied` event. Nothing is written on denial.

**Cross-actor execution.** A child may name a different executing actor only with an explicit `assignedActorId` equal to
that actor. That actor must claim the child itself: `claimUnit` verifies, against the child's own persisted row, that the
claimant is the assigned actor, every authority up the chain is unexpired and the root grant is live. The executing actor
never inherits the parent's permissions: a grandchild request from it is checked against the child's narrowed authority.

**Governed missions.** A mission with any persisted unit authority is governed. In it every claim must verify, and
`addWorkUnits` refuses a direct child (`child_work_requires_request`). Missions with no authority rows behave exactly as before.

**Admin mode.** Nothing in this path reads execution mode or admin mode (a test pins that), so admin mode cannot
override authority scope, claim or fence checks.

Status: implemented and tested locally at store level, including a multi-process race (distinct requests for the last
slots, and an identical request racing itself) and a restart test. No gateway or MCP route calls it yet, so no agent can
reach it today. A root grant must have been issued for the same mission id as the coding mission; a mapping from other
ids is not built.

## Child authority narrowing

`authority-narrowing.ts` in `packages/work-items` is the pure subset check used above:
`authorityNarrowingViolations(parent, child, now, { allowActorChange })` lists every dimension on which a requested
definition is broader than its parent (scope, tool classes, privileges, expiry, limits, manifest pin; actor unless the
caller opts in). `assertAuthorityNarrowed` throws `authority_escalation`, or `authority_expired` for an expired parent.

## Verification gate

A successful execution never completes a unit whose verification policy is not `none`. The unit parks in
`verifying` and only `WorkUnitVerificationGate` (`verification-gate.ts`) owns the verified completion transition.
Verification criteria are admitted before the first execution attempt and persisted immutably by migration 057.
A first claim is refused when a non-`none` policy has no rubric. Verified dispatch also requires the actual implementer
engine/provider identity, which is persisted separately from the worker owner id. Databases upgraded with already
in-flight verified units are quarantined fail-closed; admitting a rubric explicitly resets only that quarantined unit
for a fresh attempt. Terminal units (`succeeded`, `cancelled`) are not in flight: migration 059 restores any terminal
unit that 057 rewrote to `failed`, provided it is unchanged since 057. It also drops that unit's quarantine row and
records a `verification.migration_057_terminal_restored` event.

The gate derives the implementer engine identity from the hashed durable dispatch. It recomputes `dispatch_hash` from
`dispatch_json` and requires the dispatch's attempt, worker, lane, claim and engine bindings to match the attempt row
before any verifier runs. A relabelled `implementer_engine_id` column therefore fails closed instead of enabling
self-verification.

The gate derives the unit attempt, implementer engine identity, execution-attempt id, result hash, execution-report hash,
and verifier evidence from durable execution state. Verifier evidence is reconstructed from the persisted result and
receipt hashes; callers cannot substitute diff text, command output, or an implementer claim after seeing the result.
`lightweight` and `independent` need one verifier; `multi_verifier` needs two distinct verifiers and every required
verdict must pass; `release_gate` failure is terminal rather than auto-retryable. A failure records the actual resulting
lifecycle state (`retryable` or `failed`), while an inconclusive verdict or verifier error holds the unit in
`verifying`. Each verification invocation has a distinct durable run id, so an inconclusive run can be retried without
rewriting its history. A decisive failure stops further verifier calls and remains decisive even if accounting discovers
that the provider exceeded its reserved budget.

Migration 057 also records attempt-bound verification decisions and atomic verifier-usage reservations. Active
reservations count against mission limits before a provider call starts, preventing concurrent verifiers from
oversubscribing the same token/spend/tool-call budget. Reservations reconcile to observed usage afterward; unknown capped
usage is conservatively charged at the reserved amount. Durable decision payloads retain bounded redacted summaries and
hashes instead of unrestricted command stdout/stderr. Missing verification authority, stale verdicts, and budget refusals
are auditable fail-closed outcomes. The final decision timestamp is sampled after verifier execution, and the ACS
transaction that persists the decision is the same transaction that advances the work-unit state.
