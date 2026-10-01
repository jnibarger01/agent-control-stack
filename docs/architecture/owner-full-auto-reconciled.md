# Owner-controlled full-auto: security reconciliation

Status: PASS — design gate only. This document reconciles the amended owner/full-auto contract for implementation; it does not authorize activation, deployment, commit, or source mutation.

Baseline and custody

- Baseline/HEAD: f51094ef94ab2e7e7abfffa5f266c26c7d5496c4.
- Branch: feat/owner-full-auto.
- Workspace: /home/jacen/projects/acs-worktrees/owner-full-auto.
- Input SHA-256: docs/architecture/owner-full-auto.md = 4da6cdf9f26c1be70b552ad17bfd262e0dd408e0f45bc496f98efbc04b91e8db.
- Input SHA-256: docs/architecture/owner-full-auto-binding.md = 667eb9f7563be99f6b84c93bfd7d7d7c7ff445d20b3889c5442ed5fa5020e9b8.
- Preserved prior report SHA-256 before this append: docs/architecture/owner-full-auto-security.md = 6a067aebc32dd10aa98c8b9e5d8c638c24b75dd453aa9b2b5c65f1690654cdd0.
- Current worktree has only the pre-existing untracked docs/architecture directory; no source or migration files were changed.

Verified source seams and reconciled controls

1. The sole authority remains execution_mode_state. Current read/write seams are packages/work-items/src/store.ts:5214-5276, policy interpretation is packages/policy-gate/src/execution-mode.ts:3-136, and HTTP mutation is apps/gateway/src/server.ts:847-865. Implementation adds full_auto and revision only by a new forward migration. Migration 027 is not edited. The next available migration number is 037, because tracked migrations already include 029, 030, 031, 032, 033, 034, 035, and 036. Missing, malformed, unknown, duplicate, or conflicting mode state denies; healthy fresh and migrated databases remain strict. Admin remains compatibility-only and is not an alias.

2. Owner mutation is a single application service used by POST /execution-mode and any CLI/administrative adapter. The service receives only the server-derived authenticated principal, requested mode, bounded reason, and expected revision. It rejects request actor/owner fields, booleans, and direct store/admin paths. Activation to full_auto and return to strict both require the configured owner. The write, compare-and-swap revision, and execution_mode.changed audit event are one transaction; the response is read back from committed state.

3. Owner identity is an immutable startup configuration snapshot parsed from ACS_OWNER_PRINCIPAL_FILE. The file is not a mode switch and contains no credential. Its strict schema is the v1 schema in owner-full-auto-binding.md. The implementation must add the missing GatewayCredential issuer field noted at owner-full-auto-binding.md:17 and validate it at the credential boundary; no implicit issuer is accepted for owner mutation. Legacy credentials synthesized by matchGatewayCredential at apps/gateway/src/server.ts:3745-3757, device credentials at :3762-3783, service/worker credentials, tunnel/bridge identities, and ordinary operators without an exact configured issuer+actorId match are ineligible. Authentication, revocation, and expiry are checked before exact issuer, subject/actorId, operator-role, and required-scope matching. Invalid or unavailable owner configuration fails closed without exposing file contents. The real production principal is intentionally unprovisioned here; that is deployment input, not an authority ambiguity.

4. Current DC and JC paths are not reused as approval paths. DC currently auto-creates human-shaped approval evidence at apps/gateway/src/server.ts:1804-1877; JC currently waits for human approval at :2266-2277 and checks a lease approval at :2353-2360. Worker and exact-id claim similarly require and consume approvals at packages/policy-gate/src/tools.ts:269-337 and :368-430. Implementation replaces these mode branches with one discriminated policy/authority result consumed by DC, JC, worker claim, queued dispatch, and exact-id resume. In full_auto, policy deny, containment/runtime failure, missing scopes, unmanaged/ambiguous/expired authority, lease failure, and fencing failure remain deny. No gateApproval, approval record, execution-plan approval, approval token, approval queue, pending-approval transition, or approval trace event is called or written.

5. Binding lifecycle is corrected to remove a transaction contradiction in the amended document. A plan is admitted with mode, plan hash, policy version/hash, and an ACS-owned authorization mode, but it cannot contain attempt/lease fields before claim. The immutable full-auto execution binding is created only in the same transaction as authoritative attempt claim and lease creation; it then carries bindingId, schemaVersion, authorizationMode=full_auto, derived principal, mode revision/state hash, policy version/decision hash, work/plan/action/input hashes, attempt/lease/worker/runtime/fencing fields, scope hashes, issued/expiry times, and one-time result nonce hash. Capability issuance re-verifies that binding and the live lease in its own transaction. Thus every claimed attempt and capability has exactly one verified binding, while no pre-claim object contains fabricated or nullable authority. Interactive strict/admin claims retain their existing approval binding and must never be represented as full_auto.

