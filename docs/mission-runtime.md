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
tokens and spend. Limits are written once (trigger-enforced); a missing limit means uncapped, never zero. ACS measures
work units, parallelism, retries, depth, children and wall clock from durable rows, inside the same transaction as the
action. Tool calls, tokens and spend are worker-reported: a capped metric that was never reported is returned as
`unaccounted`, not as zero. A refusal is an explicit `{ ok: false, outcome: "budget_exhausted", decision }` result and
a `budget.exhausted` event. `DEFAULT_DELEGATION_BUDGET` (depth 2, parallel 4, children 8, retries 2) applies only when a
mission asks for it, and policy can override any value.

## Cancellation

`cancelMission` moves the mission to `CANCELLED` and every unfinished unit to `cancelled` in one transaction. Units that
may have started external work are marked `cancel_external_state = 'uncertain'` and returned in `uncertain`: cancellation
never claims side effects were rolled back. Claim tokens are kept, so a late result from the old worker fails on status.

## Worker contract (`packages/mission-worker`)

Every executor is wrapped behind one `MissionWorker` shape: `prepare`, `execute`, `observe`, optional `checkpoint`,
`cancel`, optional `resume`, and `report`. A worker only produces **evidence**; ACS decides what it means.

- **Claim binding.** `runClaimedUnit` checks the persisted row (status `running`, claim token, worker id, unit kind)
  before `prepare` runs. A worker that does not hold the claim never executes.
- **Report ingestion under the fence.** `ingestReport` stores the report as durable evidence (token hash only, never
  the token), then applies it with the claim token. A report from a stale, cancelled or superseded attempt is stored as
  `rejected_stale` evidence and changes nothing. A report whose claim hash does not match is `rejected_invalid`.
- **Verification is not self-assessed.** A success report for a unit whose `verification_policy` is not `none` moves it
  to `verifying`, never `succeeded`. The worker's `selfAssessment` is evidence only.
- **Retry safety.** A failure is `retryable` only if the worker says no external side effect was possible **and** it
  did not report `externalStateUncertain`. `retrySafe` defaults to false. An `unknown` outcome, or a worker that cannot
  produce a report, marks the unit `unknown`, which `retryUnit` refuses.
- **Normalized failures.** `FAILURE_CATEGORIES` with the worker's scrubbed native code/message kept beside it.
  A policy refusal always classifies as `policy_denied`, even if it mentions a lease.
- **Checkpoint / resume.** A checkpoint (`stateRef` hash, completed actions, hint) is evidence in `coding_evidence`; the
  unit parks as `checkpointed`. `resumeCheckpointedUnit` replaces the claim token (fencing the old worker), counts the
  resume against the retry cap, and passes `reobserveBeforeActing: true`. A checkpoint is never proof that external
  state is unchanged.

Wrappers (existing adapters are unchanged):

| Wrapper                    | Wraps                                 | Checkpoint | Notes                                                                                                |
| -------------------------- | ------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------- |
| `EngineMissionWorker`      | `EngineAdapter` (sandboxed agent CLI) | no         | Opaque process: failures are `externalStateUncertain`; files changed are reported as not enumerated. |
| `MachineToolMissionWorker` | `MachineController.callTool`          | no         | Binds tool name and argument hash to the unit; only read-only tools are ever declared retry-safe.    |
| `CoderPortMissionWorker`   | coding-mission `coder` port           | no         | `unknown` stays `unknown`; `conflict` becomes `environment_changed`.                                 |

Cancellation is propagated as an `AbortSignal` plus `worker.cancel`. `MachineController.callTool` and the coder port
are not abortable, so for them cancellation is best effort and is reported with the uncertainty it implies.

## Not yet in this runtime

Mission authority envelopes and narrowed child authority, wrappers for Desktop Commander, ACP and the Jace Commander
lane, enriched route decisions, the verification gate, `request_child_work`, CUA, and recovery policy are separate slices. Today the
legacy coding path has no budget row (uncapped) and the `general` kind has no driver of its own.
