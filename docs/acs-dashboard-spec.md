# ACS Dashboard Specification

Status: implementation specification

## Purpose

The Agent Control Stack dashboard is the operator-facing projection of ACS control-plane state. It must explain what ACS knows, what authority exists, what is waiting for a human, what is currently leased for execution, and why a control-plane decision was made.

The previously proposed modern dashboard/frontend structure remains useful as a presentation foundation: responsive operational layout, overview cards, fleet/actor views, work queues, detail panels, searchable audit/events, environment-aware navigation, loading/error states, and a swappable API/data layer. It is **not** the source of truth for the ACS domain model.

The canonical model comes from existing ACS packages and persisted/audited state. The dashboard must not create a parallel generic `Agent` / `Task` / `Queue` control-plane ontology.

## Governing principles

1. **Project canonical state; do not invent it.** UI state must come from ACS schemas, persisted records, or explicitly labeled audit-derived projections.
2. **Authority is visible and explainable.** Approval, admission, lease ownership, fencing epoch, worker binding, and policy decision context are first-class operator concepts.
3. **Fail closed.** Missing or unverifiable authority is shown as unavailable/unknown, never inferred as approved, healthy, or executable.
4. **Control-plane policy stays server-side.** The UI requests actions through authenticated backend routes; it never decides that an action is authorized.
5. **Sensitive material stays out of the dashboard.** Never expose raw lease tokens, credentials, secrets, unrestricted environment data, or other security-sensitive execution inputs.
6. **Dry-run is explicit.** Until separately gated live execution exists, the UI must make `dry_run` / simulated execution unmistakable and must not imply production execution occurred.

## Frontend foundation to preserve

The dashboard should retain these presentation and interaction patterns from the frontend proposal:

- responsive desktop/mobile operational shell;
- overview cards for immediately actionable system state;
- actor/agent roster and detail view;
- work queue and work-item detail view;
- approvals view;
- execution/attempt detail and timeline;
- audit/event search and filtering;
- health/status pills with accessible text, not color alone;
- polling/SSE-ready data flow;
- explicit loading, empty, stale, unavailable, and error states;
- confirmation for sensitive mutations;
- an API client boundary that can be replaced without rewriting view components.

Framework choice is an implementation concern. The current `apps/control-ui` remains the active operator UI until a deliberate frontend migration is approved; this specification does not require replacing it with a second application.

## ACS-native entity model

### 1. Registry actor / agent

Source: canonical agent registry and heartbeat/audit evidence.

Operator fields:

- `id`
- display name
- kind / ACP role when available
- registry status
- capabilities
- last heartbeat
- last observed event
- last reported error when supported by evidence

Derived liveness (`online`, `stale`, `offline`) may be presented only from the canonical heartbeat windows. A registered agent without qualifying heartbeat evidence must not be shown as online.

### 2. Work item

Source: `WorkItem`.

Operator fields:

- work-item ID
- title and intent
- requester / requester subject
- status
- risk
- target
- requested actions
- lineage (`sourceWorkItemId`, `lineageType`, retry sequence/reason, root work item)
- created/updated timestamps
- bounded result/error summary where safe

Work items remain the top-level unit of governed requested work. Do not rename them to generic "tasks" in data contracts.

### 3. Execution plan

Source: `ExecutionPlanRecord`.

Operator fields:

- plan ID / plan number
- work-item ID
- plan hash and subject-input hash (abbreviated in ordinary UI, full value available for forensic inspection)
- objective and ordered steps
- constraints
- creator and timestamp
- execution mode
- network mode
- local-git-only / push / deployment constraints
- runtime and allowed-command constraints

### 4. Plan admission

Source: `ExecutionPlanAdmission`.

Operator fields:

- admission ID
- plan/work-item binding
- policy version
- policy-decision hash
- whether human approval is required
- admitting actor
- admission timestamp

A drafted plan without a persisted admission must be shown as **not admitted**. Admission must not be inferred from work-item status alone.

### 5. Execution attempt

Source: `ExecutionAttempt`.

Operator fields:

- attempt ID
- work-item ID
- plan ID / plan hash
- attempt number
- input hash
- protocol version
- status
- current fencing epoch
- claimed worker ID, when present
- created/started/updated timestamps

Canonical statuses are:

`pending | leased | running | cancellation_requested | interrupted | succeeded | failed | cancelled | unknown | quarantined`

Retries are represented as new attempts/lineage, not by mutating history into one generic task record.

### 6. Attempt lease

Source: `AttemptLease`.

Operator fields:

- lease ID
- attempt/work-item/admission binding
- approval ID when applicable
- worker ID
- fencing epoch
- protocol version
- policy version / policy-decision hash
- issued, last-renewed, expiry, maximum-expiry, and closed timestamps
- lease status

Canonical statuses are:

