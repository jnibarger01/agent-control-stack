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

## Managed execution admission recovery

The JC/DC gateway reserves scheduler capacity before claiming work. The claim,
attempt lease, durable `admission_permits` binding and binding audit event commit
in one database transaction before capability issuance. An insertion failure
rolls back the claim and releases the scheduler reservation. A later capability
issuance failure retains the reservation while its lease is active.

Gateway shutdown preserves durable reservations. Startup restores capacity only
when the reservation matches the current attempt, lease, worker, fencing epoch,
plan/input/action hashes, runtime lane and canonical tool capacity class. WAIT
operations restore WAIT capacity, rather than ordinary execution capacity.
Invalid active bindings remain available for investigation. Missing or rejected
bindings cause new admission to return `503 admission_recovery_required`; readiness
also reports unhealthy. This is a reconciliation boundary, not an automatic retry
or permission bypass.

Accepted terminal results release capacity after the lease closes. Rejected
results do not release an active lease's reservation. Expired leases are reaped
before admitting new execution; startup does not sweep unrelated worker leases.
This capacity accounting does not prove that a remote side effect stopped at
lease expiration. Runtime capability expiry and fencing remain separate controls.

## Result submission contract

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

Workers renew an active attempt lease through `renewAttemptLease` before wall-clock expiry.

Renewal requires:

- Same `worker_id`
- Same fencing epoch
- Same valid lease token
- Active, non-expired lease
- New expiry strictly after the current expiry and at or before `max_expires_at`

Successful renewal updates `expires_at` / `last_renewed_at` on the attempt lease (and the dual legacy lease projection), updates `work_items.lease_expires_at`, and emits `attempt_lease.renewed`. Exhausted max duration returns `lease_renewal_exhausted`.

Expiry reaping (`failExpiredLeases`) uses the authoritative attempt-lease clock when present, marks the attempt lease `expired`, emits `attempt_lease.expired`, and records a derived `lease_expired` result so a stale worker cannot complete afterward.

Re-leasing an interrupted attempt revokes any prior active lease first and emits `attempt_lease.stolen` so concurrent workers cannot double-complete under a stale fencing epoch.

## Security rule

Worker identity without an active matching lease is not authority. A lease without the authenticated worker binding and action hash is not authority. Both are required, and results remain dry-run records until a separately gated sandbox wave exists.

Worker bearer credentials additionally support TTL, rotation, and revoke — see [`worker-identity.md`](worker-identity.md).
