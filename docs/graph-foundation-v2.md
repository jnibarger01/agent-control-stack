# Graph Foundation v2

- **Status:** Accepted — first incremental slice.
- **Scope:** `packages/graph`, a derived, query-only representation of relationships that already exist in `packages/work-items`. Nothing in this document or package authorizes execution, approval, policy, or lease decisions.
- **Supersedes:** an earlier, unmerged `packages/graph` (PR #12, branch `feature/acs-graph-v0.1`) that built a ~7,700-line independent execution-authority engine with its own run/attempt/lease/budget/verdict tables in a private SQLite database, disconnected from `packages/work-items` and `packages/policy-gate` entirely. That design is not reused here — see "What was rejected from PR #12" below.

## Why this exists

`packages/work-items` already records rich relationships — a work item has execution plans, plans have attempts, attempts have leases, work items have workspace allocations and retry/clone lineage — but there is no queryable graph view over them; each relationship has to be walked one store call at a time. This package makes those relationships explicit and queryable, without becoming a second place any of them are decided.

## Non-authority, by construction

Per the authority boundaries in [`docs/authority-map.md`](authority-map.md) §1: graph data must never become an independent source of authority over policy, approvals, work-item state, worker leases, execution authorization, or immutable results. This package enforces that structurally, not just by convention:

- **No independent state tables.** There is no `graph_runs`, `graph_attempts`, or `graph_scheduler_leases` table. `graph_nodes`/`graph_edges` store only a redacted-to-structural projection of a record that already exists in `packages/work-items`, plus a hash of that record for staleness detection.
- **No write path but projection.** `GraphStore.upsertNode`/`upsertEdge` are only ever called by `projector.ts`'s pure functions, which take an already-fetched authoritative record as input. There is no code path where the graph decides a work item's status, grants a lease, or authorizes an attempt.
- **No authorization-shaped method.** `GraphStore`'s interface has no `approve`/`authorize`/`grant`/`claim` method. This is asserted directly in tests (`store.test.ts`, `acceptance.test.ts`): a structural check over `Object.getOwnPropertyNames` fails the build if such a method is ever added without deliberate review.
- **Reconstructable from authoritative data.** Every node's `sourceRecordId` and `sourceRecordHash` point at a specific `packages/work-items` record; deleting the entire graph database and re-running the projector reproduces the same nodes and edges (see `acceptance.test.ts`'s "graph rebuild from authoritative records").
- **Physically isolated storage.** `SqliteGraphStore` opens its own SQLite file, entirely separate from the control-plane database `packages/work-items` uses. Deleting or corrupting it cannot touch a work item, approval, lease, or audit event — and nothing in `packages/work-items` or `packages/policy-gate` imports this package, so a graph-store outage cannot propagate into a control-plane failure either.

## What was rejected from PR #12

An inventory of the old branch (`feature/acs-graph-v0.1`, 57 commits behind `main` at the time of writing) found:

- Its own invented node/run state machine (`PENDING/READY/RUNNING/...`), unrelated to and never mapped onto `packages/work-items`' actual `WorkItemStatus` enum.
- A full lease-fencing protocol (`graph_scheduler_leases`, `acquireSchedulerLease`/`assertSchedulerLeaseToken`) gating every mutation — a second, independent lease system with no relationship to `packages/work-items/src/liveness.ts`.
- An execution-readiness gate (`assertNodeReadyForExecution`) that decided whether work could run purely from the graph's own tables — the exact "graph becomes an independent authority" failure mode this rebuild is designed to avoid.
- A hardcoded approval-blocking rule (`"approval required; graph v0.1 has no approval execution path"`) that neither called `packages/policy-gate` nor read real approval records — it faked "blocked forever" rather than deferring to or modeling real approval authority.
- Zero imports from `@agent-control-stack/work-items` or `@agent-control-stack/policy-gate` anywhere in the package — it was built as a wholly separate orchestration engine, not a layer over this repository's actual control plane.

None of that code was ported. A few _patterns_ (not code) were worth carrying forward and are reflected here: an explicit non-authority statement up front (this document), deterministic/idempotent identifiers so replay can't duplicate facts, and hash-based staleness detection.

