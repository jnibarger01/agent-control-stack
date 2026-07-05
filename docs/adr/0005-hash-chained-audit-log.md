# ADR 0005: Hash-chained audit/event log

## Status

Accepted

## Context

The system will mediate privileged local-machine actions. A plain append-only log is useful, but a tamper-evident event chain is better for later replay, incident review, and agent evaluation.

The log should not pretend to be a blockchain. We have enough software pretending to be money already.

## Decision

Audit events are written to an append-only, hash-chained local event log.

Each event includes:

- Event id
- Timestamp
- Actor
- Tool/action type
- Canonical request
- Policy decision
- Approval reference, if any
- Execution lease reference, if any
- Result summary
- Redacted stdout/stderr previews, if applicable
- Changed file/service/process metadata, if applicable
- Previous event hash
- Current event hash

The current event hash is computed over the canonical event body and previous event hash.

## Consequences

- Deleting or editing historical events becomes detectable.
- Replay harnesses can verify audit continuity.
- Mutating operations must not proceed if the audit layer cannot record required pre-execution events.
- Redaction must happen before persistence.

## Rejected alternatives

### Plain JSONL without chaining

Rejected for privileged operations. It is acceptable for debug logs, not the authoritative audit trail.

### Remote-only audit sink

Rejected for MVP. The project is local-first and must work without a cloud dependency.

### Store raw command output forever

Rejected. Logs must avoid preserving secrets and unnecessary data.

## Implementation requirements

- The audit writer must be append-only from the application perspective.
- Event serialization must be deterministic.
- Audit verification must detect missing, reordered, or edited events.
- Sensitive values must be redacted before hashing and persistence.
- Pre-execution intent and post-execution result should be separate event types.
