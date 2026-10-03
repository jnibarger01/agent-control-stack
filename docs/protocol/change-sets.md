# Immutable Change Sets

## Current implementation boundary

`packages/work-items` owns `acs.change-set.v1` and its durable revisions.
`SqliteWorkItemStore.submitChangeSet` submits a proposal for an existing mission
work item. It does **not** approve the mission, admit an execution plan, mint a
permit, or execute a tool. Authenticated HTTP intake and snapshot retrieval are
wired, as is deterministic policy evaluation of the current snapshot. Human bundle approval is also wired to an immutable approval record. MCP
intake remains unwired. The worker mission runner uses the authenticated HTTP
contract and governed MCP runtimes to resume operation execution. Human-issued
Autonomous Authority Grants can authorize snapshots and bounded DC execution.
Existing execution-plan approvals remain authoritative
on legacy runtime paths; approved Change Set operations derive those approvals
from the immutable bundle rather than requiring a second human review.

This contract supersedes the proposed bundle review artifact as the intended
mission execution snapshot. It is not a second policy evaluator or an authority
source. Policy Gate must derive tool effects and privileges from the canonical
runtime invocation and check the agent's declarations before authorization.

## Snapshot

A revision contains:

- Mission ID and the canonical existing `executionPlanSubjectInputHash` of
  mission inputs; executing actor ID; objective.
- Resource scope and maximum requested privileges. Resource names are exact
  identifiers at this stage, not an implemented filesystem or network sandbox.
- Expiration, runtime budget, concurrency limit, and failure behavior.
- Ordered operations with IDs, runtime, tool, action parameters, resources,
  requested privileges, declared effects, dependencies, and bounded retries.
- Verification requirements with IDs, covered operations, evidence kind,
  nonempty expected evidence, and independence requirements.
- Revision number and parent manifest hash.

Every snapshot field is included in the domain-separated SHA-256 hash of
strict canonical JSON. Operation IDs, expiration, retry budgets, and verification
are included. No caller-supplied approval state is accepted. Unsupported JSON,
unknown fields, and definitions exceeding 1 MiB are rejected.

Dependency graphs must be acyclic and reference known operations. Operations
must declare resources inside the snapshot scope and privileges inside its
maximum. Declared mutations require machine verification; declared privileged
operations also require independent review. Those declarations are untrusted:
the wired policy boundary derives the actual effect from the tool contract.
A `read_only` label cannot authorize a mutating tool.

## Submission and amendments

Submission supplies `definition`, `submissionId`, `expectedHeadHash`, and the
authenticated `createdByActorId`. An external route must inject provenance from
its authenticated principal rather than accept a body-supplied identity.

`POST /work-items/:id/change-sets` requires an authenticated operator or service
credential with `acs:write`. The body contains only `definition`, `submissionId`
and `expectedHeadHash`; caller-supplied creator identity, clock, approval state
and unknown fields are rejected. The route injects creator identity from the
credential and checks the URL mission against the definition. Success, including
an exact replay, returns `201` with the immutable record. Submission does not
change mission status, consume an approval, create a lease or issue a capability.

`GET /work-items/:id/change-sets` requires `acs:read` and returns the current
snapshot. Optional `revision` selects a positive integral historical revision.
Unknown query fields are rejected. Missing missions or revisions return `404`;
integrity and conflicting submission errors return `409`. Historical retrieval
does not reactivate that revision's execution authority.

The store validates current mission inputs and expiration inside its existing
write transaction. Initial submission requires a null expected head. An amendment
requires the exact current manifest hash. The store creates the next revision,
appends its audit event, and advances the head in the same transaction.
SQLite uniqueness constraints fence duplicate revision and submission IDs.
Replaying the same submission with identical definition, parent, and creator
returns the recorded revision without another audit event. A changed payload
under the same submission ID is rejected. A competing stale head is rejected.