## Design

### Schema (`schema.ts`)

- `graphNodeTypeSchema`: `work_item | execution_plan | attempt | attempt_lease | workspace_allocation` — one node type per authoritative record type this slice covers.
- `graphEdgeTypeSchema`: `has_execution_plan | has_attempt | has_lease | uses_workspace | retried_as | cloned_as` — one edge type per relationship that already exists between two authoritative records.
- Every node/edge carries an explicit `schemaVersion` (`GRAPH_SCHEMA_VERSION`); `SqliteGraphStore` refuses to open a database written by a different schema version (fail closed on drift) rather than guessing a migration.
- Node and edge ids are deterministic functions of the source record's own id (`graphNodeId`, `graphEdgeId`), so projecting the same authoritative state twice always produces the same ids — the mechanism that makes replay and duplicate-projection handling trivial.

### Validation (`validator.ts`)

Strict Zod schemas reject unknown node/edge types and undeclared fields outright. `assertWellFormedEdgeEndpoints` additionally rejects self-loops and endpoints that aren't graph-generated ids, before the store's own referential-integrity check (an edge may not reference a node that doesn't exist — enforced by `SqliteGraphStore.upsertEdge` checking both endpoints, backed by `PRAGMA foreign_keys = ON`) ever runs.

### Persistence (`store.ts`)

`GraphStore` is a narrow interface: upsert, get, list-by-type, list-edges-from/to, count, clear, close. `SqliteGraphStore` is the only implementation, backed by its own SQLite file with two tables (`graph_nodes`, `graph_edges`) and a `graph_meta` schema-version guard. Upserts use `ON CONFLICT DO UPDATE`, so re-projecting the same node or edge id updates it in place rather than duplicating a row.

### Projection (`projector.ts`)

Pure functions that turn an already-fetched `packages/work-items` record into a `GraphNode`/`GraphEdge` — no store access inside the `project*` functions themselves. Two entry points read from a `WorkItemStore` directly:

- `projectWorkItemSubgraph(store, workItemId)` walks a work item, its full retry/clone ancestor chain, its execution plans, and its active workspace allocation.
- `projectCommandAuthoritySubgraph(store, input)` projects an attempt, its lease, its plan, and its work item from a single `store.getCommandAuthority(...)` lookup — the one joined, authority-verified read `packages/work-items` already exposes for this exact identity set, rather than inventing a new one. (There is currently no `listAttempts(workItemId)` read method on `WorkItemStore`, so attempts/leases are projected per-attempt via this path rather than enumerated from a work item; that is a known limitation, not an oversight — see "Deferred to a later slice" below.)

`isProjectionStale(node, currentRecord)` re-hashes a freshly re-fetched authoritative record and compares it to the node's stored `sourceRecordHash`, so a caller can detect drift without trusting the graph's own timestamp.

## Deferred to a later slice

Per the task's preferred sequence, this PR covers schema, validation, persistence, and projection from authoritative records only. Deliberately not in scope here:

- **Scheduler/work-item integration** (calling the projector automatically from `apps/scheduler` or the gateway's write paths) — the task's own guidance is to add this "only where justified," and doing it well requires deciding _when_ projection runs (on every write? a background reconciler?) which deserves its own focused review rather than being bundled into the foundation PR.
- **Attempt enumeration by work item** — would require a new `WorkItemStore` read method (`listAttempts(workItemId)`), which is a `packages/work-items` change, not a `packages/graph` change, and is out of scope for a graph-only PR.
- **Audit-event-driven incremental projection** (projecting from `store.readEvents()` as they're appended, rather than re-reading current state) — the current design re-reads current state on demand, which is simpler and sufficient for a query layer; event-driven projection is a reasonable future optimization, not a correctness requirement this slice needs.

## Cross-references

- [`docs/authority-map.md`](authority-map.md) §1 ("Graph data must not become an independent source of authority" is this document's normative source).
- [`packages/work-items/src/attempt.ts`](../packages/work-items/src/attempt.ts) — `commandAuthoritySchema`, the joined read this package's `projectCommandAuthoritySubgraph` is built on.
