# Trace spine phase 0 mapping

Read on 2026-09-27 from local checkouts. Custom DC's remote tool was not used. No code in DC, codex-swarm, or Hermes was changed.

## Git state

| Repo        | Path                                       | HEAD                                       | Branch                             | Porcelain                                                                                                |
| ----------- | ------------------------------------------ | ------------------------------------------ | ---------------------------------- | -------------------------------------------------------------------------------------------------------- |
| LoopTrace   | `/home/jacen/looptrace`                    | `d5768786bc70f135ff1beae7fde7bd7711d9f56c` | `feat/canonical-replacement`       | clean                                                                                                    |
| ACS         | `/home/jacen/projects/agent-control-stack` | `7d9464a3149d022d8baef74645679670a04d19d1` | `main`                             | 61 dirty paths in the main checkout. Phase 1 is in worktree `feat/trace-outbox-approvals` off that HEAD. |
| Custom DC   | `/home/jacen/projects/desktop-commander`   | `30e572fcd89d2df5d01dcb2d97ee12844ac0d826` | `fix/remote-device-managed-attach` | dirty (local settings, untracked probes, `.worktrees/`, `backups/`)                                      |
| codex-swarm | `/home/jacen/projects/codex-swarm`         | `b67233f036b658dce8f7f52ef9db0a13ac0ac514` | `feat/acs-controlled-mode`         | untracked `.worktrees/` only                                                                             |

Hermes has no single canonical git checkout in this inventory. Lane and dispatch code were not dumped. Phase 5 stays blocked on that.

## LoopTrace (verified)

There is no Zod package and no CLI in HEAD `d576878`. The schema module is `packages/schema/src/index.mjs`. It validates a closed Run/Span model:

- Run fields: `run_id`, `schema_version` (integer 1), `framework`, `status` (`ok|error|aborted`), `started_at`, `ended_at`, `root_span_id`, `env`, redaction and replay fields.
- Span fields: `span_id`, `run_id`, optional `parent_span_id`, `ordinal`, `type` (`agent_step|tool_call|human_input|policy_check|retrieval|communication|system`), `name`, `start`, `end`, `status`, scalar `attributes`, optional `error`, optional `output_ref` (`sha256:` + 64 hex), `ordering`, `replay_safe`.
- Timestamps are canonical UTC ISO-8601 with milliseconds (`toISOString()`).

The store is `packages/store-sqlite/src/index.mjs`. Tables at storage_version 1: `metadata`, `payloads`, `runs`, `spans`. Payloads also live in a content-addressed directory. Canonical bytes are sorted-key `JSON.stringify` after a secret and shape scan. That is the canonical form Phase 1 uses. It is not RFC 8785.

Run/Span attributes are scalars, so the trace-event envelope is a separate table (`trace_events`) rather than a span attribute. Existing runs and spans stay valid. Opening an older store adds the trace tables.

Phase 1 adds `trace-event/1` beside that model. Kinds in this slice are `acs.approval.granted` and `acs.approval.consumed`.

## ACS approvals and receipts (verified)

`approval_records` in `storage/migrations/001_audit_log.sql`, guarded by `004_state_constraints.sql`:

```sql
CREATE TABLE approval_records (
  work_item_id TEXT NOT NULL,
  action_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL DEFAULT '',
  approval_token_hash TEXT NOT NULL DEFAULT '',
  approved_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'granted',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL DEFAULT '9999-12-31T23:59:59.999Z',
  consumed_at TEXT,
  PRIMARY KEY (work_item_id, action_hash),
  FOREIGN KEY (work_item_id) REFERENCES work_items(id)
);
```

Status may only be `granted` or `consumed`. Writes go through `SqliteWorkItemStore.recordApproval` and `consumeApproval` in `packages/work-items/src/store.ts`, inside `write()`, which is one `BEGIN IMMEDIATE` transaction that also appends `audit_events`. The audit table already stores `previous_hash` and `event_hash`.

There is no deny or revoke transition on `approval_records`. `approval.denied` is named in `docs/protocol/audit-events.md` and is not emitted by the store. Work-item rejection is `rejectWorkItem` (status `rejected`) and does not insert `approval_records`. Execution-plan approvals are a different table (`execution_plan_approvals`: `granted|consumed|invalidated|expired`) and are outside this slice.

Receipts are not a SQL table. They are Zod values such as `acs.sandbox-authority-receipt.v1` in `packages/sandbox/src/contracts.ts`.