Revision rows cannot be updated or deleted through ordinary SQL: append-only
triggers enforce this. Reads recompute every hash in the selected revision's
ancestry, check contiguous revision and parent bindings, and validate the linked
submission audit event, including its event hash. Current-head reads reject a
missing, mismatched, or rolled-back head. Historical revision reads are evidence
retrieval; they are not authorization to execute that older revision.

The immutable `auditEventId` connects a returned revision to
`change_set.submitted`, which records mission ID, revision, manifest hash, parent
hash, submission ID, executing actor, and creator without raw operation data.
The existing hash-chained audit log remains the audit owner. Local hashes cannot
prevent an administrator rewriting the entire database and audit chain; retain
independent audit exports and protect database custody.

## Errors

| Code                             | Condition                                                               |
| -------------------------------- | ----------------------------------------------------------------------- |
| `change_set_input_mismatch`      | Proposal is not bound to current mission inputs                         |
| `change_set_submission_conflict` | Submission ID reused for different content, parent, or creator          |
| `change_set_revision_conflict`   | Expected head does not match current head                               |
| `change_set_mission_terminal`    | A new revision targets a terminal mission                               |
| `change_set_expired`             | New snapshot is already expired                                         |
| `change_set_integrity_mismatch`  | Persisted snapshot, ancestry, head, or audit binding fails verification |

Schema-invalid submissions fail validation before persistence. Database and
audit failures roll back both revision and head. This migration adds new tables
and does not rewrite existing execution plans, approvals, or released migrations.

## Deterministic snapshot policy

`POST /work-items/:id/change-sets/policy` requires `acs:write` and accepts only
`expectedManifestHash`. The gateway reads the current verified snapshot and
mission, evaluates them and appends `change_set.policy_evaluated` in one database
transaction. A stale hash, changed mission inputs, expiration, terminal mission
or invalid binding fails closed. Caller-supplied decisions are rejected.

The gateway composes runtime adapters with `packages/policy-gate` without a
package dependency cycle. DC/JC adapters validate tool names, argument schemas
and configured containment. Runtime contracts supply actual capability scopes,
effects and deterministic policy context. The proposal's action kind is not used
as authority. Actual canonical paths must appear as exact operation resource
IDs; declaring a containing directory does not implicitly grant its descendants.
Actual scopes must be covered by requested privileges, and the declared effect
must not understate the tool effect. Violations produce a denial. Privileged JC
execution includes its effective cwd, including the default `/`, in containment
and resource checks. An unsupported runtime fails closed; a sandbox Change Set
policy adapter remains to be implemented.

Policy Gate runs its existing deterministic rules, returning per-operation
invocation hashes, canonical-fact hashes, decisions and the aggregate decision.
The audit event binds the actor, mission, revision, manifest and evaluation.
No model or JEV output participates in this decision. An `allow` result is a
policy evaluation, not an execution permit. Evaluation creates no approval,
lease, claim or capability and does not change mission status. Operation permit
issuance and capability consumption both reevaluate current policy.

The privilege schema preserves runtime scopes such as `process.privileged`,
`process.spawn`, `git.network` and integration read/write rather than folding
them into ordinary process or filesystem privileges. This is a vocabulary for
exact scope checks, not a grant of those powers.

## Required authorization integration

One canonical path must consume the current immutable snapshot:

```text
Mission -> Change Set -> deterministic Policy Gate
  -> exact-hash human approval or scoped Autonomous Authority Grant
  -> operation-bound permit -> fenced claim -> governed runtime
  -> evidence -> independent verification -> mission completion + audit
```

Amendments must force policy reevaluation and new authorization. Cancellation,
expiration, and supersession must revoke further operation issuance. No existing
global execution-mode switch should grant a Change Set authority. JEV remains an
observational side channel and must not change this authorization chain.

Validation: `npm run typecheck`, targeted Change Set/migration/state-machine
tests, then `npm run check`. Tests use isolated temporary databases; this source
migration must not be applied to a live database without rollout authorization.

## Human bundle review

