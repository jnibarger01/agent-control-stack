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

**Fail closed on read.** Every read re-verifies: the stored definition must parse and recompute to its hash, the mission
policy (which is not part of the grant) must match its own fingerprint, the live grant must still match the stored grant
hash and definition, and a derived unit's definition must be a subset of its parent's (checked at the instant it was
created) and bound to the parent hash and grant it claims. A derived unit whose parent has no authority row is accepted
only if that parent is a verified root; a missing intermediate record is corruption, not a root. Each `requestChildWork`
also rechecks that the backing grant has not been revoked (through the canonical revocation reader, which checks the projection
against its audit event; a mismatch counts as revoked) and that the mission's execution inputs still hash to the
grant's `subjectInputHash` (`GrantReader.currentSubjectInputHash`; unavailable means refused), and that the claimant resolves (`resolveActor`) to the actor
the grant was issued to, since a valid claim alone does not say the worker may exercise this authority. Any mismatch is
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
- The parent's `maxOperations` and `maxParallelOperations` are **shared** by its children, not copied into each: explicit
  requests are charged first, children that inherit split what is left, and a request that would push the aggregate past
  the parent is denied (`parent_limit_exhausted`). A cancelled child frees its share.
- A parent's claim only counts as live for `claimTtlMs` (default 5 minutes) after it was taken, so an owner the controller
  would already recover cannot keep creating, cancelling or reducing children. Mission policy is validated strictly
  (known privileges, bounded integer TTL, no unknown fields) before it is persisted. `verificationPolicy` and titles are
  validated before insertion so a bad value is a durable denial, not a database error.
- Children are bound to the parent's claim by a non-reusable fence (a hash of the claim token), not by attempt number,
  because attempt numbers repeat after a released claim. When the parent is retried or its claim released, the children its previous claim admitted through
  `requestChildWork` are marked superseded (`work_unit_child_supersessions`) and their unfinished descendants are
  cancelled (in-flight ones as uncertain). A superseded child that already succeeded stays as history but neither the
  reducer nor the completion guard counts it, so the new claim is not stuck behind it. Units added directly, without an
  authority row, belong to no claim and are left alone. Once a reduction is recorded no more children are admitted. A unit with authority-managed children
  cannot move to `succeeded` or `verifying` until they are reduced; that guard is a trigger on the table, so it covers the
  execution ledger and the verification gate as well as the legacy store. Plain parent/child units that were not admitted
  through `requestChildWork` are not reducible and are not gated.
- A child never outlives its parent and is further bounded by `maxChildTtlMs`. A grandchild derives from its parent's
  definition, not the mission's.
- Untyped input is shape-checked before anything is used: ids and enums must be strings, dependencies a string array,
  and a malformed child is a durable denial. A request naming a mission that does not exist writes nothing. An explicitly
  requested authority that is already expired is denied, and reductions are refused once the mission is terminal.
- A derived unit with no authority row is **denied**, never treated as a root, so a unit created outside
  `requestChildWork` cannot hand its descendants the whole mission authority.
- A requested child budget is validated on every dimension with the canonical budget conversion and may only ask for
  less than the mission budget. It is recorded; per-child enforcement beyond the mission-wide caps is not implemented.
- Invalid payloads, missing dependencies and cycles become durable `child.denied` evidence. Denial reasons that echo
  caller input are redacted and bounded first, and `child.requested` / `child.admitted` record the verified requester
  (worker, parent attempt, a fence hash, never the claim token).

**Cancellation and reduction.** `cancelChildren` cancels a unit's descendants, including failed ones a retry could still
revive (only final failures such as `policy_denied` are left), and reports in-flight ones as uncertain. `reduceChildren`
(`all_succeeded`, `select`, `majority_result`) is deterministic (ordered by child id, not finish time), treats a tie as
`inconclusive`, and is recorded once with an integrity fingerprint that is verified before a stored reduction is returned.
The request is validated before the write-once mutation: an unknown strategy, or `select` without the id of a
succeeded child, is rejected and nothing is recorded. It waits for any child still parked as `retryable`, and once recorded `retryUnit` refuses further retries beneath that
parent, so the append-only result cannot go stale. Both operations require the parent's live claim or an authenticated
operator, so a stale worker cannot cancel or decide for work owned by a newer claimant; refusals are durable
`authority.denied` evidence, and `child.reduced` records the selected child and result hash.

## Dispatch authority gate

`WorkUnitExecutionLedger.beginDispatch` is the one place every executor lane passes before a worker runs a unit, and it
is where authority is enforced. A mission with a persisted `mission_authority` binding is **governed**:

