# Protocol Specification: Approval Lifecycle

## Purpose

This document defines how approval-gated actions move from request to execution.

## States

```text
pending -> approved -> consumed
pending -> denied
pending -> expired
approved -> expired
```

## Request hash

The request hash binds approval to exact request content.

Hash input:

```json
{
  "tool": "fs_write",
  "canonical_args": {},
  "normalized_cwd": "/home/user/project",
  "actor": "connector:chatgpt:user",
  "policy_version": "2026-07-05",
  "risk": "requires_approval",
  "nonce": "random-or-event-id"
}
```

Hash algorithm:

```text
sha256(canonical_json(input))
```

## Creating an approval request

A tool creates an approval request when:

1. Policy returns `require_approval`.
2. No approval token is provided.
3. The request is otherwise valid.

The approval request stores:

- `approval_request_id`
- `request_hash`
- `tool`
- `canonical_args`
- `normalized_cwd`
- `actor`
- `risk`
- `policy_reason`
- `status = pending`
- `created_at`
- `expires_at`

## Granting approval

Approval grant happens out-of-band through local CLI, local UI, or desktop prompt.

The approval grant:

1. Shows the exact request details to the human.
2. Requires explicit approve/deny.
3. On approve, stores a hash of a newly generated approval token.
4. Shows the raw token once.
5. Emits an audit event.

Raw approval tokens must not be returned by MCP tools.

## Executing with approval

When a tool receives an approval token:

1. Recompute request hash from the current request.
2. Look up an approval with matching request hash.
3. Hash the supplied token and compare with stored token hash.
4. Confirm status is `approved`.
5. Confirm approval has not expired.
6. Confirm approval has not been consumed.
7. Re-run policy on the current request.
8. Mark approval `consumed`.
9. Execute.
10. Emit result audit event.

## Failure behavior

| Failure | Result |
|---|---|
| No approval found | `approval_invalid` |
| Token mismatch | `approval_invalid` |
| Hash mismatch | `approval_invalid` |
| Expired approval | `approval_invalid` |
| Consumed approval | `approval_invalid` |
| Current policy denies | `policy_denied` |
| Audit intent event fails | `audit_failed`; do not execute |

## Non-negotiable rule

No MCP tool may approve its own pending request.

That would be like asking the fox to approve the henhouse renovation budget. Historically poor outcomes.
