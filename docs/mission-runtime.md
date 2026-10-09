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

## Mission authority and child work (migration 060)

A mission's authority is the existing human-issued `AutonomousAuthorityDefinition` (migration 047). The subset test is
`authorityNarrowingViolations` in `packages/work-items`; `authority.ts` adds only mission policy on top of it
(`allowPrivilegedChildren`, `deniedPrivileges`, `maxChildTtlMs`):

```text
child = parent ∩ mission policy ∩ requested
```

**Binding a mission.** `MissionAuthorityLedger.grantMissionAuthority` takes a `grantId`, not an approver. It loads the
grant from the control plane (`GrantReader`, satisfied by `SqliteWorkItemStore`) and refuses it unless it exists, names
this mission, recomputes to its own `grantHash`, and is unexpired. The approver and reason recorded are the grant's
(`issuedByActorId`, `reason`), never caller assertions. Allowing privileged children additionally needs an authenticated
operator (`verifyOperator`). Refusals are committed as `authority.denied` evidence before the error is thrown. The
binding is write-once. A mission without a binding cannot create child work.

**Fail closed on read.** Every read re-verifies: the stored definition must parse and recompute to its hash, the live grant
must still match the stored grant hash and definition, and a derived unit's definition must be a subset of its parent's
(checked at the instant it was created) and bound to the parent hash and grant it claims. Any mismatch is
`authority_integrity`, and the request is denied. The tables are append-only including against `INSERT OR REPLACE`
(SQLite resolves that by deleting the old row without firing DELETE triggers, so each table also has a BEFORE INSERT guard).

**`requestChildWork`** is the only way to create subordinate work. It needs the parent's live claim (token and worker id),
takes time from the ledger's injected ACS clock (a request cannot supply one), and is all-or-nothing in one IMMEDIATE
transaction together with the depth, total-children, unit and parallel caps, so racing agents yield one winner and a
restart does not reset the caps.

- A child that _asks_ for more than its parent holds is **denied with reasons** (`escalation:…`), never trimmed, and
  recorded as `child.denied` / `authority.denied`. With no request, a child inherits the parent minus privileged privileges.
- Privileged privileges (`process.privileged`, `service.control`, `deploy`, `remote`, `secret.read`) are never inherited
  by default. A child gets one only if the parent holds it **and** mission policy allows privileged children.
- A child never outlives its parent and is further bounded by `maxChildTtlMs`. A grandchild derives from its parent's
  definition, not the mission's.
- A derived unit with no authority row is **denied**, never treated as a root, so a unit created outside
  `requestChildWork` cannot hand its descendants the whole mission authority.
- A requested child budget is validated on every dimension with the canonical budget conversion and may only ask for
  less than the mission budget. It is recorded; per-child enforcement beyond the mission-wide caps is not implemented.
- Invalid payloads, missing dependencies and cycles become durable `child.denied` evidence. Denial reasons that echo
  caller input are redacted and bounded first, and `child.requested` / `child.admitted` record the verified requester
  (worker, parent attempt, a fence hash, never the claim token).

**Cancellation and reduction.** `cancelChildren` cancels a unit's descendants and reports in-flight ones as uncertain; it
requires the parent's live claim or an authenticated operator, so a stale worker cannot cancel work owned by a newer
claimant. `reduceChildren` (`all_succeeded`, `select`, `majority_result`) is deterministic (ordered by child id, not finish
time), writes nothing while a child is unfinished, treats a tie as `inconclusive`, and is recorded once.

## Not yet in this runtime

- Consulting `unitAuthority` when a worker is dispatched. Until then authority is a verified, tamper-evident ledger of
  what each unit may do, not an enforcement point at dispatch. Production composition roots that construct the ledger
  with the real grant store and operator verification are also not wired yet.
- Checkpoint/resume as worker adapters on the execution ledger, the CUA worker, and recovery policy.
- A driver for the `general` mission kind. The legacy coding path has no budget row (uncapped).
- Delegating to a different executing actor (`authorityNarrowingViolations` refuses it deliberately and it needs its own decision).

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
