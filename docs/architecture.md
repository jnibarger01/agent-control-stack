# Architecture

Agent Control Stack is a single TypeScript monorepo. Apps depend inward on packages; packages should not depend on apps.

ACS is also the sole Engine Harness authority. Model and protocol adapters are
untrusted capability adapters; they do not own policy, approval, lifecycle,
leases, result acceptance, or audit. See
[ADR 0009](adr/0009-engine-harness-authority-and-dependencies.md).

## Layers

- `packages/shared`: IDs, redaction, errors, hash helpers, migrations, and OpenTelemetry-shaped event schemas.
- `packages/work-items`: durable work-item state, leases, immutable execution results, retry/clone lineage, SQLite audit persistence, lifecycle events, and event replay projection.
- `packages/policy-gate`: fail-closed static policy decisions for requested actions.
- `packages/temporal-memory`: source-backed memory events and projections.
- `packages/sandbox`: explicit dry-run simulation plus a fail-closed
  Bubblewrap/systemd Linux containment backend with strict command profiles,
  sanitized environments, network denial, and resource limits.
- `packages/eval-harness`: deterministic replay and policy checks.

## Apps

- `apps/gateway`: Fastify HTTP/SSE gateway and control UI host.
- `apps/control-ui`: server-rendered dashboard HTML.
- `apps/worker`: one-shot worker that claims the next approved item and records a dry-run result.

SQLite is the local durability layer. `work_items` holds the current control-plane state, while `audit_events` records append-only lifecycle events. Work-item mutations insert their matching audit event in the same SQLite transaction. Events use `name`, `timeUnixNano`, `attributes`, and `body` so they can be mapped to OpenTelemetry exporters later without changing the domain model.

The SQLite hash chain is the sole canonical audit and replay source
([ADR 0011](adr/0011-canonical-audit-sink.md)). Machine-controller JSONL and
process logs are telemetry only. The fail-closed Linux backend from
[ADR 0010](adr/0010-fail-closed-linux-sandbox.md) exists and has a separate
host-level test gate, but the production worker remains dry-run-only until
per-attempt workspaces and authoritative attempt wiring are implemented.

Work moves through enforced statuses: `draft`, `pending_policy`, `needs_approval`, `approved`, `running`, `succeeded`, `failed`, `blocked`, and `cancelled`. `blocked` remains a recoverable policy state; an accepted execution result is immutable and terminal. In this alpha, worker simulation only starts by transitioning an approved work item to `running`; no real command execution is claimed.

Policy decisions are recorded as `policy.decided` audit events. Required approvals are stored by `work_item_id` plus exact action hash, so approval is bound to the action that policy evaluated and records who approved it and why.

Workers claim approved rows through the work-item store with a status compare-and-swap and a short opaque lease. Worker startup marks expired running leases as failed before claiming new work, then the local worker path re-checks policy and action-hash approvals before dry-run sandbox simulation. A result submission validates authentication at the gateway and lease ownership, worker identity, action hash, expiry, state, payload bounds, and idempotency inside one SQLite transaction. The transaction appends the immutable result, transitions the work item, closes the lease, and records audit evidence. Retry and clone are append-only lineage operations that create new work-item IDs and fresh execution action hashes; policy and approval are evaluated again.
