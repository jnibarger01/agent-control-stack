# Owner-controlled full automation contract

Status: frozen architecture contract; implementation is intentionally not included in this document.
Baseline: `f51094ef94ab2e7e7abfffa5f266c26c7d5496c4` on `feat/owner-full-auto`.

## 1. Verified custody and evidence boundary

Verified before this document was written:

- Workspace: `/home/jacen/projects/acs-worktrees/owner-full-auto`.
- `git status --short --branch` reported only `## feat/owner-full-auto` (clean).
- `git rev-parse HEAD` reported `f51094ef94ab2e7e7abfffa5f266c26c7d5496c4`.
- `git log -1 --oneline` reported `f51094e Merge pull request #228 from jnibarger01/merge/jev4-observation-clean-20260929`.
- No source, migration, UI, or production state was changed by this task. The only writable path is this document.

This contract is based on the source and protocol files named below. Line numbers are the evidence snapshot at authoring time; implementation must re-check them after any source change.

## 2. Current authoritative flow (as implemented)

### 2.1 Canonical mode state

`storage/migrations/027_execution_mode.sql:6-16` creates the single-row `execution_mode_state` table, constrained to `strict | admin` and seeded to `strict`. `packages/work-items/src/store.ts:5214-5235` reads that row and returns `mode: null` for missing or invalid values. `packages/work-items/src/store.ts:5237-5276` writes the row and appends `execution_mode.changed` in one store write transaction.

`packages/policy-gate/src/execution-mode.ts:3-40` maps a mode value to an approval policy and fails closed for missing/corrupt state. `packages/policy-gate/src/execution-mode.ts:48-75` gates admin mode on authenticated, managed, unambiguous, live executor authority. `packages/policy-gate/src/execution-mode.ts:92-136` preserves policy denials and only turns `require_approval` into an allow under valid admin authority.

The HTTP boundary is `apps/gateway/src/server.ts:811-865`: `GET /execution-mode` and `GET /authority` expose the row plus live authority; authenticated `POST /execution-mode` writes it. `requireMutationActor` at `apps/gateway/src/server.ts:3606-3630` derives the actor from the resolved credential, requires operator/service role and `acs:write` (the mode route currently does not request the stronger approve scope).

The protocol currently describes only strict/admin at `docs/protocol/execution-mode.md:3-22`. It explicitly says not to add an environment-variable mode.

### 2.2 Interactive approval path

Work-item creation and policy status are centralized in `packages/policy-gate/src/tools.ts:103-115`: deny transitions to `blocked`, `require_approval` transitions to `needs_approval`, and allow transitions to `approved`. Approval is recorded only by `gateApproval` at `packages/policy-gate/src/tools.ts:118-195`. It validates the supplied action hash, re-evaluates policy, rejects mismatches/not-required hashes, records the approval and execution-plan approval, and transitions only when all required approvals exist.

The current approval protocol confirms that no separate request-token record is created (`docs/protocol/approval-lifecycle.md:47-68`). The persisted `approval_records` row is still created by `packages/work-items/src/store.ts:4670-4747`; it contains the work item, action hash, request hash, approver, status, and expiry. `hasApproval` filters expired grants (`store.ts:4749-4757`). `consumeApproval` verifies request hash, status, expiry, then atomically updates `granted -> consumed` and audits (`store.ts:4759-4824`).

Worker claim is centralized in `packages/policy-gate/src/tools.ts:248-337` and the exact-id resume/bridge claim in `tools.ts:340-431`. Both re-evaluate current policy, create/admit the execution plan, require every plan approval, claim with attempt authority, then consume the approvals. The store's exact-id claim recomputes the action hash inside the write transaction and rejects caller mismatch (`packages/work-items/src/store.ts:5098-5127`).

### 2.3 Admission, lease, capability, execution, and result

Execution admission is intentionally capacity-only. `docs/execution-admission.md:1-11` establishes ACS authorization and lease/capability as authority; `docs/execution-admission.md:13-30` places admission before claim; `docs/execution-admission.md:57-67` binds a permit to attempt, work item, lease, worker, and fencing epoch.

