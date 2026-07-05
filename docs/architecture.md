# Architecture

Agent Control Stack is a single TypeScript monorepo. Apps depend inward on packages; packages should not depend on apps.

## Layers

- `packages/shared`: IDs, redaction, errors, and OpenTelemetry-shaped event schemas.
- `packages/work-items`: work-item model, lifecycle events, and event replay projection.
- `packages/policy-gate`: fail-closed static policy decisions for requested actions.
- `packages/audit-log`: append-only SQLite event storage.
- `packages/temporal-memory`: source-backed memory events and projections.
- `packages/sandbox`: dry-run execution boundary for approved work.
- `packages/eval-harness`: deterministic replay and policy checks.

## Apps

- `apps/gateway`: Fastify HTTP/SSE gateway and control UI host.
- `apps/control-ui`: server-rendered dashboard HTML.
- `apps/worker`: one-shot worker that executes the next approved item.

SQLite is the local durability layer. `work_items` holds the current control-plane state, while `audit_events` records append-only lifecycle events. Work-item mutations insert their matching audit event in the same SQLite transaction. Events use `name`, `timeUnixNano`, `attributes`, and `body` so they can be mapped to OpenTelemetry exporters later without changing the domain model.

Work moves through enforced statuses: `draft`, `pending_policy`, `needs_approval`, `approved`, `running`, `succeeded`, `failed`, `blocked`, and `cancelled`. Execution only starts by transitioning an approved work item to `running`.

Policy decisions are recorded as audit events. Required approvals are stored by `work_item_id` plus exact action hash, so approval is bound to the action that policy evaluated.

Workers claim approved rows with a status compare-and-swap and a short lease. Worker startup marks expired running leases as failed before claiming new work, then re-checks policy and action-hash approvals before sandbox execution.
