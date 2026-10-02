# Implementation Plan — Trace Spine (LoopTrace as the single audit sink)

## Objective

Every authority-bearing or side-effecting action across ACS, Custom DC, codex-swarm, and Hermes lands in LoopTrace as a typed event under one schema. Events are correlated by a single `trace_id` that is minted when a mission starts, so that:

- `looptrace reconstruct <trace_id>` shows the full causal chain, from the work item through approval, capability, execution, promotion, and dispatch, in a single command.
- Gaps, tampering, and missing audit are detectable. No system may silently fail to write its audit.
- Cross-system replay fixtures can be built from real sessions. This is the precondition for the model-upgrade regression harness (idea #2).

LoopTrace is an **observer, never an authority**. ACS stays the sole control plane. That matches the existing Custom DC boundary: DC emits evidence, and ACS decides.

## Current State

What is known:

- **LoopTrace** has deterministic replay, CAS + SQLite storage, Zod contracts, approval gates, and cross-language replay/store/CLI validation.
- **ACS** has a SQLite registry (agents, actors, capabilities, heartbeats), a work-item lifecycle, approvals, and fail-closed Layer 2 policy. It also has receipts and a session ledger.
- **Custom DC** has "structured execution events for ACS/LoopTrace" on its planned expansion list. It is being consolidated into the ACS monorepo, with LoopTrace explicitly deferred from that consolidation.
- **codex-swarm** has its own SQLite audit, promotion gates, and secret scanning.
- **Hermes** has lane state machines, dispatch contracts, and cron jobs, including the auto-firing `openclaw-wedge-healer`.

**Not verified (Custom DC was unreachable while this plan was written):**

- LoopTrace's current span/event schema, and whether it can carry non-MCP events.
- The shape of ACS's existing approval and receipt tables.
- The codex-swarm audit row schema.
- Current HEAD SHAs and dirty state for all four repos.

Phase 0 exists to close these gaps before any code is written.

## Target Architecture

```
 ACS (SQLite)        codex-swarm (SQLite)     Custom DC            Hermes
 state change +      state change +           exec events          lane/dispatch
 outbox row, 1 txn   outbox row, 1 txn        (in-process)         events
      │                    │                       │                   │
      ▼                    ▼                       ▼                   ▼
   outbox relay        outbox relay          spool writer        spool writer
      └──────────────┬─────┴───────────────────────┴───────────────────┘
                     ▼
        ~/.local/state/looptrace/spool/<source>/<date>.ndjson   (append-only, fsync)
                     ▼
        LoopTrace ingester: validate → redact-check → dedup → chain-verify
                     ├── accept ─► SQLite trace store (+ CAS for large payloads)
                     └── reject ─► quarantine/ (with reason), counted and surfaced
                     ▼
        CLI: trace | reconstruct | gaps | verify-chain | export-fixture
```

### Key decisions

**1. Transactional outbox for producers that already have SQLite (ACS, codex-swarm).**
The event row is written in the *same transaction* as the state change it describes. As a result, an approval cannot commit without its audit event, and an audit event cannot exist without its approval. This makes the audit fail-closed without putting LoopTrace in the authority path.

- A relay drains the outbox to the spool and marks rows `shipped` only after fsync.
- Delivery is at-least-once, and the ingester dedups.

**2. Append-only NDJSON spool, no network listener.**
Producers never write LoopTrace's database, and there is no new port.

- The spool is human-readable, greppable, and replayable.
- If the ingester is down, events queue on disk and nothing is lost.
- A loopback HTTP ingest was rejected for v1 because it adds a listener, an auth surface, and a failure mode.

**3. Producers without a database (DC, Hermes) write the spool directly.**
The fail semantics depend on the event class:

| Event class | Examples | If the spool write fails |
|---|---|---|
| `authority` | capability issued/consumed, approval, promotion, destructive exec | **Action is denied** (fail-closed) |
| `evidence` | exec started/finished, exit code, output hash | Action proceeds; a drop counter increments and is surfaced by `gaps` |
| `telemetry` | heartbeats, timings | Best-effort |

**4. Correlation uses one `trace_id` per mission, minted by ACS at work-item creation.**
It is propagated as follows:

- **ACS → DC:** embedded in the capability claim. DC already validates the capability in-process, so it reads `trace_id` from the validated claim rather than from caller input.
- **ACS → codex-swarm and Hermes:** passed in the dispatch envelope.
- **Child processes:** `TRACEPARENT` env var (W3C format), which is parse-validated.

An unvalidated `trace_id` from caller input is never trusted for `authority` events.

**5. Ordering uses per-producer `seq` plus a hash chain, not wall clock.**
Each producer maintains a monotonic `seq` and `prev_hash`. The ingester verifies continuity per `(source, producer_instance)`. A gap or chain break becomes a first-class finding, not a log line.

**6. Schema ownership: LoopTrace owns it, and producers vendor it pinned by hash.**
LoopTrace is deferred from the monorepo, so there is no shared package yet.

- LoopTrace publishes `trace-event.v1.schema.json` along with the Zod source.
- Each producer vendors that file and runs a contract test that asserts its sha256 matches the pinned value.
- This keeps cross-repo package plumbing out of the problem until the monorepo absorbs LoopTrace.

### Event envelope v1

```ts
{
  schema_version: "trace-event/1",
  event_id: string,          // ULID; dedup key
  trace_id: string,          // 32 hex (W3C)
  span_id: string,           // 16 hex
  parent_span_id?: string,
  source: {
    system: "acs" | "dc" | "codex-swarm" | "hermes",
    component: string,       // e.g. "approvals", "exec", "promote-gate"
    instance: string,        // producer instance id (stable per process lifetime)
    release_sha: string      // from ~/releases/<component>/<sha>/ — ties event to deployed commit
  },
  class: "authority" | "evidence" | "telemetry",
  kind: string,              // closed enum per system, e.g. "acs.approval.granted"
  actor: { id: string, type: "human" | "agent" | "system" },
  subject: {                 // optional refs; all validated formats
    work_item_id?: string,
    capability_id?: string,
    commit_sha?: string,     // full 40-hex only, never a branch name
    worktree?: string
  },
  seq: number,               // per (source.system, source.instance), monotonic
  prev_hash: string,         // sha256 of previous event's canonical bytes
  ts: string,                // RFC3339, informational only
  payload: object,           // redacted at producer
  payload_hash: string       // sha256 of canonical payload; large payloads -> CAS ref
}
```

Canonicalization should use RFC 8785 (JCS) or LoopTrace's existing canonical form, whichever Phase 0 finds already in use. One canonical form, everywhere.

## Smallest Safe Slice (Phase 1)

**ACS approval events → outbox → spool → LoopTrace → `looptrace trace <work_item_id>`.**

Scope:

1. **In LoopTrace:** `trace-event.v1` Zod schema and exported JSON Schema.
2. **In LoopTrace:** a spool ingester (`looptrace ingest --once` first; watch mode later). It runs validate → secret re-scan → dedup → chain verify, then either stores the event or quarantines it.
3. **In ACS:** an `trace_outbox` table and a migration. Approval grant, deny, and revoke write the outbox row in the same transaction.
4. **In ACS:** a relay command that drains the outbox to the spool with fsync, then marks rows shipped.
5. **In LoopTrace:** a `trace <work_item_id>` CLI and a `gaps` CLI.

Explicitly out of scope for Phase 1: DC, codex-swarm, Hermes, watch-mode daemons, UI, and replay.

## Phases After the Slice

| Phase | Adds | Exit check |
|---|---|---|
| 0 | Inventory: LoopTrace schema/store/CLI, ACS approval + receipt tables, codex-swarm audit rows, HEAD SHAs. Write the mapping doc. | Mapping doc reviewed; no assumptions left unverified |
| 1 | The slice above | Tests below green; a manual approval shows up in `looptrace trace` |
| 2 | ACS capability issue/consume events; `trace_id` embedded in capability claims | A capability's full lifecycle is visible under one `trace_id` |
| 3 | Custom DC exec events (`authority` for destructive ops, `evidence` for the rest), with `trace_id` read from the validated capability | `reconstruct` shows approval → capability → exec with exit code and output hash |
| 4 | codex-swarm promote/gate events via outbox; a read-only importer for historical audit rows, marked `imported: true` | Promotion is linked to an immutable commit SHA under the mission's trace |
| 5 | Hermes lane transitions and dispatch; cron-originated actions get their own `trace_id` with `actor.type = "system"` | `wedge-healer` resets are visible and attributable |
| 6 | `reconstruct <trace_id>`, `verify-chain`, `export-fixture` | Feeds idea #2 (regression harness) |

## Files Likely Involved (to confirm in Phase 0)

- **LoopTrace:** the schema module (new `trace-event.v1`), the store (new `trace_events` table plus a `quarantine` table), the CLI (`ingest`, `trace`, `gaps`), and fixtures.
- **ACS:** the approvals module, a migration for `trace_outbox`, a new `trace-relay` command, and a vendored `trace-event.v1.schema.json` plus its contract test.
- Nothing in DC, codex-swarm, or Hermes changes in Phase 1.

## Test Plan

**Schema**
- A valid event round-trips.
- Each required field, when missing, is rejected.
- A branch name in `commit_sha` is rejected.
- A malformed `trace_id` is rejected.
- An unknown `kind` is rejected.

**Outbox atomicity**
- A forced failure after the approval write rolls back both the approval and the outbox row.
- An approval cannot exist without an outbox row (a property test over the grant, deny, and revoke paths).

**Relay**
- If the process crashes after the spool write but before the `shipped` mark, the event is re-sent and the ingester dedups it to exactly one stored event.
- If the spool dir is unwritable, the relay exits non-zero and rows stay unshipped. It must not silently drop anything.

**Ingester**
- A duplicate `event_id` is stored exactly once.
- A `seq` gap is reported by `gaps`.
- A `prev_hash` mismatch triggers quarantine with a reason plus a finding.
- A secret-shaped value in the payload triggers quarantine, and the secret value never appears in logs or in the quarantine reason.
- Invalid JSON in the middle of a file quarantines that line only and processes the rest.

**Schema pin**
- A vendored schema whose hash mismatches LoopTrace's published hash fails ACS CI.

**End-to-end**
- Grant an approval, run the relay, run `ingest --once`, run `trace <id>`. The output shows the event, and the exit code is 0.

## Risks

- **Audit in the authority path.** The outbox makes approvals depend on the audit write. This is intended ("no audit, no action"), but it means an outbox bug blocks approvals.
  - *Mitigation:* the outbox is one insert in an existing transaction, with no I/O beyond SQLite.
- **Dual audit during migration.** codex-swarm keeps its own audit table.
  - *Mitigation:* LoopTrace is a derived view, and codex-swarm's table remains the source of truth until Phase 4 is proven.
  - Do not delete either audit table.
- **Redaction gaps.** Payloads can leak argv, env, or file contents.
  - *Mitigation:* redact at the producer, re-scan at ingest, and quarantine on any hit.
  - DC `exec` events carry an output *hash*, not the output itself, by default.
- **Schema drift across repos.** Mitigated by the hash-pinned vendored schema and a contract test in every producer.
- **Spool growth.** Add rotation and a retention policy in Phase 1 (spool files are deletable only after ingest confirms). There is no automatic deletion before that.
- **Clock skew.** Ordering never depends on `ts`; it relies on `seq` and parent spans.
- **Scope creep toward a "distributed tracing platform."** No OTel collector, no network ingest, and no UI until Phase 6 proves the CLI is insufficient.

## Done Criteria (Phase 1)

- [ ] Phase 0 mapping doc exists, with HEAD SHAs recorded for LoopTrace and ACS.
- [ ] `trace-event.v1` schema is published in LoopTrace; the ACS vendored copy is hash-pinned and the contract test passes.
- [ ] ACS approval grant, deny, and revoke write an outbox row atomically, with rollback tests passing.
- [ ] The relay and `ingest --once` are idempotent under crash-replay tests.
- [ ] Chain-break, gap, and secret-hit cases quarantine with reasons and no secret echo.
- [ ] `looptrace trace <work_item_id>` returns the approval chain for a real local approval, with exit 0.
- [ ] Full test suites in both repos pass, with commands and results recorded.
- [ ] No commits made without explicit instruction; work done in isolated worktrees.

## Next Smallest Task

Run Phase 0 read-only once Custom DC is reachable:

1. Dump LoopTrace's current event/span schema and store tables.
2. Dump ACS's approval and receipt table DDL.
3. Record `git rev-parse HEAD` and `git status --porcelain` for both repos.
4. Write the mapping doc.

No code changes in this step.
