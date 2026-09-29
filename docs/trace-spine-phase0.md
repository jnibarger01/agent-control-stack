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

Local HEAD is recorded above. A search of `desktop-commander/src` found no `trace_id` symbol. Phase 3 capability evidence therefore does not depend on DC private trace events: it correlates from ACS's durable issuance/audit path and uses the verified DC capability-fingerprint formula. DC-local execution-event correlation remains a later trace-spine concern.

## Phase 1 consequences of this inventory

- Phase 1 attached the outbox only to `recordApproval` and `consumeApproval`. Phase 2 additionally attaches source-neutral lifecycle emission to work-item creation and selected authoritative state transitions. Deny/revoke remain absent from `approval_records`; human work-item rejection is represented by `approval.decided` rather than a fabricated approval row.
- **Phase 2 gap (closed on the JEV-4 continuation branch):** `rejectWorkItem` previously had no canonical trace event, so a rejected mission reconstructed as if approval never happened. Work-item lifecycle trace emission now covers creation, approval request/decision, rejection, cancellation, and linked retry/clone creation before capability events.
- Schema publication is JSON Schema plus the hand-rolled validator in LoopTrace. Zod was an assumption from before this inventory. ACS vendors `packages/work-items/contracts/trace-event.v1.schema.json` and pins its sha256. JEV-3 established the lifecycle vocabulary at LoopTrace commit `49aca302a1c5f0d12813c73ca4149f2fc7afefd4`; Phase 3 extends those source bytes first on `feat/capability-trace-evidence-20260928` with ACS-bound `capability.issued`. The current vendored schema SHA-256 is `8b694731594466f5a83d6132df84a07421a472a1d618e34bf74259c9444051a0`, still under `trace-event/1`.
- Delivery is the NDJSON spool. `looptrace ingest --once`, `looptrace trace <work_item_id>`, and `looptrace gaps` are the commands. `acs trace relay` drains the outbox.
- Producer canonical JSON matches LoopTrace's sorted-key form. `prev_hash` for sequence 1 is 64 zero hex digits. Later events use the sha256 of the previous event's canonical bytes.
- `seq` and `prev_hash` are assigned inside the same authoritative SQLite transaction that emits the corresponding lifecycle/approval fact. The chain key is the database (`trace_chain_state.producer_key = 'acs'`), not the process. `source.instance` still records which process emitted the event. `trace_missions.work_item_id` is the primary key; the insert is `INSERT OR IGNORE` followed by `SELECT` in that same transaction.
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
validate unchanged. That JEV-3 publication had SHA-256
`5c0684ddbf26d3e62148d7d37d1523c9f1adcb9c580835d5f11663241ffb8434`.
Phase 3 supersedes the ACS vendored pin with
`8b694731594466f5a83d6132df84a07421a472a1d618e34bf74259c9444051a0`
after adding only `capability.issued`; ACS still vendors schema bytes, not the
LoopTrace repository or commit itself.

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

## Phase 2 work-item lifecycle evidence (2026-09-28)

Phase 2 extends the ACS producer with source-neutral lifecycle facts while
preserving the Phase 1 specialized approval events. The trace remains
observational and is never read back as authorization state.

Implemented mappings:

- work-item creation -> `run.received`
- transition to `needs_approval` -> `approval.requested`
- durable approval grant -> `acs.approval.granted` plus `approval.decided`
  with `decision=approved`
- human work-item rejection -> `approval.decided` with `decision=rejected`
  even though no `approval_records` row exists
- work-item cancellation/direct failure -> `run.failed`
- direct terminal success -> `run.completed`
- retry/clone work-item creation -> a fresh `run.received` trace correlated to
  the new work-item id; source authority is not copied into the child trace

Lifecycle emission occurs inside the same outer SQLite transaction as the
canonical work-item/audit mutation but inside a savepoint. A trace failure
rolls back only the lifecycle trace write, increments the bounded trace-failure
signal, and cannot deny or undo the authoritative mutation. Existing prior
trace rows remain intact when a later lifecycle append fails.

Lifecycle payloads are deliberately small and pass through the shared ACS
redactor at the generic emitter boundary. Mission intent, raw arguments,
credentials, capabilities, approval tokens, and unrestricted model output are
not included. Actor ids are normalized with the existing deterministic trace
identity rule.

Phase 2 does not add capability authority, change policy/approval behavior, or
make LoopTrace/Jev an authority.

## Phase 3 capability issuance evidence (2026-09-28)

Phase 3 adds one canonical kind, `capability.issued`, source-bound to ACS.
It is observational trace evidence for an already-authorized durable capability
issuance; it never participates in policy, approval, lease validation, signing,
or execution authorization.

For both `acs.dc.v1` and `acs.jc.v1`:

- ACS derives a stable non-secret capability fingerprint from the exact prepared
  capability payload before signing.
- Desktop Commander fingerprints use the verifier-compatible identity
  `acs.dc.v1:<first-32-hex-of-sha256(canonical-payload)>`.
- Jace Commander uses the analogous
  `acs.jc.v1:<first-32-hex-of-sha256(strict-canonical-payload)>`.
- The existing lease-authorized execution audit event persists the fingerprint
  as `capability.id`; the canonical trace hook runs from
  `recordExecutionEvent()` after the same attempt/lease/fencing checks.
- The trace subject contains both `work_item_id` and `capability_id`.
- The bounded payload contains only contract/tool/runtime and correlation
  identifiers/hashes plus expiry and whether an approval was bound. It excludes
  normalized arguments, nonce, signature, private key material, raw capability
  envelopes, and approval secrets.