`POST /work-items/:id/change-sets/approve` requires a configured `user` credential
with the `operator` role and `acs:approve`. Service and worker roles, including
mixed roles, are rejected. Input is strictly `expectedManifestHash`, `requestId`,
`reason` and optional `expiresAt`; identities and policy decisions are injected.
The gateway freshly evaluates canonical runtime policy and persists the policy
event and approval in one transaction. A denial cannot be approved. Restricted
operations cannot be self-approved by the requester, snapshot creator or executor.

The immutable approval binds mission, revision, manifest, mission inputs,
executing actor, approver, full policy evaluation hash, audit event and expiry.
Expiry cannot exceed the approved snapshot lifetime. Exact retries return the
original approval and audit events, without extending authority. A changed
request under the same request ID fails closed. Approval creates no lease or
permit and does not change mission status.

`GET /work-items/:id/change-set-approvals/:approvalId` requires `acs:read` and
returns the verified approval plus `active`. Supersession, expiry, cancellation,
terminal mission state, changed mission inputs and revocation invalidate further
use. Historical evidence remains readable. Integrity failures return an error;
they are never reported as active authority.

`POST /work-items/:id/change-set-approvals/:approvalId/revoke` requires the same
human authority and a strict reason body. Revocation is append-only and
idempotent. Reads verify the approval, historical snapshot, policy event and
revocation projection against canonical hashes and audit events. A missing
revocation row with retained audit evidence fails closed.

These endpoints provide review and durable binding. Operation-bound permits now map approved operations to existing governed
execution work items and leases. Bounded independent file read-back is wired;
broader autonomous planning and cross-runtime execution
remain unfinished. Every permit consumer
must enforce active approval and reevaluate current policy in the same
transaction as issuance; a historical approval is never a policy bypass.

## Operation permits and governed runtime selection

`POST /work-items/:id/change-sets/operations/:operationId/permit` requires
`acs:write` and the exact approval-bound executing actor. The strict body is
`expectedManifestHash` plus exactly one of `approvalId` or `authorizationId`.
The gateway re-evaluates all operations
using canonical runtime contracts and requires the same approved policy hash.
It transactionally creates one canonical execution work item, derives its
existing execution-plan approvals from the human bundle approval, assigns the
DC/JC bridge, and stores the immutable operation permit. A retry returns that
same permit and execution work item. This creates no execution lease.

Version 1 permits preserve human approval bindings and their original hashes.
Version 2 permits instead bind a grant authorization. Migration 47 preserves
existing permit rows byte-for-byte while adding the mutually exclusive foreign
key for grant authorization. Both modes use the same claim, lease, admission,
signing, result and verification path. Global admin mode does not authorize
either kind of Change Set permit.

The first operation permit starts the snapshot's total runtime budget. All
operation permits share that deadline, capped by approval expiry. The gateway
accepts `changeSetPermitId` on existing DC/JC capability issuance routes. The
managed proxy transports `_meta.acsOperationPermitId` only as a locator to ACS,
then strips it before forwarding. Possession alone grants no authority: ACS
requires the dedicated bridge identity, bound actor, runtime, tool and exact
invocation hash, plus unchanged policy and active parent approval. Legacy
lookups explicitly exclude bundle-derived execution work items.

After admission queueing, ACS rechecks bundle policy inside the transaction
that claims the child execution and persists admission capacity. Existing
attempt leases and fences remain canonical. Claim and renewal enforce parent
approval, snapshot, child input hash, assigned worker and expiry. Lease expiry
and renewal ceiling cannot exceed the operation permit deadline. Dependency
claims require prior canonical executions to have succeeded; concurrency and
stop-on-failure constraints are checked under the same database writer lock.
The approved attempt budget caps creation of new attempts.

The permit hash and `change_set.operation_permitted` audit event link mission,
manifest, operation, approval and canonical execution work item. Existing
execution audit events then link that work item to its attempt, lease and
signed runtime capability. Durable resume, independent review and parent completion
are wired for bounded file operations and covered by isolated runtime acceptance
under both human approval and autonomous grants. General recovery/retry and
downstream revocation of already-issued capabilities remain incomplete. These
source tests do not prove deployed execution.