- The ledger needs a `DispatchAuthorityVerifier` (`MissionAuthorityLedger.verifyDispatch` implements it). A governed
  mission dispatched with no verifier is refused (`authority_verifier_unavailable`), never run unchecked.
- The verifier reads durable state and ACS's clock and refuses anything it cannot prove: mission not active, no unit
  authority for a derived unit (a unit created outside `request_child_work` is never promoted to the mission's
  authority), a unit superseded by a newer parent claim, a revoked grant, execution inputs that no longer match what the
  grant approved, an expired authority, a worker that does not resolve to the actor the authority was issued to, an
  attempt beyond the authority's `maxAttemptsPerOperation`, and a `jc`/`dc` lane whose tool runtime the authority does
  not grant.
- A caller-supplied `authority.grantId` that is not the verified one is refused (`authority_ref_mismatch`). On success
  the envelope's `authority` carries the verified `grantId` and the hash of the unit's derived authority
  (`unitAuthorityHash`), so what a worker ran under is bound into the dispatch hash.
- The check runs before the replay path, so a resumed dispatch after revocation or expiry is refused too.
- A refusal throws `dispatch_authority_denied` after the transaction commits an `authority.denied` event
  (`operation: "dispatch"`) and writes no execution attempt.
- A mission with no authority binding dispatches exactly as before.

Lane and tool authorization is exact. Every lane maps to a runtime the authority can grant: `dc` to `desktop_commander`,
`jc` to `jace_commander`, `coder` to `sandbox`. The `mcp` lane maps to none, because the authority schema cannot express an
MCP tool, so it is never authorized for a governed mission. A unit whose payload names a specific tool (`kind: "tool"`) may
only run it if that exact runtime and tool pair is granted; a broad runtime grant does not cover a tool nobody listed.

A governed dispatch carries a **deadline** set by ACS: the earlier of the dispatch time plus the authority's `maxRuntimeMs`
and the authority's expiry. A caller-supplied deadline is ignored. The controller races the executor against it, aborts the
executor's `AbortSignal`, and records the outcome as uncertain (never as a retry-safe failure). Independently,
`applyResult` judges a result against the deadline on ACS's own clock: one that arrives late is recorded as `unknown`
whatever finish time the worker reports. `claimUnit` itself does not consult authority; the gate is at dispatch.

## Production entry point

`CodingMissionController` is the production caller of `createGovernedExecution`. With `ports.governance = { mode: "enforce" }`
(the gateway sets this when `ACS_CODING_MISSION_GOVERNED=1`; it is off by default) the controller:

- **Takes identity from the control plane, never from the worker.** An operator is a registered `HUMAN` actor
  (`isHumanOperator`). A worker acts as the actor `resolveVerifiedWorkerActor` returns: exactly one `AGENT` or `SERVICE`
  actor with `externalRef` `worker:<workerId>`, whose latest `actor.registered` audit event matches its row and names a
  `HUMAN` registrar. `POST /actors` is open to any mutation credential and overwrites an existing actor, so a row in `actors`
  alone proves nothing; a binding made by, or overwritten by, a non-human does not resolve. The grant's executing actor must
  equal the resolved actor: delegating to a different actor stays refused.
- **Does not start a mission nobody gave authority to.** With no binding it waits (`authority_required`): nothing is claimed,
  nothing runs, nothing is degraded. An operator binds a grant with `POST /coding-missions/:id/authority`.
- **Verifies audit integrity before opening the dispatch transaction**, so a full-chain verification does not hold the write
  lock; a chain that does not verify refuses the dispatch (`audit_integrity_failed`).
- **Runs the gate between claim and execute.** A denial returns the unit to `pending` (it never ran), records
  `authority.denied`, and degrades the mission with `dispatch_authority_denied`. Binding is write-once, so a mission whose
  grant was revoked or expired stays stopped; it needs a new mission.
- **Completes through the ledger.** Success completes the unit; a failure or retryable outcome degrades the mission for an
  operator (`reconciliation_required` if the environment changed, else `operation_failed`); an uncertain outcome is handled
  by the existing recovery path, which escalates unless the executor can fence the old run or declares itself idempotent.

Grants must be issued under the same id as the coding mission, and the work item with that id must be non-terminal.

Cost note: `assertAuditChainIntegrity` re-verifies the whole audit chain when another connection has written (or every 30s).
Each governed dispatch therefore costs a chain verification in the worst case. This has not been measured on a large
production database.

