# Full-auto owner binding and authorization evidence contract

Status: corrected architecture contract, pending independent security-policy re-review before implementation.
Baseline: f51094ef94ab2e7e7abfffa5f266c26c7d5496c4 on feat/owner-full-auto.
Workspace: /home/jacen/projects/acs-worktrees/owner-full-auto.

This document amends docs/architecture/owner-full-auto.md after the security BLOCK in docs/architecture/owner-full-auto-security.md. It preserves the earlier document and its provenance, but supersedes its operator-plus-scopes owner assumption. It is the only normative implementation contract for owner binding and no-approval evidence.

1. Verified evidence boundary

Verified before writing this amendment:

- git status --short --branch reported ## feat/owner-full-auto plus the pre-existing untracked docs/architecture/ directory.
- git rev-parse HEAD reported f51094ef94ab2e7e7abfffa5f266c26c7d5496c4.
- Existing architecture input SHA-256: a9309ebe00b8d2dbdd0be9bc193268ad054f9b02efe02dff23b43ab150836123.
- Existing security report SHA-256: 6a067aebc32dd10aa98c8b9e5d5c638c24b75dd453aa9b2b5c65f1690654cdd0.
- Current source has GatewayCredential at apps/gateway/src/server.ts:207-218 with id, token, actor, actorId, roles, scopes, optional expiry and status; it currently has no issuer field.
- Current mode mutation is apps/gateway/src/server.ts:847-865 and currently calls requireMutationActor without the stronger owner predicate.
- Current mode persistence is packages/work-items/src/store.ts:5214-5276 and migration 027; migration 028 requires a human approval for JC privileged_exec at lines 22-28.

Only docs/architecture/owner-full-auto.md and this new document are writable in this task. No source, migration, tests, generated artifact, config, service, production state, commit, or external state is changed here.

2. Decisions frozen by this amendment

2.1 Owner identity and authentication

The owner is one explicitly configured principal. Configuration is a deployment input, not a mode selector:

- GatewayOptions gains a typed ownerPrincipal value loaded at process startup from a deployment-owned JSON file designated by ACS_OWNER_PRINCIPAL_FILE. The variable is a file location only; its contents are parsed by the canonical schema below. No ACS_MODE, full-auto boolean, request flag, or provider-specific authorization API is added.
- The file is required to activate the feature but is not required merely to run strict mode. If it is absent, unreadable, malformed, empty, duplicated, conflicting, or has unknown fields, owner-bound mode mutations fail closed. A production configuration validator must report the invalid configuration without exposing the file contents.
- The parsed value is immutable for the process lifetime. Changing owner configuration requires a controlled gateway restart; there is no hot reload that could race a mode mutation. Each mode mutation reads the same immutable owner snapshot and the canonical mode row in one store transaction.
- The file contains no token, secret, private key, or bearer credential. It is safe identity configuration, and must be permission-checked by the deployment/runbook owner. Authentication remains the existing credential verification and revocation/expiry checks.
- The source credential schema is extended with a non-secret issuer field. Existing credential fixtures must set it explicitly; no implicit issuer is accepted for owner operations. The resolved authenticated principal is `{ issuer, subject: actorId, actorId, roles, scopes }`, where issuer and actorId come from the verified credential registry, never from the request body, cookie actor, or MCP parameters.
- Exact matching is issuer equality plus actorId/subject equality, role membership exactly including `operator` and excluding `service`/`worker`, and set inclusion of both `acs:write` and `acs:approve`. Extra scopes do not confer owner authority. Revoked or expired credentials fail before owner matching. Local bearer, tunnel, bridge, worker, and generic service identities cannot match unless they are the explicitly configured authenticated operator credential and satisfy all exact checks; test fixtures use typed identities, not production identities.

Canonical owner configuration (versioned, strict, no unknown fields):

{
  "schemaVersion": "acs.full-auto-owner.v1",
  "issuer": "<authenticated-issuer>",
  "subject": "<credential-actor-id>",
  "actorId": "<credential-actor-id>",
  "requiredRole": "operator",
  "requiredScopes": ["acs:write", "acs:approve"]
}

The schema requires issuer, subject, and actorId to be non-empty bounded identifiers and requires subject equal actorId. It requires the exact role and exact two required scopes as a set (duplicates rejected). There is no bootstrap identity, first-caller trust, wildcard, prefix matching, or fallback to the old operator assumption. The configured principal does not select full_auto; it only authorizes the canonical mode mutation.

2.2 All mutation paths

POST /execution-mode, the CLI/local-admin mode command, and any future administrative adapter must call one owner-bound `setExecutionMode` application service. The service receives the server-derived authenticated principal, requested mode, bounded reason, and expected current row version; it rejects caller actor/owner fields and does not accept a boolean bypass. CLI/local-admin must authenticate through the same gateway/control-plane credential path or be unavailable; direct store calls and environment-only commands are not an administrative path.

Both activation to full_auto and deactivation to strict require the configured owner. Switching to strict is the emergency return-to-interactive operation, but it is not an unauthenticated break-glass path. The write and `execution_mode.changed` audit event are atomic, with a compare-and-swap row version. A concurrent switch wins only one transaction; the losing request is rejected and must retry after read-back. The response is read back from the committed row.