The governed Desktop Commander path is `apps/gateway/src/server.ts:1663-1717` (tool/argument/containment normalization and action binding), `server.ts:1719-1780` (deduplicated work item and policy context), and `server.ts:1784-1887` (deny/mode/approval handling). It acquires admission before exact-id claim at `server.ts:1890-1905`, obtains trusted work item and active lease at `server.ts:1915-1922`, authorizes against the lease at `server.ts:1924-1965`, requires the lease's approval binding for approval-gated tools at `server.ts:1967-1999`, and records capability issuance with the attempt/lease/fencing fields at `server.ts:2002-2017` and following lines.

The Jace Commander path is independently wired. It normalizes and binds the request at `apps/gateway/src/server.ts:2152-2255`, explicitly has no admin auto-approval today at `server.ts:2266-2277`, acquires admission then exact-id claims at `server.ts:2280-2303`, and validates the active lease and authorization before capability issuance at `server.ts:2305-2409`.

The worker claims through the governed tool path (`apps/worker/src/index.ts:181-214`), executes only after a lease-bound claim, and submits results with the attempt/lease/action binding (`apps/worker/src/index.ts:284-310`; additional result handling follows in that file). Bridge result reporting is explicitly non-authoritative and lease-bound (`apps/dc-mcp-gateway/bridge.js:135-139` and `220-304`). Expired lease reconciliation is store-owned and fenced (`packages/work-items/src/store.ts:5287-5373`).

### 2.4 Resume and queued work

Admission queueing is memory-only and creates no attempt, lease, capability, or durable execution commitment (`docs/execution-admission.md:23-30,69-73`). A queued request therefore must not create an approval record. Existing work-item resume uses the exact-id claim sibling described in `packages/policy-gate/src/tools.ts:340-347`; it must enter the same mode-aware policy/claim seam rather than inventing a resume bypass.

The current control UI receives canonical mode through the gateway view model (`apps/gateway/src/server.ts:945-1022`; `apps/control-ui/src/types.ts:74-119`). It renders admin-mode messaging and pending approval controls from the current status (`apps/control-ui/src/render/panels.ts:24-49,100-111` and `apps/control-ui/src/approval-actions.ts:160-180`). `apps/control-ui/src/work-item-controls.ts:15-64` contains cancel/retry/clone controls, not an execution-authority bypass.

## 3. Frozen full-auto contract

### 3.1 One mode decision, no second flag

Extend the existing canonical execution mode decision with one persisted mode value, `full_auto`. Do not add `ACS_MODE`, a second table, a second environment variable, a work-item metadata flag, or a bridge-local switch. The canonical row remains the only mode authority.

Compatibility contract:

- Existing `strict` remains the default for an unset/healthy migrated database.
- Existing `admin` remains readable and writable for compatibility until a separately authorized migration retires it. Its current semantics remain unchanged; it is not silently treated as full-auto.
- `full_auto` is the only new semantic mode. `strict` and `admin` are not aliases for it.
- Missing or malformed mode state is a deny state, never an implicit strict or full-auto default (`readExecutionModeValue` already establishes this behavior).
- Switching to `strict` is the emergency return-to-interactive operation. It is durable, atomic with its audit event, and affects the next authorization decision. It must not retroactively mint or revoke a capability; in-flight leases remain governed by their existing expiry/fencing rules.

The public mode response should use `executionMode: "full_auto"` when valid and retain `executionMode: "missing" | "corrupt"` on failure. `approvalPolicy` should be `"full_auto"` for this mode. Existing clients must continue to understand strict/admin/missing/corrupt; clients that do not understand full_auto must fail closed and not render an approval action as if it were interactive.

### 3.2 Owner-controlled activation

The repository has no distinct `owner` credential role. The smallest repository-grounded owner authority is the authenticated gateway credential resolved by `requireMutationActor`, restricted for this operation to a credential with the existing `operator` role and both `acs:write` and `acs:approve` scopes. The server-derived actor ID is written to `updatedBy`; the request body cannot supply identity.

This is an explicit compatibility assumption, not a new provider or authority source. Security-policy review must either accept this as the owner binding or replace it with an existing canonical owner predicate before implementation. Service credentials and worker/bridge credentials must not be allowed to activate or deactivate full_auto merely because they can execute or write work.

The mode mutation must reject:

- unauthenticated callers;
- non-operator/service-role callers;
- operator callers without both required scopes;
- invalid mode values or empty reasons;
- missing/corrupt canonical row when the implementation cannot establish a safe transition.

The state write and `execution_mode.changed` event remain one transaction. The event records the derived actor, old mode, new mode, and bounded reason; no credentials or request bodies are included.

### 3.3 Full-auto authorization semantics

For each governed action, the centralized mode decision runs in this order:

1. Authenticate the caller and derive the principal from the gateway credential.
2. Normalize and validate tool arguments, containment, required scopes, runtime identity, and action fingerprint.
3. Evaluate canonical policy. `deny` remains deny; an explicit policy deny is never promoted.
4. Validate managed authority and the current executor/worker lease. Missing, expired, ambiguous, conflicting, or unmanaged authority is deny.
5. In `full_auto`, do not call `gateApproval`, `approve_work_item`, `recordApproval`, `grantExecutionPlanApproval`, `hasApproval`, or `consumeApproval` for this action. No approval record, approval token, approval request, pending approval queue, or human approval wait may be created.
6. Record an ACS-owned mode decision (`execution_mode.full_auto_authorized` or `execution_mode.full_auto_denied`) with the derived principal and policy/authority outcome.
7. Admit capacity, claim the exact work item with current action hash and attempt authority, issue the normal capability, and execute through the existing lease/fencing path.
8. Re-evaluate policy and all lease/capability bindings at claim and issuance as today. Full-auto removes only the human approval bottleneck; it does not remove policy, scope, containment, capability, admission, lease, worker identity, result validation, or audit requirements.

The implementation seam should be a mode-aware centralized authorization result consumed by both DC and JC issuance paths and by worker/queued/resume admission. It must return an explicit `approvalRequired: false`/`mode: full_auto` authority decision without fabricating an approval grant. The downstream claim contract must allow an admitted plan with no approval IDs while still requiring the plan hash, policy version/decision hash, input hash, lease, worker, and fencing epoch.

### 3.4 Interactive and UI semantics

Interactive means `strict`: policy-required actions become `needs_approval`, the human approval endpoint is the only grant path, and the UI may show approve/reject/pending controls.

Full-auto means the UI displays a prominent `FULL AUTO` mode indicator and the effective owner actor/time. It must not display a pending-approval count or approve/reject controls for actions whose policy decision is being satisfied by full-auto. It must continue to show policy denials, blocked work, capability failures, expired leases, and execution outcomes. The emergency `Return to interactive` control posts `mode: strict` through the authenticated mode endpoint and displays the resulting audit-confirmed state; it is not a client-only toggle.

Existing admin banner copy (`apps/control-ui/src/types.ts:118-119`) must not be reused for full_auto: “human approval disabled” is insufficient because it obscures the stronger distinction that no approval record exists. Full-auto must be labeled separately from result execution backend labels (`dry_run`, `desktop_commander`, `unknown`).

### 3.5 Audit contract

Every full-auto action records a mode decision and terminal outcome through the canonical audit chain. Required attributable fields are: derived principal, work item ID, attempt ID when claimed, tool/executor, action hash, policy decision hash/version, mode, timestamp, and outcome (`authorized`, `denied`, `capability_issued`, `execution_succeeded`, `execution_failed`, or `lease_expired`). Lease-bound events must include lease ID, worker ID, and fencing epoch when available.

The record contains bounded denial/failure codes and hashes/digests, never raw tool arguments, bearer tokens, private keys, secret environment values, unrestricted command output, or capability material. This follows `docs/protocol/audit-events.md:7-19,51-73,93-106` and the existing execution audit fence tests in `packages/work-items/src/execution-audit-event.test.ts:80-105,235-310`.

Do not emit `approval.granted`, `approval.consumed`, or `approval.requested` for a full-auto action. Mode-change audit remains `execution_mode.changed`. The full-auto decision event is not a substitute for policy or execution events; all applicable policy, claim, capability, and result events remain required.

## 4. Failure and safety matrix

