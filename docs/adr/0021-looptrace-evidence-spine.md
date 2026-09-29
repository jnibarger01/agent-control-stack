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
  enqueue trace events into the outbox inside the same database transaction.
  Phase 2 also emits source-neutral work-item lifecycle evidence
  (`run.received`, `approval.requested`, `approval.decided`, and terminal
  run facts) from the authoritative store transition. Trace writes are isolated
  by savepoints: a failed trace append cannot deny or roll back the authority
  mutation, and a trace row can never exist without its corresponding mutation.
- Events are canonical sorted-key JSON with a per-database hash chain
  (`trace_chain_state.producer_key = 'acs'`; sequence 1 is 64 zero hex).
  Correlation is by work-item (`trace_missions.work_item_id` -> `trace_id`).
- Delivery is an fsync'd NDJSON spool drained by `acs trace-relay` and ingested
  by `looptrace ingest`. Durable trace storage redacts secrets before writing.
- Phase 3 adds ACS-bound `capability.issued` evidence for already-authorized
  DC/JC capability issuance. Phase 4 maps the existing lease-authorized Desktop
  Commander execution audit boundary into `executor.started`,
  `tool.call.started`, and `tool.call.finished`. Phase 5 maps the append-only
  verification requirement/decision boundary into `verification.started` and
  `verification.finished`. Phase 6 maps ACS's PR-only publication boundary
  into audit-backed `promotion.blocked` and durable-record-backed
  `promotion.completed`. These projections are savepoint-isolated and
  bounded; raw arguments, outputs, paths, capability material, verification
  requirement bodies, reviewer prose, PR URLs, and provider/git failure text
  are excluded.
- Trace state is never read back as authorization state. A missing, withheld,
  or failed trace does not grant, deny, approve, execute, verify, or promote
  anything; the canonical audit log and policy gate remain the authorities.

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