2.3 Mode lifetime and historical semantics

`execution_mode_state` remains the sole mode authority. A forward migration adds `full_auto` and a monotonic `revision`; migration 027 is never edited. Fresh and migrated databases seed strict. Missing, malformed, unknown, duplicate, or conflicting rows deny all governed execution and do not default to strict in memory. Existing admin remains readable/writable with its existing semantics until separately retired; it is never an alias for full_auto. A process restart re-reads the row and owner config; it does not carry an in-memory mode or owner decision across restart.

3. Versioned authorization bindings

3.1 Discriminated contract

Every admitted execution plan and issued capability carries exactly one ACS-owned authorization binding:

- `authorizationMode: "interactive_approved"` has the existing approval binding and existing approval ID/actor semantics. It is used only by strict/admin paths that actually require human approval.
- `authorizationMode: "full_auto"` has `approvalId: absent` and `approvedByActorId: absent`, plus a non-null `fullAutoAuthorization` object. An absent approval is valid only with this object; nulling fields or a fabricated approval is invalid.

Binding schema version is `acs.authorization-binding.v1`. The canonical bytes are strict canonical JSON; `bindingHash = SHA-256(canonicalBytes)`. IDs are opaque ACS-generated identifiers with uniqueness constraints. A caller cannot submit or override any binding field.

The full-auto object contains:

- bindingId, schemaVersion, authorizationMode;
- principal `{ issuer, subject, actorId }` from the authenticated request;
- modeRevision and modeStateHash, where modeStateHash covers the committed execution_mode_state row;
- policyVersion and policyDecisionHash;
- workItemId, planId, planHash, actionId, actionHash, inputHash;
- attemptId, leaseId, workerId, runtimeId, fencingEpoch;
- requiredScopesHash and capabilityScopeHash;
- issuedAt, expiresAt, bindingHash, and one-time result nonce hash.

All IDs/hashes are validated with existing safe identifier/SHA-256 schemas. Expiry is no later than the shorter of lease expiry, capability TTL, and the configured execution limit. A binding is immutable and append-only. `bindingHash` covers every field except the hash itself, and any mismatch denies.

3.2 Issuance and verification

A single mode-aware authorization/admission seam in packages/policy-gate returns a discriminated result consumed by both DC and JC gateway paths, worker claim, queued dispatch, and exact-id resume. The result is produced only after authentication, argument normalization, containment/runtime validation, current policy evaluation, and managed authority observation. Explicit policy deny, missing scope, unmanaged/ambiguous/expired authority, invalid runtime, and invalid mode deny before approval handling.

For full_auto the seam issues the ACS binding in the same transaction as plan/claim state, without calling gateApproval, approve_work_item, recordApproval, grantExecutionPlanApproval, hasApproval, consumeApproval, or any approval queue. It never creates approval_records, execution_plan_approvals, approval tokens, pending-approval transitions, or approval trace events. The plan may have zero approval IDs only when the full-auto binding verifies against the current mode revision, policy hash, action/plan/input hashes, lease, worker, runtime, epoch, and scope hash.

DC and JC call the same seam; JC's current privileged_exec approval foreign key/check is changed only by a forward migration owned by backend-api/data-ai and reviewed by security-policy. The new constraint permits either a verified interactive approval or a verified full-auto binding, never an unbound privileged capability. No external downstream verifier is assumed to mutate: apps/dc-mcp-gateway and apps/dc-relay remain verifiers/reporters. If their persisted schemas require changes, the minimal scope is their capability record/parser and conformance tests; ACS remains the issuer and authority.

Capability issuance re-verifies the binding and current lease inside the same database transaction as its append-only issuance record. Result submission verifies attempt, work item, action, plan, input, binding, lease, worker/runtime, and fencing epoch, and rejects replayed nonce/result hashes. Policy is re-evaluated at plan creation, claim, capability issuance, and exact-id resume. A mode switch affects the next authorization transaction; it does not revoke in-flight leases, which remain expiry/fencing governed.

4. Storage and migration contract

Forward migration 029 (name to be assigned by migration registry, without editing 027/028) must:

- widen the canonical mode check to strict/admin/full_auto and add NOT NULL revision with a unique single-row invariant;
- add an append-only authorization_bindings table with bindingId primary key, mode discriminator, canonical binding hash, all binding fields above, approvalId nullable only for full_auto, and checks enforcing exactly one discriminator;
- add foreign keys from execution plans/attempts and capability issuance records to the binding and append-only update/delete triggers;
- replace JC's approval-only privileged check with the verified interactive-or-full-auto binding invariant and retain lease/work/attempt/action/request/invocation uniqueness;
- add indexes for binding lookup, lease/attempt, mode revision, expiry, and result nonce replay prevention;
- preserve existing rows and semantics; no existing interactive approval is converted or consumed.