## Approved verification and result acceptance

At canonical claim, ACS persists the approved operation's verification
requirements in the same transaction as its lease. Bundle mutations cannot
complete through the legacy absence-of-requirement behavior, even when legacy
verification configuration is off. Acceptance compares the persisted requirement
with the exact approved snapshot and requires a matching decision and hashed
evidence bound to the permit, manifest and exact result submission.

For successful DC/JC bundle results, the gateway checks the current canonical
attempt and lease, runtime/tool/invocation metadata, and capability-issued audit
event. It independently performs approved `fs_inspect` checks using configured
containment and exact declared operation paths. The Linux verifier checks the
opened descriptor via procfs, rejects unsafe or changing resources, and limits
read-back to a regular file of at most 1 MiB. Expectations may specify exact
content, SHA-256 or existence. Evidence contains resource hashes, observed
existence, byte counts and hashes; file content is not logged.

Failed observations reject the result/evidence transaction and block success.
Missing or mismatched requirements also block success. Simulated results cannot
satisfy bundle mutation verification. Unsupported verification kinds fail closed
before a new operation permit or child is created under either authority path;
result acceptance also checks adapter availability. Independent
review is mandatory for every mutation under completion policy v2; the separately
authenticated review endpoint below binds it to the persisted result. No worker-provided
success message is treated as the verification verdict. Exact accepted-result
replay returns the durable result without rerunning read-back.

Run the actual isolated runtime acceptance with:

```bash
ACS_DC_E2E=1 npx vitest run tests/e2e/acs-dc-mcp/change-set-execution.test.ts
```

This requires building the vendored Desktop Commander snapshot first. With the
flag enabled, a missing runtime build is a failure rather than a skipped test.

## Mission-scoped Autonomous Authority Grants

`POST /work-items/:id/authority-grants` requires a configured human `user`
credential with the `operator` role and `acs:approve`; service/worker/mixed
credentials cannot issue or revoke grants. Its strict body is `requestId`,
`expectedSubjectInputHash`, `definition`, and `reason`. ACS injects the issuer,
mission ID, timestamps and identity/hash. The issuer cannot be the executing
actor. Agent credentials cannot mint or broaden authority.

The immutable definition names one executing actor, exact mission inputs,
resource scope, runtime/tool allowlist, maximum privileges, expiry, optional
exact manifest hash and operation/runtime/concurrency/attempt limits. Path and
repository resources explicitly select `exact` or `descendants` coverage.
Filesystem scope must be canonical absolute paths inside configured runtime
containment. Descendant matching respects path boundaries, not string prefixes.
Non-filesystem identifiers only support exact coverage.

`POST /work-items/:id/change-sets/authorize` requires `acs:write` from the exact
grant-bound actor. Its body is `grantId` and `expectedManifestHash`. ACS freshly
evaluates deterministic canonical runtime policy, checks every snapshot
resource/tool/privilege and limit against the grant, and atomically persists an
exact-hash grant authorization with the policy audit record. Policy denials
cannot be overridden by a grant. JEV has no role in this decision. Replays
preserve the original authorization, policy event, identity and expiry.

This is an automatic authorization under prior human delegation; it creates no
human bundle approval. `change_set.grant_authorized` records its non-secret
`bindingId` and `bindingHash` (authorization ID/hash), linking the grant hash,
manifest and policy hash. The existing redaction rule continues to redact keys
containing `authorization`; audit keys deliberately use these safe binding
names. Runtime permits continue into canonical child execution, with existing
plan approval records derived by ACS from the original human grant issuer.

