# Protocol Specification: Approval Lifecycle

## Purpose

This document defines how approval-gated actions move from request to execution.

**Amended 2026-07-23:** this document previously described an out-of-band bearer-token flow (raw token shown once to a human, re-presented at execution) that was never implemented. It has been rewritten to describe the mechanism actually enforced by `packages/policy-gate` and `packages/work-items`. See [ADR 0004](../adr/0004-request-bound-approval-tokens.md) for the reasoning behind dropping the bearer-token requirement.

## States

```text
needs_approval -> approved -> consumed
needs_approval -> rejected
approved -> expired
```

`consumed` is not a distinct work-item status; it is the state of the underlying approval record once a worker claim has used it (`approval_records.status`). The work item itself moves `approved -> running` on claim.

## Action hash

The action hash binds an approval to exact action content. It is computed by `actionFingerprint` (`packages/policy-gate/src/fingerprint.ts`) over the `PolicyContext` it's called with (`packages/policy-gate/src/policy.ts`) — note `action` is a nested object and `risk` is the work item's own risk level, not the policy decision outcome:

```json
{
  "requester": "actor-id",
  "risk": "high",
  "action": {
    "kind": "fs_write",
    "description": "...",
    "params": {}
  },
  "command": ["npm", "run", "build"],
  "cwd": "/normalized/path",
  "destructive": false,
  "network": false,
  "write": true,
  "paths": ["..."]
}
```

`risk` is one of `low | medium | high | critical` (`policyContextSchema`); `command`, `paths`, `cwd`, `network`, `write`, and `destructive` are all optional depending on the action kind.

Hash algorithm: `stableHash(...)` (`packages/shared`) — a deterministic canonical-JSON hash, sha256-based.

A second, derived value, the **request hash** (`approvalRequestHash`, `packages/work-items/src/store.ts`), is `stableHash({ actionHash, workItemId })`. It binds a stored approval row to a specific work item + action-hash pair. It is not a secret and is not treated as one — it is a consistency check, not a credential.

## Creating an approval requirement

A work item requires approval when:

1. `PolicyEvaluator.evaluate()` returns `require_approval` for one or more evaluated actions on the work item.
2. The work item transitions to `needs_approval` (`packages/work-items/src/state-machine.ts`).

No separate "approval request" record with its own token is created. The requirement lives on the work item's policy evaluation until an approval is recorded.

## Granting approval

Approval happens through an authenticated call to `approve_work_item` (`gateApproval` / `gateApprovalInTransaction`, `packages/policy-gate/src/tools.ts`), reached **only** through the gateway's HTTP `/work-items/:id/approve` endpoint. It is not reachable through either MCP surface: `handleToolsCall` (`apps/gateway/src/mcp.ts`) rejects any `approve_work_item` call — local or remote — with `-32002` before dispatch, unconditionally, and the local stdio server doesn't expose work-item tools at all. It also does not happen through an out-of-band local CLI/UI token-issuance step — the caller must already be an authenticated gateway mutation actor calling the HTTP route directly.

The approval grant:

1. Requires the caller to supply the exact `actionHash` produced by policy evaluation (`requireApprovalActionHash` rejects a missing hash before parsing).
2. Rejects if the supplied hash doesn't match a currently-required action on the work item (`approval_action_mismatch`) or isn't required at all (`approval_not_required`).
3. Denies self-approval on high/critical risk actions (`isSelfApproval`, `packages/policy-gate/src/rules.ts`).
4. Stores the grant (`recordApproval`): work item ID, action hash, request hash, approver, expiry (default 10 minutes), status `granted`.
5. Emits an `approval.granted` audit event.

No raw token is generated, shown, or transmitted at any point. MCP remote callers are explicitly barred from calling `approve_work_item` (`remoteMcpToolNames` filters it out in `apps/gateway/src/mcp.ts`).

## Executing with approval

When a worker claims the next approved item (`claim_next_approved_work_item` / `gateWorkerClaimInTransaction`):

1. Claim the work item via lease compare-and-swap (`claimNextApprovedWorkItem`).
2. Re-run policy evaluation on the claimed item's current content (not the content at approval time).
3. For each action still requiring approval, look up the approval by `(workItemId, actionHash)`.
4. If found, consume it (`consumeApproval`): check request-hash match (if supplied), status is `granted`, not expired; atomically flip to `consumed`.
5. If policy now denies, an approval is missing, or consumption fails for any reason, the work item is transitioned to `blocked` instead of `running` — the claim itself still succeeds (the lease is held), but execution does not proceed.
6. On success, the work item transitions to `running` and execution begins.
7. Every step above is audited (`policy.decided`, `approval.consumed`, state-transition events).

## Failure behavior

| Failure | Result |
|---|---|
| No approval found, **or an approval exists but has expired** | Work item transitions to `blocked` on claim. `hasApproval`'s own query excludes expired rows (`expires_at > now`), so an expired grant looks identical to a missing one to the claim flow — `consumeApproval` is never reached for it, and `approval_expired` is not observable through this documented path. |
| Action hash on approve call doesn't match a required action | `approval_action_mismatch` |
| Approval not required for the supplied action hash | `approval_not_required` |
| Approval already consumed | `approval_already_consumed` (on re-approve attempt) / `approval_conflict` (on double-consume race) |
| Request hash mismatch at consumption | `approval_request_mismatch` |
| Current policy denies at claim time | Work item transitions to `blocked`, not executed |
| Self-approval on high/critical risk | Denied by policy before an approval record is ever created |

`approval_expired` is a real error thrown by the lower-level `store.consumeApproval` method (`packages/work-items/src/store.ts`), but the standard worker-claim flow above never reaches it — `hasApproval` filters expired rows out first. It's only observable by a caller that invokes `consumeApproval` directly, bypassing `hasApproval`.

## Non-negotiable rule

No actor may approve its own pending request when the action is classified high or critical risk. Enforced in `packages/policy-gate/src/rules.ts` (`isSelfApproval`), independent of and prior to any approval-recording logic.
