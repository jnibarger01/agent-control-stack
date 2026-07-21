# Wave 2 result, retry, and clone design

Status: implementation baseline for the local `codex/wave2-result-retry` branch

## Boundary

Wave 2 models a complete worker lifecycle while keeping `packages/sandbox`
strictly dry-run. No shell, subprocess, filesystem, network, connector, or
production sandbox capability is added. The public result route is an
authenticated worker API; result submission is not an MCP tool.

## Result contract

`SubmitWorkResultInput` is the one canonical submission envelope. It contains
`workItemId`, `leaseId`, `workerId`, `actionHash`, `idempotencyKey`,
`outcome`, `startedAt`, `finishedAt`, `exitCode`, `summary`, `stdout`,
`stderr`, `structuredOutput`, `artifacts`, `error`, `resourceUsage`, and
`simulationMetadata`. The envelope is strict, bounded, timestamp-ordered,
and rejects secret-like keys, environment data, and filesystem-path metadata.
The simulation metadata must state `executionMode: dry_run` and
`simulated: true` for worker submissions.

The accepted outcomes are `succeeded`, `failed`, `cancelled`,
`worker_infrastructure_failure`, `blocked`, and `lease_expired`. Worker HTTP
submissions may use the first four; `blocked` and `lease_expired` are ACS
derived outcomes used when the policy/lease lifecycle closes a claim.
`worker_infrastructure_failure` transitions the item to `failed`.

`actionHash` is the execution binding hash for the claimed work item. It is a
stable hash of the work-item identity and canonical action envelope. It is
distinct from, and does not replace, the existing per-action policy
fingerprints used for approval. A new work-item ID therefore always produces a
new execution binding hash.

## Authentication and lease binding

The HTTP route requires configured gateway authentication, an `agent` role,
and a credential-bound `actorId` equal to the submitted `workerId`. The store
requires the `leaseId` to identify the active lease, the worker identity to
match, the action hash to match, and the lease to be unexpired. The existing
raw lease token remains an internal local-worker capability and is never part
of the result payload or audit record.

Claims create a durable lease row with an opaque lease ID, worker ID, token
hash, execution action hash, issue/expiry timestamps, and lifecycle status.
Legacy work-item lease columns remain synchronized for compatibility, but the
new acceptance path is lease-table authoritative.

## State and idempotency rules

One SQLite transaction performs all acceptance work: load the work item and
lease, resolve idempotency, validate identity/hash/expiry/state, insert the
immutable result, transition the work item, close the lease, and append the
result and terminal audit events. `BEGIN IMMEDIATE` serializes concurrent
submissions. A unique work-item result and a unique `(workerId,
idempotencyKey)` scope are enforced in SQLite.

An exact replay is identified by the same worker and idempotency key and an
equal canonical payload hash. It returns the original result without changing
state, even after lease closure. The same key with different content, or a
different key for an already accepted work item, is a conflict. Conflicts are
never persisted as results.

Execution results have immutable update/delete triggers. Terminal work items
cannot be reopened or edited. Audit records contain result identity, outcome,
action hash, idempotency key, payload hash, and dry-run metadata; raw output is
kept in the bounded result record and is not copied into the audit event.

## Database and migration

Migration 5 adds `leases`, immutable `execution_results`, and nullable
work-item lineage columns (`source_work_item_id`, `lineage_type`,
`retry_reason`, `retry_sequence`, and `root_work_item_id`). It adds foreign
keys, JSON checks, outcome/lineage checks, uniqueness constraints, indexes,
and append-only guards. Before applying it, the migration refuses legacy
running work items because their opaque lease token cannot be reconstructed as
a durable lease without silently changing authority. Existing terminal
`result_json` values are preserved; they are not fabricated into Wave 2 result
rows.

## Retry and clone

`retry_work_item` accepts only terminal source items and a bounded reason. It
copies the safe work request fields into a new item, links the new item to the
source with `lineageType: retry`, increments the lineage sequence, and sends
the new item through fresh policy evaluation. It never copies approvals,
leases, or results.

`clone_work_item` accepts a terminal source and optional safe request-field
overrides. It creates a new linked item with `lineageType: clone`, a fresh
execution binding hash, and normal policy/approval processing. The source is
never updated. Retry-of-retry lineage uses the source root and increments the
sequence again.

## Failure and recovery

Malformed, unauthorized, stale, mismatched, oversized, or conflicting
submissions fail before any durable change. A lease reaper creates one ACS
derived `lease_expired` result and fails the item atomically. An uncertain
client response is safe to replay with the same idempotency key. SQLite lock
or audit-chain failures roll back the whole transaction and fail closed.

## Explicit non-goals

This wave does not execute commands, invoke subprocesses, enable a sandbox,
accept raw environment variables or paths, expose worker claim/result tools
through MCP, restart tunnels/services, perform connector mutations, or claim
that a simulated result proves real execution.