`trace_id` is not a work-item column. Phase 1 mints a 32-hex id into `trace_missions` on the first approval event for that work item, in the same transaction.

## codex-swarm audit (verified, unchanged)

`src/persistence/sqlite.ts` creates:

```sql
create table if not exists audit_events (
  event_id text primary key,
  correlation_id text not null,
  causation_id text,
  event_json text not null
);
```

`approval_grants` stores `grant_json` keyed by `correlation_id`. Event types include `approval.granted` and `approval.denied`. Correlation is `correlation_id` plus `causation_id`, not a W3C trace id. This table stays the source of truth until a later phase.

## Custom DC (partial)

Local HEAD is recorded above. A search of `desktop-commander/src` found no `trace_id` symbol. Exec-event shape for Phase 3 is still unverified.

## Phase 1 consequences of this inventory

- The outbox is attached to `recordApproval` and `consumeApproval` only. Deny and revoke are not approval-table writes.
- **Known gap:** `rejectWorkItem` is a human authority decision and does not write a trace event. A rejected mission reconstructs as if approval never happened. Phase 2 starts with work-item state transitions, including rejection, before capability events.
- Schema publication is JSON Schema plus the hand-rolled validator in LoopTrace. Zod was an assumption from before this inventory. ACS vendors `packages/work-items/contracts/trace-event.v1.schema.json` and pins its sha256. The current vendored file is copied from LoopTrace commit `49aca302a1c5f0d12813c73ca4149f2fc7afefd4` (`feat/jev3-lifecycle-evidence-20260928`), which extends the original `af3e425fe5e2a2bb3ccb8c2a3301555124a25465` publication with source-neutral lifecycle evidence kinds while preserving `trace-event/1`.
- Delivery is the NDJSON spool. `looptrace ingest --once`, `looptrace trace <work_item_id>`, and `looptrace gaps` are the commands. `acs trace relay` drains the outbox.
- Producer canonical JSON matches LoopTrace's sorted-key form. `prev_hash` for sequence 1 is 64 zero hex digits. Later events use the sha256 of the previous event's canonical bytes.
- `seq` and `prev_hash` are assigned inside the approval transaction. The chain key is the database (`trace_chain_state.producer_key = 'acs'`), not the process. `source.instance` still records which process emitted the event. `trace_missions.work_item_id` is the primary key; the insert is `INSERT OR IGNORE` followed by `SELECT` in that same transaction.
- Spool filenames use the event `ts` UTC date (`YYYY-MM-DD`). The relay fsyncs the new file, its parent directory, and the spool directory before it marks the outbox row shipped.

## JEV-3 lifecycle expansion (2026-09-28)

The canonical LoopTrace source was updated first on
`feat/jev3-lifecycle-evidence-20260928`, commit
`49aca302a1c5f0d12813c73ca4149f2fc7afefd4`. Its published
`trace-event.v1.schema.json` SHA-256 is
`5c0684ddbf26d3e62148d7d37d1523c9f1adcb9c580835d5f11663241ffb8434`.
The LoopTrace schema/store suite passes with the expanded event vocabulary.

The additional source-neutral lifecycle kinds are:

- `run.received`, `run.started`
- `classification.recorded`, `route.recorded`
- `approval.requested`, `approval.decided`
- `executor.started`
- `tool.call.started`, `tool.call.finished`
- `verification.started`, `verification.finished`
- `promotion.blocked`, `promotion.completed`
- `run.failed`, `run.completed`
- `replay.diverged`

The schema version remains `trace-event/1`; existing approval events still
validate unchanged. ACS vendors the exact canonical trace-event/1 schema bytes
published from that LoopTrace publication, pinned by SHA-256
`5c0684ddbf26d3e62148d7d37d1523c9f1adcb9c580835d5f11663241ffb8434`. ACS does
not vendor the LoopTrace commit itself.

Jace Commander local event names remain private to the adapter boundary.
Lifecycle events are normalized into the canonical vocabulary before any Jev
projection. Ancillary JC-only events with no reviewed canonical semantic
equivalent (`task_validated`, rollback checkpoint, file diff, and trace
sealed) are explicitly omitted rather than mislabeled. `agent_started`
projects the first execution boundary as both `run.started` and
`executor.started`; `run_replay_started` projects `run.started` with a
replay marker.

This normalized evidence is observational only. It does not replace ACS audit,
approval, capability, lifecycle, verification, or promotion state.