| Condition | Full-auto result | Approval row | Durable execution |
| --- | --- | --- | --- |
| Mode row missing/corrupt | deny, explicit mode error | none | none |
| Unauthenticated or unauthorized owner switch | reject mutation | unchanged | none |
| Unauthenticated execution caller | deny | none | none |
| Missing required capability scope | deny | none | none |
| Explicit policy deny | deny | none | none |
| Missing/expired/ambiguous executor lease | deny | none | none |
| Containment/runtime identity failure | deny | none | none |
| Admission queue full/timeout | structured backpressure | none | no claim/lease |
| Switch back to strict | future requests interactive | future approvals only | in-flight leases stay fenced |
| Stale worker/result/fencing epoch | reject and audit failure | no new approval | newer owner remains authoritative |
| Resume with invalid action/plan/input integrity | deny/quarantine according to existing recovery contract | none | no execution |

## 5. Scope map and ownership

Implementation ownership is intentionally split without duplicating the mode decision:

- `packages/work-items`: schema/migration compatibility for `full_auto`, atomic mode read/write, mode audit fields, and no-approval plan/claim persistence. Owner: backend-api/data-ai as appropriate for persistence; security-policy reviews the authorization invariant.
- `packages/policy-gate`: one mode-aware decision function and contract tests. Owner: backend-api; security-policy owns the material security gate.
- `apps/gateway/src/server.ts`: authenticated owner mode mutation and one shared mode-aware DC/JC issuance seam. Owner: backend-api.
- `apps/worker/src/index.ts` and resume/dispatch callers: consume the authoritative mode decision without locally inventing approval state. Owner: backend-api/infra-platform for dispatch integration.
- `apps/control-ui`: full-auto header, truthful approval-control visibility, and emergency strict switch-back. Owner: frontend-engineer.
- `apps/dc-mcp-gateway` and `apps/dc-relay`: remain capability verifiers/reporters; no local full-auto authority. Owner: backend-api/infra-platform.
- `docs/protocol/execution-mode.md`, `docs/protocol/approval-lifecycle.md`, `docs/protocol/audit-events.md`, and runbook material: update in the implementation change. Owner: software-architect with implementing owners.
- Security review: `t_f8e66479` consumes this contract before source modification.

Required implementation acceptance is one centralized decision path shared by DC, JC, worker claim, queued dispatch, and exact-id resume. Any path that creates a work item and returns `needs_approval` without consulting that seam is a defect.

## 6. Explicitly unsupported paths

The following are not full-auto execution paths and must remain denied or interactive rather than gaining an accidental bypass:

- direct `startWorkItem` / legacy claims: test-only (`packages/work-items/src/store.ts:4827-4834` and `5098-5129`);
- direct store calls that assert `via`, `approvedBy`, owner, policy, or lease fields supplied by a caller;
- MCP invocation of `approve_work_item`: explicitly rejected by `docs/protocol/approval-lifecycle.md:58-68`;
- Jace Commander admin auto-approval: currently deliberately absent (`apps/gateway/src/server.ts:2266-2269`), but full-auto must use the shared seam rather than copy Desktop Commander behavior;
- unmanaged bridges, break-glass runs, local execution outside the managed runtime, and unknown/unsupported tool dispositions;
- capacity admission as an authorization substitute (`docs/execution-admission.md:5-11,65-67`);
- UI-only toggles, environment variables, or work-item metadata pretending to change authority;
- replayed/resumed work that lacks current policy, plan, input, action, lease, and fencing validation.

## 7. Migration and compatibility plan

1. Add a forward migration that permits `full_auto` in the canonical mode representation without editing migration 027. Preserve the seeded strict row for fresh databases.
2. Keep `strict` and `admin` readable during rollout. Existing admin behavior and tests remain unchanged until a separately reviewed retirement migration.
3. Update the canonical mode schema/types and all response schemas together; reject unknown values and fail closed.
4. Deploy with the persisted row still `strict`; activation is an explicit authenticated owner operation, not a deployment environment setting.
5. Provide an operator runbook for inspecting `/authority`, switching to full_auto, verifying audit, and immediately posting strict. No production activation is part of this contract.
6. Do not auto-convert existing `needs_approval` items. On the first full-auto evaluation, policy and authority are re-run; an already-created human approval remains an interactive artifact and must not be silently consumed as full-auto authority. The simplest safe behavior is to leave such items pending until canceled/recreated or explicitly handled by a later migration contract.

## 8. Runnable acceptance tests for implementation