- Trace insertion is savepoint-isolated. A trace failure does not undo the
  durable issuance row or execution audit event and does not prevent ACS from
  signing/returning the already-authorized capability.

The deterministic Jev trace projection treats `capability.issued` as
execution-progress evidence and exposes only a small allowlisted subset such as
contract, tool, runtime, lease epoch, and approval-bound state. Capability
material itself is filtered by the existing secret/capability-key rules.

## Phase 4 execution-boundary evidence (2026-09-28)

Phase 4 projects ACS's existing lease-authorized Desktop Commander execution
audit events into canonical execution evidence. No new executor authority,
command path, capability, lease, verification rule, or promotion rule is added.

Mappings:

- `execution.started` -> `executor.started`
- `desktop_commander.tool_called` -> `tool.call.started`
- `desktop_commander.tool_succeeded` / `desktop_commander.tool_failed`
  -> `tool.call.finished`

The hook lives in `recordExecutionEvent()`, after the existing authoritative
attempt/lease/fencing checks and canonical audit append. Each projected event
uses the existing work-item trace, identifies the worker as the actor, and
carries only bounded execution correlation: executor/tool, attempt and lease
ids, fencing epoch, action/invocation hashes, argument digest/count for tool
start, and result hash/duration/status/error code for tool finish.

Raw normalized arguments, command text, file contents, stdout/stderr, result
content, capability material, and filesystem paths are not copied into the
canonical trace. Missing or invalid correlation hashes cause the trace fact to
be skipped and reported rather than fabricating incomplete evidence.

As with prior phases, the trace append is savepoint-isolated. Trace failure or
malformed observational correlation cannot roll back the authoritative
execution audit event or alter whether Desktop Commander executes.

Jace Commander private JSONL is not ingested by this slice. Although its local
events already have a reviewed normalizer, ACS currently has no durable
post-execution JC authority callback equivalent to `recordExecutionEvent()`.
Wiring private JC logs directly into ACS would create an unreviewed trust path;
that correlation remains a later slice.

## Phase 5 verification evidence (2026-09-29)

Phase 5 projects the existing ACS-owned verification governance boundary into
canonical `verification.started` and `verification.finished` events. It does
not run a verifier, create review findings, relax verification requirements, or
change the result-acceptance gate.

Mappings:

- first durable `verification.requirement_recorded` for an attempt ->
  `verification.started`
- every durable `verification.decision` -> `verification.finished`

The start event is emitted only when a verification requirement is first
inserted; idempotent re-recording of the same requirement does not duplicate the
trace fact. Decision history is intentionally preserved: a disputed decision
followed by a later accepted decision produces two ordered
`verification.finished` facts rather than rewriting history.

The canonical payload is bounded to attempt correlation, verification policy,
reviewer count/mode, decision outcome, acceptance state, evidence-manifest hash,
and review-finding count. Requirement bodies, review-finding prose, verifier
prompts/output, workspace paths, and evidence contents are not copied into the
trace.

Both hooks execute after the corresponding append-only verification row and
canonical audit event are written, inside the same outer ACS transaction with a
trace savepoint. A trace failure rolls back only the observational write; it
cannot erase a requirement or decision, open/close the verification gate, or
change work-item lifecycle state.

For governed Desktop Commander execution, the observed ordering is therefore:

- automatic/zero-reviewer path:
  `... -> tool.call.finished -> verification.started -> verification.finished -> run.completed`
- reviewer-required path before a decision:
  `... -> tool.call.finished -> verification.started`, with no
  `verification.finished` or `run.completed`

Jev receives only the deterministic bounded projection of these verification
facts. It remains advisory and cannot satisfy or dispute verification.

## Phase 6 promotion evidence (2026-09-29)

Phase 6 maps ACS's existing publication boundary—the PR-only mechanical
promotion path in `packages/publication`—into `promotion.blocked` and
`promotion.completed`. It does not add merge/deploy authority, relax any
publication prerequisite, or make trace state part of the promotion decision.

Completion:

- the existing append-only `publication.recorded` write remains the durable
  success record;
- only after that record and its canonical audit event exist does ACS append
  `promotion.completed`;
- the trace payload is bounded to attempt id, publication id, commit SHA, and
  transport=`pull_request`; PR URLs and repository/provider details are not
  copied into the canonical trace.

Blocked promotion:

- `packages/publication` continues to make the fail-closed decision;
- each refusal is classified into a bounded stage/reason code and external
  state, then handed to `recordPublicationBlocked()`;
- `recordPublicationBlocked()` appends canonical audit event
  `publication.blocked` and then observational `promotion.blocked`;
- no dedicated mutable promotion-state table is introduced, and trace is never
  read back as authority.

The bounded stages cover validation, entry/pre/post-push lease fencing,
execution-plan push authorization, branch/workspace binding, staging/commit,
push, PR creation, and durable-record persistence. `external_state` reports
only `none`, `branch_pushed`, `pull_request_created`, or `unknown`, so
operators can distinguish a refusal before external mutation from a partially
externalized publication without storing raw git/GitHub errors.

Raw stderr, provider error text, workspace paths, PR URLs, credentials, and
repository contents are excluded from audit/trace payloads. The original
publication exception is still returned to the caller; failure to write the
blocked audit/trace cannot mask that refusal. Conversely, failure to append
`promotion.completed` cannot undo an already durable publication record.

In this architecture, `promotion.completed` means ACS has durably recorded its
validated PR publication. It does not mean the PR was merged or deployed.
