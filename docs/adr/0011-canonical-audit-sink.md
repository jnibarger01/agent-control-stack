# ADR 0011: The SQLite hash chain is the canonical audit sink

## Status

Accepted

## Context

ACS currently has two audit-shaped outputs:

1. `packages/work-items` appends OpenTelemetry-shaped events to the
   hash-chained SQLite `audit_events` table, in the same transaction as domain
   state changes.
2. `packages/machine-controller` appends standalone JSONL tool records through
   `JsonlAuditLogger`.

The JSONL log is useful local telemetry, but it is neither hash-chained nor
transactionally bound to work-item state. Treating both as authoritative would
make replay and incident review ambiguous, and an unavailable JSONL path could
disagree with a committed SQLite transition.

## Decision

The hash-chained SQLite `audit_events` table managed through
`packages/work-items` is the sole canonical audit and replay record for Engine
Harness authority.

`packages/machine-controller` JSONL, Fastify logs, process stdout/stderr, and
future metrics are non-authoritative telemetry. They may aid diagnosis, but
they cannot prove identity, policy, approval, dispatch, execution, result
acceptance, verification, or completion.

LoopTrace consumes canonical ACS events or a deterministic projection. It is
not a live audit backend and cannot acknowledge an action on ACS's behalf.

### Write rules

- Redaction and schema validation happen before hashing and persistence.
- Every authoritative event is appended through the work-item store.
- Domain state and its corresponding event are committed in one SQLite
  transaction.
- Audit append failure rolls back the state change.
- A detected invalid audit chain disables authoritative writes until repaired
  out of band.
- Authoritative rows are append-only. Corrections are new events, never edits.

### Execution boundary

External process execution cannot be rolled back by a database transaction, so
the live harness uses a two-boundary protocol:

1. In one committed transaction, verify policy, approval, lease/fence,
   workspace, sandbox readiness, and append an `execution.started` intent event
   containing immutable correlation hashes.
2. Only after that commit may the sandbox launch.
3. In a later transaction, accept bounded sandbox observations, append the
   execution outcome, close or preserve the lease as defined by the state
   machine, and update attempt state.

If step 1 fails, the action does not start. If ACS cannot prove the outcome
after step 2, it records an unknown/inconclusive attempt when storage recovers;
it never infers success.

External side effects are not silently retried. A retry requires a new
authoritative attempt and an explicit idempotency decision.

### Projection and delivery

Local authorization does not require a second queue or audit service.
`audit_events.sequence` is the durable ordering cursor. Downstream consumers
track their own acknowledged cursor and may replay from SQLite.

If a future integration needs guaranteed publication coupled to another domain
transaction, an additive transactional outbox may be introduced in the same
SQLite database. Direct best-effort publication from inside a transaction is
not authoritative and must not block or replace the canonical append.

### Machine-controller disposition

The current machine-controller JSONL logger remains telemetry for its bounded
local MCP surface. Before any machine-controller action is used by the live
Engine Harness, that action must be adapted through the authoritative policy,
lease, sandbox, result, and SQLite audit path. The development-only direct-agent
tool remains disabled and cannot use JSONL as an authorization receipt.

## Consequences

- Replay has one ordered source and one integrity check.
- Telemetry loss does not rewrite history, but canonical audit loss blocks
  privileged action.
- The worker and adapters do not gain independent audit stores.
- Audit-chain verification becomes a readiness gate for live execution.
- Event schema evolution must remain backward readable or be migrated
  additively with explicit versioning.

## Required tests

- Tampering, deletion, and reordering break chain verification.
- State mutation rolls back when event insertion fails.
- Execution is not launched when the pre-execution event cannot commit.
- Result, attempt, lease, and terminal events commit atomically.
- A telemetry write failure cannot be mistaken for a canonical success receipt.
- A downstream replay resumes from a sequence cursor without changing ACS
  lifecycle state.

## Rejected alternatives

### Keep both logs authoritative

Rejected. They have different schemas, durability, ordering, and failure
semantics.

### Replace SQLite with JSONL

Rejected. JSONL cannot provide the existing transactional binding between
domain state and audit evidence.

### Make LoopTrace the live sink

Rejected. ACS must fail closed and recover locally even when downstream systems
are unavailable.

### Publish events directly inside domain transactions

Rejected. A network publication can succeed for a transaction that later rolls
back or fail after a transaction commits. A same-database outbox is the correct
future mechanism when guaranteed delivery is required.
