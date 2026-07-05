# Architecture

Agent Control Stack is a single TypeScript monorepo. Apps depend inward on packages; packages should not depend on apps.

## Layers

- `packages/shared`: IDs, redaction, errors, and OpenTelemetry-shaped event schemas.
- `packages/work-items`: work-item model, lifecycle events, and event replay projection.
- `packages/policy-gate`: approval decisions for pending work.
- `packages/audit-log`: append-only SQLite event storage.
- `packages/temporal-memory`: source-backed memory events and projections.
- `packages/sandbox`: dry-run execution boundary for approved work.
- `packages/eval-harness`: deterministic replay and policy checks.

## Apps

- `apps/gateway`: Fastify HTTP/SSE gateway and control UI host.
- `apps/control-ui`: server-rendered dashboard HTML.
- `apps/worker`: one-shot worker that executes the next approved item.

SQLite is the local durability layer. `work_items` holds the current control-plane state, while `audit_events` records append-only lifecycle events. Events use `name`, `timeUnixNano`, `attributes`, and `body` so they can be mapped to OpenTelemetry exporters later without changing the domain model.

Work moves through enforced statuses: `draft`, `pending_policy`, `needs_approval`, `approved`, `running`, `succeeded`, `failed`, `blocked`, and `cancelled`. Execution only starts by transitioning an approved work item to `running`.
