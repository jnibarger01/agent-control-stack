# Protocol Specification: Worker Identity TTL and Rotation

## Purpose

Worker identity is lease-bound: a claimed work item records the `workerId` that
owns the active lease, and result submission must present that same worker.
Bearer tokens that prove the identity also need an independent lifecycle —
TTL, rotation, and revoke — before real execution.

This document covers the worker credential registry used by the gateway when
authenticating `POST /worker/claim` and `POST /work-items/:id/results`.

## Credential lifecycle

| Operation        | Effect                                                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Issue**        | Creates an active credential for a `workerId` with `issuedAt`, `expiresAt` (`now + ttlMs`), and a new generation. Any prior active credential for that worker is revoked. |
| **Rotate**       | Requires a still-active, non-expired current token. Revokes it and issues a replacement with a fresh token and TTL.                                                       |
| **Revoke**       | Marks the credential revoked (idempotent). Revoked tokens cannot authenticate.                                                                                            |
| **Authenticate** | Constant-time token match; rejects unknown, revoked, or wall-clock-expired credentials.                                                                                   |

Raw tokens are returned once on issue/rotate. The registry retains them only
for authentication lookups; prefer hashing at any durable persistence boundary.

## Result submission

`requireWorkerIdentity` resolves the bearer token before lease checks:

1. If a `WorkerIdentityRegistry` is configured and the token is known:
   - **active** → bind `workerId` from the identity
   - **expired** → `410` with `worker_identity_expired` (item stays claimed)
   - **revoked** → `401` with `worker_identity_revoked`
2. Otherwise static `ACS_GATEWAY_CREDENTIALS_JSON` / legacy gateway credentials
   apply. Those entries may set optional `expiresAt` and `status` (`active` \|
   `revoked`); expired worker credentials also return `410`.

A matching active lease is still required after identity authentication. Identity
without a lease is not authority; a lease without a live identity is not
authority either.

## Worker pull claims

The supported worker pull surface is `POST /worker/claim`. The request accepts
an optional positive integer `leaseMs` capped at one hour; it does not accept a
worker ID. Responses include `Cache-Control: no-store`. The gateway resolves
the bearer credential to a worker identity using the same resolver as result
submission. Unknown and revoked credentials are rejected before claim
processing. A policy or approval-binding rejection returns `409` with code
`worker_claim_blocked`.

Claim-time policy, approval, capability, state, and lease checks remain
authoritative. A persisted work-item assignment is a routing constraint created
before execution ownership: only its selected worker may claim the item. An
assignment is not a lease. The lease and execution attempt are created
atomically only after the authenticated worker passes claim-time checks.
Unassigned items cannot be claimed through the worker HTTP endpoint. Route
approved work through the semantic routing protocol first; see
[`semantic-agent-routing.md`](./semantic-agent-routing.md).

Remote MCP claim tooling is not present in this checkout; claims use the
gateway HTTP pull endpoint. Authenticated worker selection is enforceable, but
execution still uses the existing process-local pull executor. The gateway
does not route a worker claim to a per-worker backend.

## Acceptance

- An **expired** worker identity cannot complete a claimed item.
- A **rotated** identity can submit a result; the previous token cannot.

## Related

- [`worker-leases.md`](worker-leases.md) — lease TTL, renewal, and fencing
- [`worker-results.md`](worker-results.md) — result envelope and HTTP matrix