## Not yet in this runtime

- Governed execution is implemented and tested end to end, but it is **off by default** and has not been enabled or deployed
  anywhere. Turning it on is an operational action (`ACS_CODING_MISSION_GOVERNED=1`, plus operator-bound worker actors and a
  grant per mission).
- The `jc` and `mcp` lanes have no executor adapter that enforces its own authority yet, so they are not runnable. The `dc`
  lane has a boundary adapter for four read-only tools (see "Desktop Commander lane") and the general-mission `coding` unit
  has an execution contract, a boundary adapter and a bounded driver (see "General-mission coding units"). Neither has a
  concrete executor/invoker behind its port, there is no `dc` driver, and no worker, gateway route or CLI constructs a
  driver, so nothing runs a general mission in production.
- Checkpoint/resume as worker adapters on the execution ledger, the CUA worker, and recovery policy.
- The legacy coding path has no budget row (uncapped).
- Delegating to a different executing actor (`authorityNarrowingViolations` refuses it deliberately and it needs its own decision).

## Unit runner

`GovernedUnitRunner.runUnit({ missionId, unitId, workerId, lane })` (`unit-runner.ts`) runs one **general-mission** work unit
end to end: it claims the unit, dispatches it through the governed root, runs the lane's `WorkUnitExecutorAdapter` and applies
the result. (The coding-mission controller has its own governed path; see "Production entry point" above.) A lane with no
adapter is refused before anything is claimed. If authority refuses the dispatch, the refusal is already durable, no attempt
exists, no adapter runs, and the claimed unit is failed as `policy_denied` (non-retryable) instead of being left running;
reopening it takes an explicit retry. An expired authority is recorded as `authority_expired` and any other refusal as
`policy_denied`. This differs from the controller, which returns the unit to `pending` and degrades the mission. Any other
failure of the dispatch (for example a verified unit with no implementer identity) happens before anything ran, so the claim
is released and the error rethrown instead of leaving the unit in `running`. A unit with a verification policy needs
`implementerEngineId` in the runner options; the runner never invents one.

The executor is raced against the deadline ACS set on the dispatch. At the deadline it is signalled to stop, ACS stops waiting,
and the outcome is recorded as `unknown` with the external state marked uncertain, as in the controller. A governed dispatch
(one that names a grant) with no deadline fails closed and never calls the executor; a mission with no authority binding has no
deadline and runs as before. An adapter that throws becomes a failed result with the external state marked uncertain, and its message is redacted
before it is persisted. A "succeeded" result without a non-empty result hash and a list of string files is converted to a
failed `invalid_output` result, because the ledger itself only checks that a result object exists. Of two
concurrent runs of one unit, one executes and the other reports `claim_conflict`. A crash between the claim and the dispatch
leaves a running claim that existing stale-claim recovery handles; the runner adds no recovery of its own.

## General-mission coding units

A coding unit in a `general` mission is one explicit, repository-scoped task, not a coding mission. It does not inherit a
mission branch, pull request or merge lifecycle; that stays with `CodingMissionController` and its governed path, which this
section does not change. The task is the typed `coding` payload (`general-coding.ts`, `parseGeneralCodingTask`): a canonical
absolute `repository`, an immutable 40-hex `baseSha` (a branch name is rejected), `instructions`, the declared `files`
(normal repository-relative paths), `maxRuntimeMs` and `maxFiles`. The generic payload parser keeps these optional so legacy
coding payloads still parse; the strict parser requires all of them and is what the driver and adapter use.

`GeneralCodingExecutionAdapter` (`general-coding-adapter.ts`, coder lane) enforces authority where the work happens, not only
at dispatch. `GovernedUnitRunner` hands every adapter the live claim, and the adapter checks, before the executor is called and
failing closed: the claim token matches the dispatch and is still the unit's live claim for the same worker; the dispatch gate
still passes on current durable state (so a revocation, expiry or changed grant between dispatch and execution is caught) over
the same authority hash; the unit's stored payload is a complete task; the authority grants the `sandbox` runtime; the
repository lies inside a scope resource (descendant containment, not a path prefix); and the task's runtime bound does not
exceed the authority's. A refusal records a failed attempt with a `nativeCode` naming the reason and marks the external state
certain (nothing ran). After the executor runs, a success is accepted only if it attests the same `baseSha`, a non-empty result
hash, at most `maxFiles` normal relative paths, each equal to or under a declared path; otherwise the attempt is
`invalid_output` with the state marked uncertain, because the work did run. The executor is stopped at the task's own bound,
capped by the time left on the dispatch, and a timeout is `unknown`.

