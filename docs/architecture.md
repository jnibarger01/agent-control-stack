# Architecture

Agent Control Stack is a single TypeScript monorepo. Apps depend inward on packages; packages should not depend on apps.

## Layers

- `packages/shared`: IDs, redaction, errors, hash helpers, migrations, and OpenTelemetry-shaped event schemas.
- `packages/work-items`: durable work-item state, SQLite audit persistence, lifecycle events, and event replay projection.
- `packages/policy-gate`: fail-closed static policy decisions for requested actions.
- `packages/temporal-memory`: source-backed memory events and projections.
- `packages/sandbox`: dry-run default plus an opt-in Bubblewrap Codex read-only execution profile.
- `packages/eval-harness`: deterministic replay and policy checks.

## Apps

- `apps/gateway`: Fastify HTTP/SSE gateway and control UI host.
- `apps/control-ui`: server-rendered dashboard HTML.
- `apps/worker`: one-shot worker that claims the next approved item and records structured dry-run or contained-agent evidence.

SQLite is the local durability layer. `work_items` holds the current control-plane state, while `audit_events` records append-only lifecycle events. Work-item mutations insert their matching audit event in the same SQLite transaction. Events use `name`, `timeUnixNano`, `attributes`, and `body` so they can be mapped to OpenTelemetry exporters later without changing the domain model.

Work moves through enforced statuses: `draft`, `pending_policy`, `needs_approval`, `approved`, `running`, `succeeded`, `failed`, `blocked`, and `cancelled`. Worker execution is dry-run unless the explicit contained Codex profile is enabled; unsupported providers and missing containment fail closed with structured evidence.

Policy decisions are recorded as `policy.decided` audit events. Required approvals are stored by `work_item_id` plus exact action hash, so approval is bound to the action that policy evaluated and records who approved it and why.

Workers claim approved rows through the work-item store with a status compare-and-swap and a short lease. Worker startup marks expired running leases as failed before claiming new work, then the local worker path re-checks policy and action-hash approvals before dry-run simulation or the contained profile. Terminal worker results are redacted and schema-validated at the store boundary, persisted on the work item, and mirrored into the terminal audit event with execution mode and evidence metadata.