Run from the repository root after implementation:

- `npx vitest run packages/policy-gate/src/execution-mode.test.ts packages/work-items/src/execution-mode-store.test.ts apps/gateway/src/execution-mode.test.ts`
- `npx vitest run packages/policy-gate/src/tools.test.ts packages/work-items/src/execution-audit-event.test.ts packages/work-items/src/lease-renewal.test.ts`
- `npx vitest run apps/gateway/src/dc-capability-issue.test.ts apps/gateway/src/jc-capability-issue.test.ts apps/gateway/src/execution-admission.test.ts apps/worker/src/index.test.ts`
- `npx vitest run apps/control-ui/src/execution-mode.test.ts apps/control-ui/src/visibility.test.ts apps/control-ui/src/render-golden.test.ts`
- `npm run check`

The full-auto tests must include positive and negative cases, with database read-back assertions:

- owner activation and strict switch-back are durable and audited;
- unset/fresh state remains strict; missing/corrupt state denies;
- full-auto creates zero `approval_records` and zero approval trace events for an approval-classified action;
- unauthorized owner, missing scope/capability, explicit policy deny, invalid containment, missing/expired/ambiguous lease, and stale fencing all deny;
- DC and JC both use the same decision; Jace Commander does not retain a separate admin/full-auto branch;
- queueing creates neither approval nor lease and does not await human approval;
- exact-id resume re-runs policy and integrity checks and creates no approval;
- successful capability issuance still contains normal scope, action, plan, runtime, lease, attempt, and fencing bindings;
- audit has principal/work/attempt/tool/time/outcome and no secret or raw argument material;
- UI shows `FULL AUTO`, hides misleading pending approval controls for full-auto work, and returns to truthful strict state after switch-back.

## 9. Assumptions and unresolved decisions

Verified fact: the current credential model exposes operator/service roles and scopes, but no distinct owner role or owner identifier. The contract therefore uses operator + `acs:write` + `acs:approve` as the smallest existing owner control and calls out the assumption for security review.

Recommendation: retain this contract's single persisted mode and shared decision seam; do not add a second mode flag or make admin silently mean full-auto.

Unknown requiring security-policy confirmation: whether “owner” must be a narrower configured principal than all operator credentials. If security-policy rejects the compatibility assumption, implementation must stop at the mode mutation boundary until it supplies the canonical existing owner predicate; no default-allow substitute is acceptable.

Unknown intentionally deferred: whether already-pending interactive work should be migrated into a full-auto plan. This contract chooses no automatic conversion and requires a later explicit migration/UX decision.

## 10. Amendment after security BLOCK and explicit owner clearance

This section supersedes the compatibility assumption in sections 3.2 and 9 that every `operator` credential with `acs:write` and `acs:approve` could be the owner. That assumption is retained as historical provenance because it was the input reviewed by security-policy; it is not an implementation contract. The corrected, binding contract is in `docs/architecture/owner-full-auto-binding.md` and is normative for source work.

The owner is an explicitly configured, authenticated principal selected by deployment configuration, not a new credential role, environment mode selector, client field, service credential, worker identity, or UI state. Authentication remains the existing gateway authentication. The mode mutation is accepted only when the resolved credential has an exact `issuer`, `subject`/`actorId`, `operator` role, and both `acs:write` and `acs:approve` scopes matching the typed owner configuration. Missing, malformed, duplicated, conflicting, revoked, expired, or unavailable owner configuration fails closed. The configured owner does not itself enable full-auto; it only authorizes mutation of the canonical `execution_mode_state` row.

Full-auto authorization is a first-class ACS-owned binding, discriminated from interactive approval by a versioned `authorizationMode` field. It is not an approval row, approval ID, synthetic token, null approval, or admin auto-approval. DC and JC use the same centralized admission result and the same binding verifier. Existing strict/admin behavior is preserved; default and switch-back remain strict. CLI/local-admin mode mutation must call the same owner-bound service and cannot bypass it.

The no-approval binding, owner configuration schema and exact source seams are frozen in the companion document. That document also records the forward-only migration, transactional TOCTOU rules, queue/resume behavior, result binding, failure matrix, and implementation ownership. No source, migration, generated artifact, configuration, service, or production state is changed by this architecture amendment.
