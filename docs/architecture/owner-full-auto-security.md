# Owner-controlled full-auto security gate

Status: BLOCK — design review only; no source, migration, UI, database, activation, deployment, commit, or external state was changed by this task.

Baseline: `f51094ef94ab2e7e7abfffa5f266c26c7d5496c4` on `feat/owner-full-auto`.
Workspace: `/home/jacen/projects/acs-worktrees/owner-full-auto`.

## Evidence boundary

Verified inputs:

- `docs/architecture/owner-full-auto.md` exists and was read in full (201 lines).
- SHA-256: `a9309ebe00b8d2dbdd0be9bc193268ad054f9b02efe02dff23b43ab150836123`.
- `git status --short --branch`: `## feat/owner-full-auto` plus the pre-existing untracked `docs/architecture/` directory containing the architecture input; no source or migration changes are present.
- `git rev-parse HEAD`: `f51094ef94ab2e7e7abfffa5f266c26c7d5496c4`.
- `git diff --check`: exit 0.

The architecture document is the input contract, not independent evidence. The source findings below were independently inspected at the cited lines.

## Verdict and material block

The proposed contract is not security-ready for implementation. Two material blockers remain:

1. **Global owner authority is unresolved and currently over-broad.** The architecture proposes authenticated `operator` plus `acs:write` and `acs:approve` as the smallest available owner authority, while also admitting that the repository has no distinct owner predicate. That is not an owner binding: every credential carrying those ordinary operator scopes could change the single global execution mode. Current `requireMutationActor` accepts either `operator` or `service` and checks only one requested scope (`apps/gateway/src/server.ts:3606-3629`), and the mode route calls it without the stronger approve scope (`apps/gateway/src/server.ts:847-860`). `setExecutionMode` trusts its caller-derived string and permits both modes (`packages/work-items/src/store.ts:5237-5275`). Jace must establish or explicitly authorize a canonical, authenticated owner predicate before implementation. No environment flag, request field, service credential, worker identity, or client/UI state may substitute for it.

2. **The actual positive path is approval-producing, not approval-free, and JC is approval-bound.** The existing DC admin path calls `tools.approve_work_item` (`apps/gateway/src/server.ts:1825-1846`), which records a human-shaped approval through `gateApproval`/`store.recordApproval` (`packages/policy-gate/src/tools.ts:118-181`), then emits `approval.granted` as verified by the existing regression test (`apps/gateway/src/execution-mode.test.ts:203-248`). This directly violates the required full-auto invariant of zero approval rows, tokens, approval events, and human-style state. The existing worker and exact-id claim paths require plan approvals and consume them (`packages/policy-gate/src/tools.ts:293-336` and `392-429`). JC explicitly rejects the admin branch and returns a human approval wait (`apps/gateway/src/server.ts:2266-2277`), then requires an approval binding before capability issuance (`server.ts:2353-2359`). In addition, the persisted JC capability schema requires `privileged_exec` to have a non-null non-`acs:admin` approval (`storage/migrations/028_jace_commander_capabilities.sql:22-28`). A no-approval full-auto path therefore cannot be reached by a mode enum change alone; it needs a deliberately reviewed no-approval authorization binding and forward migration/schema contract, without weakening verification.

This is a security BLOCK, not a release recommendation. Only Jace may clear it. Source implementation must remain frozen until both blockers have a concrete decision and executable acceptance tests.

## Frozen security contract for implementation after block clearance

These are required controls, not optional hardening:

- Keep `execution_mode_state` as the sole persisted authority. Add only `full_auto` through a forward migration; do not edit migration 027 or add a second mode flag/provider. Missing, malformed, or conflicted state denies. `strict` remains the seeded and emergency return mode; `admin` remains compatibility-only and is not an alias.
- Owner activation and deactivation must be an authenticated, server-derived principal operation. The request body cannot provide actor, authority, approval, lease, or ownership. The implementation must require the canonical owner predicate plus `acs:write` and `acs:approve`; service, worker, bridge, and ordinary agent credentials must fail closed. The mutation must be atomic with `execution_mode.changed`, bounded-reason redaction, and read-back verification.
- Full-auto must bypass only human approval, never policy. For every DC and JC action: authenticate the caller; validate protocol/tool arguments and containment; evaluate policy; preserve explicit deny; validate managed runtime, unambiguous current executor authority, lease, expiry, and fencing; admit capacity; claim exact work; issue the normal capability; and validate the result binding.
- A single centralized mode-aware authorization result must be consumed by DC, JC, worker claim, queued dispatch, and exact-id resume. It must explicitly represent `approvalRequired: false` without calling approval request/record/grant/has/consume functions. No approval row, execution-plan approval, approval token, pending-approval transition, approval queue, or human wait may be created for a full-auto authorization.
- No-approval execution must still be represented by an ACS-owned, immutable authorization binding in the plan/claim/capability records. That binding must contain the current mode decision, derived principal, policy decision/version hash, action hash, plan hash, attempt, lease, worker/runtime identity, fencing epoch, issue/expiry times, and appropriate scope/capability data. It must not accept caller-supplied authority fields. The storage constraints and capability payloads for both DC and JC must be updated via forward migrations and tested so they permit only this explicit ACS binding, never an unbound capability.
- Existing human approvals are not silently converted or consumed by full-auto. Existing `needs_approval` work remains interactive or is handled by a separately approved migration/UX contract. A full-auto request must re-evaluate policy, action/plan/input integrity, current authority, and ownership on fresh resume.
- Switching to strict affects the next authorization decision and is durable/audited. In-flight leases are not retroactively revoked; they remain subject to expiry and fencing. Invalid mode/configuration must fail closed.
- Full-auto audit events must attribute the derived owner/caller, work item, attempt, tool, action hash, policy hash/version, mode, outcome, and lease/worker/fencing fields when available. They must contain bounded codes/digests only. No raw arguments, tokens, secret environment values, capability material, or unrestricted command output. Full-auto must emit no `approval.requested`, `approval.granted`, or `approval.consumed` events.
- UI may display `FULL AUTO` and effective owner/time, but must not render approval controls/counts as if full-auto were interactive. Return-to-interactive must be an authenticated server mutation whose confirmed response reflects the durable audit-backed strict state.

## Source-to-control threat map

| Threat / invariant | Current evidence | Required enforcement and negative test |
| --- | --- | --- |
| Any operator/service can alter global authority | `server.ts:3606-3629`, `server.ts:847-860` | Canonical owner predicate; operator-only (not service); both scopes; spoofed actor/request fields rejected; unauthorized activation leaves row/audit unchanged. |
| Mode row bypass or fail-open default | `execution-mode.ts:30-40`; `store.ts:5214-5234`; migration `027:6-16` | Add `full_auto` only in canonical schema; missing/corrupt/unknown denies on every path, including restart/resume. |
| Human-style approval forged in full-auto | `server.ts:1825-1867`; `tools.ts:118-181`; existing test `execution-mode.test.ts:203-248` | Shared result must never invoke approval APIs; assert zero `approval_records`, plan approvals, and approval trace events after DC and JC success. |
| JC remains interactive or becomes unbound | `server.ts:2266-2277`, `2353-2359`; migration `028:22-28` | Shared seam covers JC; no approval is acceptable only with explicit ACS mode binding; privileged tools retain all capability, lease, scope, and policy checks. |
| Worker/resume approval assumptions bypass mode | `tools.ts:269-336`, `368-429` | Mode-aware claim/admission contract for queue and exact-id resume; stale action/plan/input/lease/fencing and replayed result tests deny. |
| Capability/lease authority is weakened | `server.ts:1890-1999`, `2290-2359` | Full-auto capability still binds attempt, lease, worker/runtime, plan/action/input hashes, scopes, expiry, and fencing; stale owner/result tests deny. |
| Policy deny promoted to allow | `execution-mode.ts:97-136`; gateway policy checks `server.ts:1780-1801`, `2253-2264` | Explicit deny remains deny in both modes; missing capability, containment, unmanaged/ambiguous/expired authority all deny without approval artifacts. |
| Audit leaks or loses attribution | `store.ts:5261-5275`; gateway mode events `server.ts:1808-1817`, `1857-1867` | Structured mode decision/outcome events with derived principal and bounded fields; redaction tests reject tokens, raw args, secrets, and capability material. |
| Return-to-interactive is client-only | UI mode mutation currently routes through `server.ts:847-860` | Server mutation plus durable read-back/audit confirmation; a stale UI cannot authorize execution. |