Issuance/claim/renewal and result acceptance recheck current grant, snapshot,
mission inputs, expiry and revocation. Amendments invalidate old snapshot
authorizations. A new revision inside the original grant can receive new
deterministic authorization without another human review; expansion requires a
new human-issued grant. Operation reservations count cumulatively across all
revisions using that grant. The grant runtime clock starts at its first permit
and cannot be reset by amendment. Concurrency also spans its revisions.

`GET /work-items/:id/authority-grants/:grantId` and
`GET /work-items/:id/change-set-authorizations/:authorizationId` require
`acs:read` and return verified provenance plus current validity. Human-only
`POST /work-items/:id/authority-grants/:grantId/revoke` accepts a reason. Records
and revocations are append-only, hash/audit checked and durable across restart;
a missing revocation projection with retained audit evidence fails closed.
Revocation guards future issuance and active lease operations; it does not yet
revoke an offline capability already delivered to a runtime.

Grants do not inherit to another actor or mission. An independent child actor
needs separately authorized delegation. Resource scope may cover multiple
repositories when explicitly granted, but current executable acceptance covers
local file operations only. There is no cost-budget accounting yet.

### Current execution limits

The grant path currently permits canonical filesystem scopes with explicit
canonical resources. Tools with no resource binding, including global process
inspection, fail closed rather than inheriting a mission's filesystem scope.
Arbitrary process execution, remote/network/deployment/service/secret operations
fail before a child execution is created: the current runtime cannot prove
their full resource confinement. Unsupported machine verification kinds also
fail before execution under either approval or a grant.

Both human-approved and grant-authorized operations require an implemented
verification adapter before a new execution permit/child is created. Each
operation supports at most 32 verification checks. File verification requires
configured containment and Linux descriptor validation; its resource must belong
to the exact approved operation. Human approval does not bypass these checks.

`fs_inspect` expectations must pass the supported verifier schema at permit
issuance. These are remaining implementation requirements, not permissions
silently removed from an otherwise complete autonomy system.

The real isolated acceptance test runs both authority modes: one human bundle
approval, or one human mission-scope grant with automatic snapshot authorization,
followed by two dependent DC writes and independent read-back. Separate source
acceptance covers a JC write and one mixed DC/JC mission under a scoped grant,
with independent review before completion. These tests do not prove production
deployment or interruption during an in-flight
mutation. Runtime restart between accepted operations and mission closure are
covered below; these remaining
capabilities are required before ACS is complete.

## Durable mission runner and completion

`apps/worker/src/mission-runner.ts` reconstructs progress from ACS on every tick.
It loads the current immutable head, optionally submits a planner proposal when
no head exists, consumes an existing human approval or human-issued grant,
reserves operation permits, and dispatches dependency-ready operations. It does
not approve work or issue grants. The CLI selects this path when
`ACS_MISSION_ID` is set; otherwise its existing worker behavior applies.

`GET /work-items/:id/change-sets/progress` requires `acs:read`. Its optional
`expectedManifestHash` pins the snapshot. The store validates persisted child
bindings, accepted results, attempt inputs, leases, audit events, and required
verification before reporting success. Running or unobserved attempts are not
replayed. Unknown outcomes return `needs_reconciliation`; failed operations
remain blocked until a separately authorized recovery is implemented.

`POST /work-items/:id/change-sets/complete` requires `acs:write`, the bound
executing actor, the exact `expectedManifestHash`, and exactly one `approvalId`
or `authorizationId`. Every operation must have an accepted, integrity-checked
result and satisfy its required verification. The store checks active authority
and atomically writes the parent completion receipt and `change_set.completed`
audit event. Identical completion replay returns the receipt without another
event. The receipt binds the snapshot, actor, authority, policy, operation result
references, and completion time through a canonical hash. A Change Set parent
cannot be claimed as a normal executable work item.

The HTTP/MCP client uses separate control-plane and runtime credentials. Runtime
calls include the operation permit in MCP metadata and have no direct execution
fallback. Requests have a bounded response size and timeout; the loop's polling
budget is not a hard deadline across all in-flight requests.

CLI configuration:

- `ACS_MISSION_ID`, `ACS_MISSION_GATEWAY_URL`, `ACS_MISSION_GATEWAY_TOKEN`.
- One of `ACS_MISSION_GRANT_ID` or `ACS_MISSION_APPROVAL_ID` for execution.
- `ACS_MISSION_DC_MCP_URL` / `ACS_MISSION_DC_MCP_TOKEN` and equivalent
  `ACS_MISSION_JC_*` settings for configured governed runtimes.
- Optional `ACS_MISSION_PLAN_PATH` supplies a bounded JSON Change Set definition.

These settings supply existing authority; they cannot mint or broaden it.
The CLI returns exit 0 only for a completed mission, 2 for a pending/blocked
mission, and 1 for an error. Credentials are not included in its output.

Current acceptance covers two dependent file writes, independent read-back,
parent closure, recreation of the runner client/MCP session, and killing the real
managed DC executor between accepted operations under both human approval and a
grant. A replacement PID and newly attested session execute only unfinished work;
the audit retains exactly two accepted results and one parent completion. Negative
cases dispatch the unfinished operation through the dead session: the bridge
reports failure, the one-attempt policy blocks the mission, and no completion or
second file write occurs. These failures are retained rather than replayed.

In-flight lease-loss acceptance proves that observed runtime mutations with no
durable result stop for reconciliation; it does not prove automatic reconciliation
or retry. This does not prove automatic model
planning, failed-operation retries/amendments, broader command/deployment authority, or deployment
of this source to production. Those remain explicit implementation/proof gaps.

## Recovery decision safety

The existing `packages/recovery` planner is a domain helper, not an authority
source and not yet wired into the mission runner. Process disappearance, engine
timeout, and missing validation no longer imply that an operation did not run.
Unknown execution requires independent reconciliation and cannot authorize retry.
A bounded retry recommendation requires trusted non-execution evidence, a pending
attempt, no live process or unfenced authority, completed workspace cleanup, and
remaining attempts. Startup orphan inspection always treats execution as unknown.

`recordRecoveryDecision` independently rejects a retry recommendation unless the
persisted attempt is pending, has no started time, has fencing epoch zero, and has
never received a lease. It validates attempt/work-item binding and exact replay
payloads. Reads verify the immutable record against its hash-verified audit event;
changed evidence gets a new startup reconciliation key rather than silently
reusing an earlier decision. Recovery records remain observations, not approvals,
permits, execution commands, or permission to replay an uncertain side effect.
Actual retry-attempt creation, authority reevaluation, and unknown-outcome
reconciliation still need canonical mission integration.

## Independent review as completion authority (Step 7)

Completion policy `acs.change-set.verification.v2` distinguishes **observed execution
success** from **verified operation success**. In one gateway transaction ACS
accepts the result with the current attempt lease/fence, then performs bounded
machine read-back and attaches hashed evidence. The audit ordering is result →
evidence → authenticated review → verification decision → parent completion.
Failed collection rolls back the result/evidence transaction; an unobserved
runtime outcome must be reconciled, never blindly replayed.

Every mutating operation requires at least one distinct reviewer, regardless of
legacy verification settings. Additional `independent_review` requirements set
higher reviewer counts. Read-only operations without verification may finish
directly. Machine-only read-only requirements can be accepted by the ACS verifier.
The approved snapshot supplies the exact machine requirements; completion policy
imposes the mutation review floor before execution admission.

`GET /work-items/:executionId/change-set-review` requires `acs:read` and returns
canonical result, evidence, requirement, reviews and decision. It rejects running
or unknown outcomes and corrupt persisted execution state.
`POST` at the same path requires an independently configured, live `acs:review`
credential with operator or service role and no worker role. Its strict body is:

```json
{
  "attemptId": "attempt-id",
  "evidenceManifestHash": "<64-character-sha256>",
  "verdict": "PASS",
  "reason": "Assessment of the exact machine evidence and expected outcome"
}
```