All writes that create a full-auto plan, claim an attempt, issue a binding/capability, consume a result nonce, or change mode must occur in the existing SQLite transaction boundary. The transaction reads the mode row and revision, validates owner/config or execution principal as applicable, validates lease and fencing, then writes; stale revision or lease causes rollback. Queue admission remains memory-only and creates no binding, approval, lease, or claim. Resume recreates/revalidates a binding only after fresh policy, integrity, mode, and lease checks.

5. Audit contract

Full-auto emits ACS-owned `execution_mode.full_auto_authorized` or `execution_mode.full_auto_denied`, then normal policy/admission/claim/capability/result events as applicable. Full-auto audit payloads include `approvalMode: "full-auto"`, `interactiveApprovalSkipped: true`, authorization binding ID/hash, derived principal issuer/subject/actorId, mode revision, work/attempt/plan/action/policy hashes, lease/worker/fencing fields when available, timestamp, outcome, and bounded failure code. They never include approval IDs, raw arguments, tokens, secrets, private keys, capability material, or unrestricted output. No approval.requested/granted/consumed event is emitted. Mode-change audit records actor, old/new mode, revision and bounded reason.

6. Fail-closed matrix

- Missing/invalid/conflicting owner config: reject activation and deactivation; mode unchanged.
- Owner issuer mismatch, subject mismatch, actor spoofing, non-operator, service/worker role, missing either required scope, revoked/expired credential: reject mutation; mode and audit unchanged.
- Missing/corrupt/unknown mode row or revision conflict: deny execution/mutation; no approval/binding/capability.
- Full-auto policy deny, invalid containment, missing capability scope, unmanaged/ambiguous/expired authority, invalid runtime: deny; no approval row, binding, lease, or capability.
- DC or JC approval-classified success: verified full-auto binding, zero approval rows/IDs/events/tokens, normal capability and result checks remain.
- JC privileged execution without either verified human approval or full-auto binding: deny.
- Queue full/timeout: structured backpressure only; no approval/binding/lease.
- Existing pending interactive item: remains interactive; no auto-conversion or approval consumption.
- Stale mode revision, action/plan/input hash, lease, worker, runtime, epoch, binding, nonce, or result: rollback/reject and audit bounded failure.
- Unknown old client receiving full_auto: fail closed; it cannot treat the response as strict/admin or invoke an approval endpoint.

7. Source seams and ownership

- AuthN/credential issuer metadata and exact resolved principal: backend-api, apps/gateway/src/server.ts:199-240 and auth boundary; AuthN behavior unchanged.
- Owner config parser/validator and immutable GatewayOptions snapshot: backend-api, apps/gateway/src/production-config.ts and server wiring; no production value is supplied here.
- Owner mutation service and HTTP/CLI routing: backend-api, apps/gateway/src/server.ts:837-865 and apps/cli/src/dispatch.ts; both use the same service.
- Mode state, revision, binding persistence and transaction APIs: backend-api/data-ai, packages/work-items/src/store.ts:5214-5276 plus forward storage migration.
- Central mode-aware result and policy ordering: backend-api, packages/policy-gate/src/execution-mode.ts and tools.ts:248-431.
- DC/JC shared consumption and capability verification: backend-api, apps/gateway/src/server.ts:1784-2017 and 2266-2409; downstream parser/minimal schema changes are explicitly owned by backend-api/infra-platform.
- Worker/queue/resume/result fencing: backend-api/infra-platform, apps/worker/src/index.ts:181-310 and scheduler/dispatch callers.
- UI truthful mode display/switch-back: frontend-engineer; no UI authority.
- Security gate and adversarial review: security-policy then red-team-reviewer. Implementation cannot begin before independent re-review of this document and the amended architecture hash.

8. Acceptance and handoff

Required implementation tests include typed owner/non-owner/service/operator/missing-scope/spoofed-principal mutations; missing/invalid/conflicting config; activation/deactivation/switchback; strict/admin compatibility; DC and JC positive zero-approval execution; privileged JC negative unbound execution; policy/capability/lease/fencing denial; queue/resume; restart; replay/hash mismatch; audit redaction; unknown-client fail-closed; and database read-back assertions. Run the focused suites from owner-full-auto.md and `npm run check`, plus the repository's lint/typecheck/build commands, recording exact exits. No implementation or QA claim is made by this document.

Runnable post-review handoff is to backend-api:

- task_id: t_f8e66479 (security gate)
- to: backend-api
- objective: implement this exact owner-bound full-auto binding and shared DC/JC no-approval seam after security re-review
- scope_paths: apps/gateway/src/server.ts, apps/gateway/src/production-config.ts, apps/cli/src/dispatch.ts, packages/policy-gate/, packages/work-items/, storage/migrations/, apps/worker/, apps/dc-mcp-gateway/, apps/dc-relay/, affected protocol/tests
- inputs: this document; amended owner-full-auto.md; security report; baseline f51094ef94ab2e7e7abfffa5f266c26c7d5496c4
- acceptance: all tests and negative matrix above, zero approval artifacts on full-auto success, exact commands/exits, read-back evidence
- forbidden: client/request/env mode bypasses, default allow, synthetic approvals/tokens, unbound capabilities, production provisioning/activation, commit/push/deploy before gates

This architecture task has no source changes and no implementation verification beyond document custody/hash checks.