## Required executable acceptance packet

After the owner predicate and no-approval storage/capability design are approved, implementation must add and run tests covering all of the following (database read-back required):

1. Fresh/migrated database is strict; full-auto activation and strict switch-back are authenticated, owner-bound, atomic, durable, and audited.
2. Unauthenticated, service, non-owner, missing-scope, spoofed-actor, malformed-mode, empty-reason, missing-row, corrupt-row, and conflicting-authority mutations fail closed with no state change.
3. DC and JC approval-classified positive actions reach capability issuance/execution with zero approval rows, zero plan-approval rows, and zero approval trace events; neither path calls human approval APIs.
4. Explicit policy deny, missing scope/capability, invalid containment/runtime identity, unmanaged/ambiguous/expired lease, break-glass conflict, stale fencing, replayed result, action/plan/input mismatch, and invalid worker identity deny with no capability or approval artifact.
5. Worker claim, queued dispatch, and exact-id resume use the same mode-aware decision. Queueing creates no lease/claim/approval; resume performs fresh policy and integrity validation.
6. Result records remain bound to current attempt, action hash, plan hash, lease, worker, runtime, and fencing epoch; stale workers cannot publish or consume authority.
7. Audit output contains required attribution and bounded codes/digests while excluding secrets, tokens, raw arguments, unrestricted output, and capability material.
8. Unknown clients fail closed on `full_auto`; UI shows `FULL AUTO`, hides misleading approval controls, and confirmed switch-back shows strict.
9. Run the focused suites named by the architecture contract, then `npm run check` and the repository's required lint/typecheck/build commands. Record exact exits and relevant output.

## Verification limitation

Attempted command:

`npx vitest run apps/gateway/src/execution-mode.test.ts packages/policy-gate/src/execution-mode.test.ts`

Observed result: exit `-1`, blocked before test execution by the Hermes security scan because Vitest package threat-intelligence metadata lookup timed out in single-query mode. This is incomplete verification, not a test pass or a claim that the package is unsafe. The current source/test inspection is therefore static evidence only.

## Handoff

No implementation handoff is runnable until Jace clears the material block. Once cleared, the implementation handoff is to `backend-api` with:

- `task_id`: `t_f8e66479` (security gate)
- `to`: `backend-api`
- `objective`: implement the approved owner-bound `full_auto` mode and one no-approval authorization seam without weakening policy, capability, lease, fencing, result, or audit invariants
- `scope_paths`: `storage/migrations/`, `packages/work-items/`, `packages/policy-gate/`, `apps/gateway/`, `apps/worker/`, `apps/dc-mcp-gateway/`, `apps/dc-relay/`, and affected protocol tests/docs
- `inputs`: architecture hash `a9309ebe00b8d2dbdd0be9bc193268ad054f9b02efe02dff23b43ab150836123`; this report; owner predicate and no-approval binding decision from Jace
- `acceptance`: all executable acceptance items above, with exact observed commands/exits and database read-back assertions
- `forbidden`: environment/request/UI bypasses; auto-created human-style approvals; unbound capabilities; default-allow fallbacks; source changes before block clearance; production activation/deployment

## Final result

```result
verdict: BLOCK
role: security-policy
task_id: t_f8e66479
result: The frozen architecture is useful but cannot pass security review: owner authority is not canonically bound, and current DC/JC/claim paths require or create approval artifacts, so no-approval full-auto is not reachable by the proposed mode addition alone.
changes: Added docs/architecture/owner-full-auto-security.md only.
verification: git status --short --branch (observed); git rev-parse HEAD -> f51094ef94ab2e7e7abfffa5f266c26c7d5496c4; sha256sum docs/architecture/owner-full-auto.md -> a9309ebe00b8d2dbdd0be9bc193268ad054f9b02efe02dff23b43ab150836123; git diff --check -> exit 0; targeted npx vitest command blocked before execution by Hermes package threat-intelligence timeout (exit -1).
risks: Global mode can currently be changed by ordinary operator/service mutation authority; implementing full-auto as admin auto-approval would fabricate human approvals and JC cannot issue privileged capabilities without approval under current schema.
unknowns: Jace has not selected a canonical owner principal predicate or approved the explicit ACS no-approval capability binding/storage contract.
handoff: blocked pending Jace decision; after clearance, runnable backend-api handoff is specified above.
next: Jace must clear the owner-binding and no-approval binding decisions; then backend-api implements and QA/red-team reruns the acceptance packet. No activation/deployment is authorized.
```

