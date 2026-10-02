# Plan: retire global admin mode in favour of mission-scoped grants

Status: proposed. Owner: operator decision required at each phase gate.

## Where we are

| Capability                                                                            | Today                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Global admin mode (`execution_mode_state`)                                            | One row, applies to every approval-gated Desktop Commander and Jace Commander call. Now needs `acs:execution-mode:admin`, a stated reason, and lapses after `ACS_ADMIN_MODE_TTL_MS` (default 1h). Still global.                                                                                                           |
| Mission-scoped Autonomous Authority Grants (migration 047, `autonomous-authority.ts`) | Immutable, hash-bound, revocable, limited by resource scope, tool allowlist, maximum privileges, expiry and operation counts. Consumed by the Change Set / DC path (`/work-items/:id/authority-grants`, `/change-sets/authorize`). `docs/protocol/change-sets.md` states no global switch may grant Change Set authority. |
| Jace Commander and ordinary gated tools                                               | Still authorized by the global admin row (`acs:admin` approvals, `server.ts` JC issuance path).                                                                                                                                                                                                                           |
| Open PR #245                                                                          | Extends global admin to `privileged_exec`. Moves in the opposite direction from this plan.                                                                                                                                                                                                                                |

The gap: grants exist, but the paths operators actually use for YOLO-style work still lean on the global row, so the global row cannot yet be removed.

## Target

Admin mode becomes a thin, optional compatibility switch that is off by default and eventually removed. Autonomy is expressed as a grant that is bound to a mission, an executing actor, a resource scope, a tool allowlist, a privilege ceiling, an expiry and operation budgets, and that can be revoked.

## Phases

### Phase 0: contain the global switch (PR #251)

Dedicated scope, required reason, 1h TTL, confirm dialog. Exit: merged; TTL observed in the audit chain.

### Phase 1: decide `privileged_exec` (blocks #245)

Decision needed before anything else: root execution must either stay human-only or require a grant that names `privileged_exec` and a privilege ceiling. Recommendation: keep it human-only under global admin; allow it only through a grant with explicit `privileged` maximum privilege and a short expiry. Exit: #245 is rewritten or closed accordingly.

### Phase 2: grants for Jace Commander

- Wire the JC issuance path (`server.ts` near the `hasGrantedApprovalBy(..., ACS_ADMIN_APPROVER)` checks) to accept an active grant as an alternative to the `acs:admin` approval.
- The grant schema already allows `runtime: "jace_commander"`; add resource mapping for JC tools and tests that a grant never widens beyond policy (denials remain denials).
- Exit: a mission can run approval-gated JC tools with admin mode `strict`.

### Phase 3: grant-first UI

- Mission Control: a "Grant autonomy" flow on a mission (scope, tools, expiry, budget) with the same confirm-and-reason pattern as the admin dialog; revoke button; countdown.
- Admin toggle moves under an "Advanced / legacy" disclosure with the TTL shown.
- Exit: operators can complete a normal YOLO workflow without touching the global switch.

### Phase 4: deprecate global admin

- Default `ACS_ADMIN_MODE_TTL_MS` down to 15 minutes; emit a deprecation audit event whenever admin auto-authorizes something a grant could have covered.
- After one release with zero such events, remove the admin row path and the `acs:execution-mode:admin` scope (migration, contracts baseline, breaking-change entry).

## Invariants every phase must keep

- Policy denials are never promoted by a grant or by admin mode.
- Issuer is a human `user` credential; the executing actor can never be the issuer.
- Jev is observational only and has no input into grant evaluation.
- Every auto-authorization is attributable in the hash-chained audit log to a grant ID or an admin-mode row.

## Risks

- Two authorization systems coexisting during Phases 2 to 3: tests must assert that a grant and admin mode never compound.
- Migration numbering is already contended (two `039_*`, `040` in #245): coordinate before adding any schema in these phases.
