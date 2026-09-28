# ADR 0021: LoopTrace is an observational evidence/ replay spine, not an authority

## Status

Accepted.

## Context

LoopTrace is the observability/evidence/replay spine for the control stack. ACS
already has a canonical, hash-chained audit log ([ADR 0005](0005-hash-chained-audit-log.md),
[ADR 0011](0011-canonical-audit-sink.md)). LoopTrace must add ordered, typed,
correlatable trace evidence spanning the execution lifecycle without becoming a
second authorization or audit authority.

## Decision

LoopTrace trace events are **observational evidence**, distinct from the
canonical authorization/audit semantics owned by ACS.

- ACS vendors the `trace-event/1` JSON Schema
  (`packages/work-items/contracts/trace-event.v1.schema.json`) and pins its
  SHA-256 against the LoopTrace source schema.
- Approval transitions (`acs.approval.granted`, `acs.approval.consumed`)
  enqueue a trace event into an outbox **inside the same database transaction**
  that mutates approval state, so trace and authority state can never disagree.
- Events are canonical sorted-key JSON with a per-database hash chain
  (`trace_chain_state.producer_key = 'acs'`; sequence 1 is 64 zero hex).
  Correlation is by work-item (`trace_missions.work_item_id` -> `trace_id`).
- Delivery is an fsync'd NDJSON spool drained by `acs trace-relay` and ingested
  by `looptrace ingest`. Durable trace storage redacts secrets before writing.
- Trace state is never read back as authorization state. A missing, withheld,
  or failed trace does not grant, deny, approve, or promote anything; the
  canonical audit log and policy gate remain the authorities.

## Consequences

- `packages/work-items/src/trace-outbox.ts` and migration
  `032_trace_outbox.sql` (`trace_missions`, `trace_chain_state`, `trace_outbox`).
- The end-to-end replay/dedup test drives the real LoopTrace CLI when a checkout
  is available (`LOOPTRACE_CLI`), and skips otherwise, following the
  repository's external-CLI interoperability convention.
- Replay and divergence checks operate on trace evidence only; they cannot
  change a work item's terminal state.

## Rejected alternatives

- **Make the trace chain the canonical audit sink.** Rejected: ADR 0011 already
  names the SQLite hash chain as the sole canonical audit sink; a second one
  would be a split-brain audit authority.
- **Wire trace emission on the request path synchronously.** Rejected: trace
  availability must never gate or block otherwise-valid ACS work.