## Independent re-review after owner and binding amendment

The original BLOCK above is preserved verbatim as historical provenance. The corrected inputs were independently read and hashed: `owner-full-auto.md` SHA-256 `4da6cdf9f26c1be70b552ad17bfd262e0dd408e0f45bc496f98efbc04b91e8db`; `owner-full-auto-binding.md` SHA-256 `667eb9f7563be99f6b84c93bfd7d7d7c7ff445d20b3889c5442ed5fa5020e9b8`; baseline/HEAD `f51094ef94ab2e7e7abfffa5f266c26c7d5496c4`.

Re-review findings and resolutions:

- Owner authority is now a typed immutable configured principal, exact issuer plus subject/actorId, operator role, and both `acs:write` and `acs:approve`; it excludes ordinary operators, services, workers, bridges, legacy synthesized credentials, request fields, and UI/environment mode flags. Both full-auto activation and strict deactivation use the same owner-bound service and transactional revision fence.
- The source currently has no issuer on `GatewayCredential` (`apps/gateway/src/server.ts:207-218`), while authentication has issuer provenance. This is an explicit backend implementation seam: add and validate issuer at the credential boundary; legacy credentials without explicit issuer are ineligible for owner mutation. It is not a fallback or new authority provider.
- Actual migrations already occupy 029 through 036. The reconciled contract therefore assigns the forward migration to 037, without editing 027, 028, or any released migration.
- The amended binding's apparent pre-claim attempt/lease contradiction is resolved in `owner-full-auto-reconciled.md`: plan admission carries mode/policy evidence; the immutable full-auto execution binding is created claim-time with attempt/lease/worker/fencing fields in the same transaction as authoritative claim. Capability issuance and result submission re-verify it transactionally.
- Current DC approval creation (`apps/gateway/src/server.ts:1804-1877`), JC human wait (`:2266-2277`), JC approval check (`:2353-2360`), worker/exact-id approval checks (`packages/policy-gate/src/tools.ts:269-337,368-430`), and JC schema constraints (`storage/migrations/028_jace_commander_capabilities.sql`, `029_jace_commander_tool_allowlist.sql`, `031_jace_commander_operations.sql`) are explicitly implementation seams. Full-auto must not invoke or write those approval artifacts and must retain all policy, scope, lease, capability, result, and audit fences.

Verdict: PASS for this design-only security gate, not a source/release/deployment approval. No semantic authority ambiguity remains in the frozen contract. The production owner principal is intentionally unprovisioned and is a deployment input, not a new authority decision. Implementation must follow the reconciled document exactly; deviation reopens this gate.

```result
verdict: PASS
role: security-policy
task_id: t_f8e66479
result: Independent re-review passes the amended owner-bound full-auto/no-approval design for implementation after reconciling owner identity, credential issuer provenance, migration numbering, actual DC/JC approval seams, and claim-time binding transaction boundaries.
changes: Preserved the original BLOCK verbatim and appended this re-review; added docs/architecture/owner-full-auto-reconciled.md.
verification: git status --short --branch and git rev-parse HEAD observed; sha256sum verified amended architecture inputs and preserved report; git diff --check exit 0; source and migration seams independently read at cited paths. No runtime tests were claimed because source implementation is not present.
risks: Broad cross-package implementation remains security-sensitive; any deviation from the reconciled binding, owner predicate, migration, or zero-approval contract requires re-review.
unknowns: Production owner principal value is intentionally unspecified; no semantic contract decision depends on it.
handoff: backend-api, then qa-test and red-team-reviewer, with a later security re-gate after implementation.
next: implement only the scoped contract; do not activate, deploy, commit, or publish from this design gate.
```