Reviewer identity is injected from the credential; executor/mission-actor
self-review is rejected even using a separate credential with the same actor ID.
The executor is never given reviewer credentials. A human or separately configured
reviewer agent/service may assess evidence; ACS does not launch a model reviewer
or accept JEV advice as verification. Provisioning and isolation of that reviewer
remain an operator responsibility, separate from mission authority grants.

Reviews are content-addressed and bound to the exact work item, attempt, evidence,
principal, verdict and reason. An identical replay creates no extra finding or
decision; a changed replay fails closed. Different principals are counted once.
Any non-PASS review blocks the operation; it cannot later be overwritten by PASS.
Legacy advisory findings never satisfy this gate. Completion revalidates hashes,
audit provenance, accepted result/lease bindings, requirements and reviewer
identities. No schema migration is required: canonical records reuse the existing
immutable evidence/review/decision tables with new versioned semantics.
Existing v1 completion receipts/requirements are not silently promoted to v2;
those missions need explicit migration/reconciliation before this source is
released into a database containing old Change Set completions.

Pending review appears as `awaiting_verification`; neither the runner nor a direct
claim can execute dependent work until review passes, and parent completion fails
closed. Reviewer assessment remains valid after an **already consumed** execution
lease expires. Loss of an active lease before result acceptance leaves unknown
work: it cannot collect authoritative evidence or obtain a completion review.
The isolated real DC acceptance uses a separate reviewer identity and HTTP evidence
read-back under both bundle approval and autonomous grants, including concurrency,
worker replacement and in-flight lease-loss cases. This is source/isolated proof;
it does not establish deployment or a production reviewer service.

## Mission-wide audit reconstruction (Step 8)

`GET /work-items/:missionId/mission-trace?afterSequence=0&limit=100` requires
`acs:read`. It joins the parent mission with every immutable operation permit and
historical revision, so executor children, admissions, attempts, leases, capability
issuance, result acceptance, machine evidence, independent review and completion
can be inspected in one timeline. This is a read-only projection of existing
records, not a new lifecycle, authority source or audit database.

Events are returned oldest-first; `nextAfterSequence` requests the next page.
Limits are 1–200 events per page and 2,048 historical links/revisions/observations;
exceeding a resource bound returns an explicit error, never silent truncation.
Unrelated traffic does not evict early mission evidence. Reads use one database
snapshot; historical permits remain available after amendment or revocation.
Each returned event and its immediate audit predecessor are hash-checked.
`globalChainVerified: false` explicitly distinguishes this bounded check from the
existing complete audit-chain verifier/export. Execution projection integrity
and verified completion remain enforced by Change Set progress/completion.

Each event carries derived mission/operation/permit/authority/attempt/lease/result/
evidence/reviewer correlation where those IDs exist. It retains the original
hash-bound event for independent inspection. Missing identifiers remain absent;
transport logs or executor assertions are not promoted into authoritative evidence.
The existing per-work-item LoopTrace IDs and JEV observation jobs are also joined,
with every JEV job explicitly labeled `telemetry_only`. Observation status is live
context, not immutable approval or verification evidence.

New audit records include injected `acs.process.id`, `acs.process.started_at`,
`acs.instance` and `acs.release_sha` attributes. Caller-supplied values cannot
override producer identity. Process IDs distinguish actual process incarnations;
declared release SHA/instance distinguish configured producers across reloads.
Invalid producer configuration is represented as `unknown`, and an undeployed
build remains `unreleased`. Historical records without metadata stay `unknown`;
this change does not rewrite their hashes. A declared SHA is not proof of an
immutable deployed release or effective runtime configuration: Step 2 must still
verify manifests, systemd/executables and the remote JC/DC/Hermes stack.

No schema migration or production restart is needed for the source implementation.
The authenticated HTTP projection is covered by completed mission tests; the real
DC acceptance additionally reconstructs both dependent operations and their
separate reviewer decisions. Cross-service request tracing and production release
attribution remain subject to runtime proof, rather than assumed from this API.