`active | consumed | expired | revoked`

The dashboard must **never** expose a raw lease token. Token hashes are not useful for routine operations and should remain hidden unless a dedicated forensic view has a justified need.

The UI should calculate presentation-only warnings such as "expiring soon" from the persisted expiry time, but must not turn that warning into authority or a lifecycle transition.

### 7. Workspace allocation

Source: `WorkspaceAllocation`.

Operator fields:

- allocation ID
- work-item ID
- branch / base ref
- status
- creation / teardown timestamps

The full host path is sensitive operational context. Show it only in an explicitly privileged forensic view if required; prefer a safe workspace label in normal dashboard views.

### 8. Approval binding and grant

Sources: `ApprovalBinding` and canonical approval-grant state.

Operator fields:

- approval request ID
- work-item/action binding
- immutable manifest/action fingerprints
- policy version / policy-decision fingerprint
- requester and approver actors
- grant status
- created/granted/expiry timestamps
- reason when present and safe

The dashboard must distinguish:

- approval required;
- approval requested;
- grant valid;
- consumed;
- expired;
- rejected/revoked where represented by canonical state/audit evidence.

The existence of an approval record is not equivalent to valid authority.

### 9. Audit event

Source: `StoredAuditEvent` / canonical append-only audit stream.

Operator fields:

- sequence / event ID
- event name
- timestamp
- safe correlation identifiers
- safe structured attributes/body
- chain/integrity information where exposed by the canonical audit API

Audit is the forensic timeline for decisions and lifecycle transitions. The UI may build projections from it, but every projection must be labeled as derived rather than persisted truth.

### 10. Engine execution projection

Source: persisted attempt/lease/workspace authority plus engine/sandbox audit evidence.

Engine/provider information is an **execution projection**, not a new authoritative task entity. Show only fields ACS can prove from persisted contracts or audit evidence, for example:

- adapter/engine ID when recorded;
- attempt/work-item/lease/worker binding;
- fencing token/epoch;
- authorization kind and fingerprint;
- policy version;
- workspace allocation ID;
- sandbox/egress/limit summary when safe;
- terminal engine outcome (`completed`, `timeout`, `cancelled`, `process_error`) when recorded.

Do not claim visibility into an engine's internal tool calls when the adapter is an opaque process boundary.

## Dashboard information architecture

### Overview

The first screen should answer:

- Are registered actors available according to heartbeat evidence?
- Which work items need operator attention?
- Which plans are drafted but not admitted?
- Which approvals are waiting or expiring?
- Which execution attempts are pending, leased, running, failed, interrupted, or quarantined?
- Which active leases are nearing expiry?
- Is execution currently dry-run/simulated?
- Are there recent policy, lease, sandbox, integrity, or execution failures?

Recommended cards:

- Actors online / stale / offline
- Work items running
- Operator attention (`needs_approval`, `blocked`, `quarantined`)
- Active attempts
- Active leases / expiring leases
- Failed or interrupted attempts
- Pending approvals
- Execution mode

Do not use CPU, memory, cost, latency, or throughput cards unless ACS actually persists trustworthy measurements for them.

### Actors

Replace a generic "agent fleet" model with registry-backed actors/agents and audit-derived liveness. Show capability matching and current governed work only when the binding is known.

### Work

Primary row = `WorkItem`.

Expand/detail with:

1. current execution plan;
2. admission decision;
3. approval bindings/grants;
4. attempts in chronological order;
5. current/closed leases;
6. workspace allocation;
7. bounded results/artifacts;
8. correlated audit timeline.

This makes the operator path explainable from request through authority to execution and result.

### Attempts & leases

Provide a dedicated operational view for concurrent execution safety:

- attempt status and attempt number;
- owner worker;
- fencing epoch;
- lease state and expiry;
- plan/admission/approval bindings;
- stale/expired/revoked lease indicators;
- retry lineage.

A stale worker must never appear as the current owner after a newer fencing epoch is authoritative.

### Governance

Combine operator-relevant policy state without weakening boundaries:

- plan admission;
- approvals;
- policy version / decision fingerprint;
- quarantined work/attempts;
- validation/integrity failures when canonically persisted or audited;
- publication/release state only after ACS has a canonical contract for it.

Do not add synthetic `validation`, `publication`, or `recovery` statuses merely to satisfy a visual design. Until ACS persists those concepts, surface the underlying audit evidence and mark the projection as derived.

### Audit / forensics

Support filtering by:

- work-item ID;
- attempt ID;
- lease ID;
- worker/actor ID;
- approval ID;
- event name/category;
- time range;
- failure class where canonically recorded.

Default views must remain redacted and bounded.

## API/view-model boundary

The frontend API should return ACS-native resources or explicit read-model projections. Suggested read endpoints/read models:

