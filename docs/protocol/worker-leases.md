# Protocol Specification: Worker Leases

## Purpose

Worker leases prevent untrusted or stale workers from submitting results for work they did not claim. The lease is one part of authority: result submission also requires an authenticated worker principal, a matching worker identity, the execution action hash, and a bounded canonical payload.

## Work lifecycle

```text
created -> pending_policy -> approved -> claimed -> running -> succeeded
                                             \-> failed
                                             \-> expired
                                             \-> cancelled
```

## Claiming work

Only approved work can be claimed.

Claim request:

```json
{
  "worker_id": "worker_local_1",
  "capabilities": ["command", "filesystem"]
}
```

Claim response:

```json
{
  "work_item_id": "wrk_...",
  "attempt_id": "attempt_...",
  "lease_id": "lease_...",
  "lease_token": "lease_once_...",
  "worker_id": "worker_local_1",
  "action_hash": "<64 lowercase hex characters>",
  "plan_hash": "<64 lowercase hex characters>",
  "input_hash": "<64 lowercase hex characters>",
  "fencing_epoch": 1,
  "workspace_hash": "<64 lowercase hex characters>",
  "lease_expires_at": "2026-07-05T18:00:00Z"
}
```

## Lease storage

The server stores:

- `work_item_id`
- `worker_id`
- `lease_token_hash`
- `lease_expires_at`
- `issued_at`
- `expires_at`
- `status` (`active`, `consumed`, `expired`, or `revoked`)
- `action_hash`

Raw lease tokens are never stored.

## Result submission

The canonical result contract and HTTP response matrix are documented in [`worker-results.md`](worker-results.md). The worker sends the opaque `lease_id`, not the persisted token hash, to `POST /work-items/:id/results` along with its authenticated worker identity and `action_hash`. The gateway never accepts an unauthenticated result route.

The store validates the work item, attempt, current plan, active lease, worker binding, action and input hashes, fencing epoch, expiry, result state, timestamp order, output bounds, dry-run metadata, and attempt-derived idempotency key in one transaction. It inserts one immutable attempt result, transitions the attempt and work item, closes the lease, and appends audit events atomically. An attempt-backed lease cannot use the legacy result envelope.

## Failure behavior

| Failure                                      | Result                                               |
| -------------------------------------------- | ---------------------------------------------------- |
| Missing or invalid authentication            | `401`; no result lookup is exposed.                  |
| Non-worker or wrong worker identity          | `403`; no lease ownership is disclosed.              |
| Missing, unknown, revoked, or consumed lease | `403`/`409` according to the gateway error contract. |
| Expired lease                                | `410`; no worker result is accepted.                 |
| Action-hash mismatch                         | `403`; no result is accepted.                        |
| Exact replay                                 | `200` with the original immutable result.            |
| Conflicting replay or second key             | `409`; no state changes.                             |

## Renewal

Lease renewal is deferred until long-running real execution exists.

When added, renewal must require:

- Same `worker_id`
- Same valid lease token
- Maximum total lease duration
- Audit event

## Security rule

Worker identity without an active matching lease is not authority. A lease without the authenticated worker binding and action hash is not authority. Both are required, and results remain dry-run records until a separately gated sandbox wave exists.
