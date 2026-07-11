# Protocol Specification: Worker Leases

## Purpose

Worker leases prevent untrusted or stale workers from submitting results for work they did not claim.

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
  "lease_token": "lease_once_...",
  "lease_expires_at": "2026-07-05T18:00:00Z"
}
```

## Lease storage

The server stores:

- `work_item_id`
- `worker_id`
- `lease_token_hash`
- `lease_expires_at`
- `claimed_at`
- `status`

Raw lease tokens are never stored.

## Submitting results

Result request:

```json
{
  "work_item_id": "wrk_...",
  "worker_id": "worker_local_1",
  "lease_token": "lease_once_...",
  "status": "succeeded",
  "summary": "Completed.",
  "artifacts": []
}
```

Validation:

1. Work item exists.
2. Work item is claimed or running.
3. Submitted `worker_id` matches claim.
4. Hash of submitted `lease_token` matches stored hash.
5. Lease is not expired.
6. Result status is valid.
7. Result payload passes schema validation.

## Failure behavior

| Failure | Result |
|---|---|
| Missing worker ID | Reject. |
| Missing lease token | Reject. |
| Wrong worker ID | Reject and audit. |
| Wrong token | Reject and audit. |
| Expired lease | Reject and mark expired if applicable. |
| Duplicate result | Reject. |

## Renewal

Lease renewal is deferred until long-running real execution exists.

When added, renewal must require:

- Same `worker_id`
- Same valid lease token
- Maximum total lease duration
- Audit event

## Security rule

Worker identity without a lease token is not authority. Lease token without matching worker identity is not authority. Both are required, because apparently computers also need two-factor common sense.