6. ACS is the issuer and verifier of this binding. Downstream apps/dc-mcp-gateway and apps/dc-relay remain reporters/verifiers and do not become authority providers. If their persisted capability schema needs adaptation, backend-api/infra-platform must add the minimal parser/storage/conformance change; no external verifier or undocumented schema is assumed. The next migration is 037 and must add the binding table/constraints, revision, and the JC interactive-or-full-auto constraint while preserving existing rows. It must retain append-only guards, lease/work/attempt/action/request uniqueness, and nonce replay prevention. It must not convert or consume pending interactive approvals.

7. All plan/claim/binding/capability/result writes that depend on mode, lease, revision, or fencing occur in existing SQLite transaction boundaries. The transaction reads the canonical mode row and revision, and stale revision, lease, action/plan/input hash, worker/runtime, epoch, binding, or nonce rolls back. A strict switch affects the next authorization transaction; in-flight leases remain expiry/fencing governed. Queue admission remains memory-only and creates no approval, binding, lease, or claim. Resume performs fresh policy, integrity, mode, and lease validation before recreating a binding.

8. Audit remains canonical and redacted. Full-auto emits ACS-owned mode decision events and normal policy/admission/claim/capability/result events, with derived principal, work/attempt/plan/action/policy hashes, mode revision, lease/worker/fencing fields when available, timestamp, outcome, and bounded failure code. It emits no approval.requested/granted/consumed event and includes no approval ID, raw arguments, tokens, secrets, private keys, capability material, or unrestricted output. Owner mutation records derived actor, old/new mode, revision, and bounded reason.

Required implementation and negative-test contract

- Owner schema: valid exact owner activation and deactivation; missing, malformed, unknown-field, duplicate/conflicting, unreadable, revoked, expired, legacy, service, worker, spoofed-actor, wrong-issuer, wrong-subject, wrong-role, and missing-scope cases leave mode and audit unchanged.
- Mode: fresh/migrated strict, durable full_auto activation, durable strict switch-back, revision conflict, restart/resume, missing/corrupt/unknown state, admin compatibility, and unknown-client fail-closed cases.
- DC and JC: approval-classified positive execution reaches capability issuance and result with zero approval_records, zero execution_plan_approvals, zero approval IDs, and zero approval trace events. JC privileged execution without a verified interactive approval or full-auto binding denies.
- Shared seam: DC, JC, worker claim, queue, and exact-id resume use the same mode-aware result. No lane invokes human approval APIs in full_auto.
- Authority: explicit policy deny, missing scope/capability, containment/runtime failure, unmanaged/ambiguous/expired authority, stale lease/fencing, action/plan/input mismatch, invalid worker identity, replayed nonce/result, and binding hash mismatch deny with no capability or approval artifact.
- Binding/result: capability and result are bound to current mode revision, principal, work, plan, action, input, attempt, lease, worker/runtime, epoch, expiry, and nonce; read-back assertions verify all fields and redaction.
- Run focused architecture suites plus npm run test, npm run lint, npm run typecheck, npm run check, and npm run build. A scanner-blocked command is not a pass.

Scoped runnable handoff

- task_id: t_f8e66479
- to: backend-api
- objective: implement the exact owner-bound full_auto mode, revision, ACS-owned claim-time binding, and shared DC/JC/worker/queue/resume no-approval seam.
- scope_paths: apps/gateway/src/server.ts; apps/gateway/src/production-config.ts; apps/cli/src/dispatch.ts; packages/policy-gate; packages/work-items; storage/migrations/037_*; apps/worker; apps/dc-mcp-gateway; apps/dc-relay; affected protocols and tests.
- inputs: this document; owner-full-auto.md hash above; owner-full-auto-binding.md hash above; preserved security report and its appended re-review; baseline f51094ef94ab2e7e7abfffa5f266c26c7d5496c4.
- acceptance: all negative and positive tests above, zero approval artifacts on full-auto success, transactional read-back evidence, exact command exits, and independent QA/red-team review.
- forbidden: request/client/UI/environment mode bypasses; default allow; synthetic approvals/tokens; unbound capability; editing historical migrations; production provisioning/activation; commit/push/deploy before downstream gates.

result
verdict: PASS
role: security-policy
task_id: t_f8e66479
result: The amended owner predicate and ACS-owned no-approval mechanism are security-coherent for implementation after reconciling actual source seams, existing migration numbering, credential issuer provenance, and claim-time binding transaction boundaries. This is a design-only gate; source remains frozen.
changes: Added this reconciliation document and appended a re-review to owner-full-auto-security.md while preserving the original BLOCK verbatim.
verification: git status --short --branch; git rev-parse HEAD; sha256sum; git diff --check; independent reads of the two architecture inputs and source seams listed above. Runtime test execution remains implementation scope; the prior scanner-blocked test attempt is not represented as passing.
risks: Implementation spans gateway, policy-gate, work-items, migrations, worker, DC/JC adapters, protocols, and tests; any deviation from this contract reopens the security gate.
unknowns: The production owner principal value is intentionally not supplied; no semantic authority decision depends on that value.
handoff: backend-api implementation with QA and red-team review after implementation.
next: implement without activation/deployment, then run the complete acceptance packet and request independent security re-gate.