`runGeneralCodingUnits` (`general-coding-driver.ts`) is the bounded driver: one sequential pass over active governed `general`
missions, coder lane and coding units only, at most `maxUnits` (default 1, ceiling 10) units started per pass. A unit without a
complete task contract is reported as skipped and never claimed. The driver and adapter take the executor as a port
(`GeneralCodingExecutor`); symlink and filesystem containment inside the repository is that executor's responsibility. No
executor, worker hook or gateway route is included.

## Desktop Commander lane

`DcLaneExecutionAdapter` (`dc-lane-adapter.ts`, `dc` lane) runs a `tool` unit under the same execution-boundary discipline as
the coding adapter, with its own tool-name authority. The shared checks live in `execution-boundary.ts` and both adapters use
them: the live claim (token hash, store row, worker, unit kind, status), the dispatch gate re-verified on current durable
state over the same authority hash, containment on physical paths (symlinks resolved; a sibling sharing a prefix is outside),
and a runtime budget that never starts the invoker when no time is left.

The unit's input is the typed call in `dc-tool-call.ts`: `toolName`, complete `arguments`, `argsHash` (bound to the tool name,
so arguments cannot be replayed under another tool) and `maxRuntimeMs`. The generic payload parser keeps the new fields
optional so legacy tool payloads still parse. The adapter then requires, before the invoker is called: the tool is managed by
`@agent-control-stack/dc-tool-manifest` and is on the lane's explicit allowlist (`read_file`, `read_multiple_files`,
`get_file_info`, `list_directory`); the manifest marks it read-only with no approval requirement; the authority lists this
exact `(desktop_commander, tool)` pair and grants the privilege the tool's manifest scope consumes; the arguments satisfy the
tool's strict schema; every path argument is canonical and lies inside a `path`/`repository` scope resource; and the call's
bound does not exceed the authority's. A refusal is a failed attempt with a `nativeCode` and the external state marked certain.
A read-only tool that reports changed files, or a success without a result hash, is `invalid_output` with the state marked
uncertain.

Mutation and process tools (`write_file`, `edit_block`, `move_file`, `create_directory`, `start_process`) are refused as
`tool_not_supported`: the Desktop Commander chain requires a recorded human approval per call, a work unit has none, and a
grant is not one. Tools whose paths the lane cannot enumerate are refused rather than guessed at. The adapter does not mint a
Desktop Commander capability; the `DcToolInvoker` is the existing transport and has no production binding yet.

## Composition root

`createGovernedExecution({ dbPath, verifyOperator, resolveActor })` (`governed-runtime.ts`) opens the work-item store
and the mission store on one database and returns the authority ledger plus a dispatch ledger already wired to it, so
a dispatcher built this way cannot run a governed mission unchecked. `verifyOperator` and `resolveActor` are required
on purpose: there is no default that trusts a caller-supplied identity. Grants must be issued under the same id as the
coding mission. A terminal work item (`succeeded`, `failed`, `cancelled`, `rejected`, `quarantined`) stops dispatch and
child requests even while the mission row is still active. A private database (`:memory:`, an empty path, a `file:` URI)
is refused, because revocations are read from the mission store's connection and the two stores must see one file.
Tests drive claim, dispatch, result, revocation, cancellation and a process restart through this root only.

## Verification gate

A successful execution never completes a unit whose verification policy is not `none`. The unit parks in
`verifying` and only `WorkUnitVerificationGate` (`verification-gate.ts`) owns the verified completion transition.
Verification criteria are admitted before the first execution attempt and persisted immutably by migration 057.
A first claim is refused when a non-`none` policy has no rubric. Verified dispatch also requires the actual implementer
engine/provider identity, which is persisted separately from the worker owner id. Databases upgraded with already
in-flight verified units are quarantined fail-closed; admitting a rubric explicitly resets only that quarantined unit
for a fresh attempt. Terminal units (`succeeded`, `cancelled`) are not in flight. For a new upgrade that applies
057, 058 and 059 together under one SQLite writer lock, 059 restores unchanged terminal units rewritten by 057,
removes their quarantine rows, and records `verification.migration_057_terminal_restored` events. If 057 was
applied on an earlier startup, matching terminal candidates are ambiguous: a later genuine retry could have
returned them to the same failure tuple. Startup then refuses automatic 059 restoration and requires audited,
operator-approved reconciliation. Never force 059 past this guard by altering checksums or migration metadata.

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