- `GET /api/dashboard/summary`
- `GET /api/agents`
- `GET /api/work-items`
- `GET /api/work-items/:id`
- `GET /api/work-items/:id/plans`
- `GET /api/work-items/:id/attempts`
- `GET /api/attempts/:id`
- `GET /api/attempts/:id/lease`
- `GET /api/audit-events?...`

Existing routes may be retained where already implemented. New endpoints are proposals until implemented and tested; this document does not declare them live.

Read models should prefer composition over duplication. For example, a work-item detail response may contain canonical work-item data plus current plan/admission, attempts, safe lease summaries, safe workspace summary, approval summaries, and correlated audit events.

## Mutation rules

Every dashboard mutation must use the same server-side authority checks as non-UI callers.

At minimum:

- authenticated principal;
- authorization/policy check;
- exact resource/action binding;
- approval verification where required;
- current-state verification;
- lease/fencing verification for run-scoped mutation where applicable;
- idempotency/replay handling where the protocol requires it;
- structured audit event;
- explicit operator confirmation for destructive or authority-changing actions.

No bulk approval action is part of this specification.

## Presentation-state rules

The UI may derive presentation states but must label them correctly:

| UI label | Source | Authority? |
| --- | --- | --- |
| Online / stale / offline | canonical heartbeat windows | No; liveness projection |
| Needs operator attention | work-item/attempt canonical statuses | No; convenience grouping |
| Lease expiring soon | `AttemptLease.expiresAt` vs current time | No; warning only |
| Plan not admitted | plan exists and admission absent | No; explanatory projection |
| Dry run | execution-plan constraint and/or canonical simulation metadata | Yes for describing recorded mode, not execution authority |
| Engine outcome | canonical/audited engine result | No additional authority |

Unknown/missing evidence must render as `unknown` or `unavailable`, never as a green/healthy default.

## Security and privacy requirements

Never render or log in client-visible payloads:

- raw lease tokens;
- API keys, OAuth tokens, cookies, credentials, SSH material;
- unrestricted environment variables;
- engine credential material;
- secrets embedded in command output;
- unrestricted prompts/stdout/stderr without the existing redaction and output-bounding guarantees;
- untrusted host paths unless explicitly required for privileged forensic use.

Hashes and identifiers should be abbreviated in dense tables but remain copyable in an authorized detail view when they are safe to disclose.

## Migration from the generic dashboard model

Do **not** implement these generic types as the dashboard's source of truth:

- `Agent` with CPU/memory/concurrency as assumed universal properties;
- generic `Task` detached from `WorkItem`, `ExecutionPlan`, `ExecutionAttempt`, and `AttemptLease`;
- generic `QueueHealth` without a canonical ACS queue contract;
- generic `DeploymentState` without a canonical ACS deployment contract;
- generic tool-usage telemetry presented as authoritative when the engine boundary cannot observe internal tool calls.

Replace them with the ACS-native composition described above.

The visual frontend foundation can still expose routes/cards/tables that look familiar, but their data contracts must map to ACS entities and explicit projections.

## Implementation order

### P0 — canonical read model

- introduce ACS-native dashboard view-model types based on exported package contracts;
- expose execution attempts and lease summaries to `apps/control-ui`;
- retain registry-backed actor projection and current work-item/plan/admission views;
- keep all new fields additive until consumers migrate.

### P1 — operator visibility

- add attempt/lease ownership and fencing state to work-item detail;
- add dry-run execution-mode banner;
- add retry lineage and quarantined/interrupted attempt visibility;
- add policy/admission/approval fingerprints and expiry state;
- extend audit filtering/correlation.

### P2 — engine/sandbox evidence

- surface engine adapter and terminal outcome only where canonically persisted/audited;
- surface safe sandbox/egress/limit summaries;
- add validation/recovery/publication projections only after canonical contracts exist.

### P3 — frontend migration, if still desired

If ACS later adopts the proposed Next.js/React/Tailwind/shadcn frontend, migrate the presentation layer onto these ACS-native read models. Do not reintroduce the generic control-plane ontology during that migration.

## Acceptance criteria

The dashboard specification is ready for implementation when:

- every primary UI entity maps to an existing ACS contract or is explicitly labeled as a derived projection;
- work-item detail can trace request -> plan -> admission -> approval -> attempt -> lease -> workspace -> result/audit evidence;
- current worker authority can be explained using lease ownership and fencing epoch;
- retry attempts remain distinct and historically auditable;
- dry-run/simulation state is obvious;
- missing evidence fails closed in presentation;
- sensitive lease/credential material is excluded;
- mutations remain server-authorized and audited;
- no generic `Agent`/`Task`/`QueueHealth` model is treated as canonical ACS state.

This document is the dashboard domain specification. The frontend proposal is a UI foundation subordinate to these ACS contracts.
