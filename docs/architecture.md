# Architecture

Agent Control Stack is a single TypeScript monorepo. Apps depend inward on packages; packages should not depend on apps.

ACS is also the sole Engine Harness authority. Model and protocol adapters are
untrusted capability adapters; they do not own policy, approval, lifecycle,
leases, result acceptance, or audit. See
[ADR 0009](adr/0009-engine-harness-authority-and-dependencies.md).

External agent runtimes and launch protocols—including OpenClaw, Hermes,
Codex, Claude, Gemini, OpenCode, Pi, ACP, and ACPX—remain below this authority
boundary. They may execute or transport an ACS-approved attempt, but they must
not introduce a parallel registry, policy engine, approval store, queue/lease
lifecycle, result authority, or canonical audit sink. Migration notes from the
retired OpenClaw Agent Orchestrator are captured in
[`openclaw-agent-orchestrator-migration.md`](openclaw-agent-orchestrator-migration.md).

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
- `apps/worker`: one-shot worker that claims the next approved item and records a dry-run result for the read-only vertical slice.

SQLite is the local durability layer. `work_items` holds the current control-plane state, while `audit_events` records append-only lifecycle events. Work-item mutations insert their matching audit event in the same SQLite transaction. Events use `name`, `timeUnixNano`, `attributes`, and `body` so they can be mapped to OpenTelemetry exporters later without changing the domain model.

The SQLite hash chain is the sole canonical audit and replay source
([ADR 0011](adr/0011-canonical-audit-sink.md)). Machine-controller JSONL and
process logs are telemetry only. The fail-closed Linux backend from
[ADR 0010](adr/0010-fail-closed-linux-sandbox.md) exists and has a separate
host-level test gate, but the production worker remains dry-run-only until
per-attempt workspaces and authoritative attempt wiring are implemented.

The worker's execution backend is explicit configuration (`ACS_EXECUTION_BACKEND`).
The default is `dry_run`. Setting `desktop_commander` routes an already-authorized
attempt to the local Desktop Commander MCP through
`packages/desktop-commander-adapter`: a real tool call happens only after an
authenticated actor, scope, work item, policy decision, required approval, exact
current action hash, valid unconsumed lease, ACS-side tool allowlist,
tool-specific argument validation, path/cwd containment, and command validation
all succeed. Failure of any check fails closed and Desktop Commander is never
invoked. The adapter never depends on any hosted Desktop Commander service. ACS
decides; Desktop Commander executes.

Work moves through enforced statuses: `draft`, `pending_policy`, `needs_approval`, `approved`, `running`, `succeeded`, `failed`, `blocked`, and `cancelled`. `blocked` remains a recoverable policy state; an accepted execution result is immutable and terminal. In this alpha, worker simulation only starts by transitioning an approved work item to `running`; no real command execution is claimed. The worker then applies a second, execution-side read-only scope check: filesystem inspection items may be simulated, while approved writes, shell commands, and other non-read-only actions are recorded as blocked rather than falsely reported as successful.

Policy decisions are recorded as `policy.decided` audit events. Required approvals are stored by `work_item_id` plus exact action hash, so approval is bound to the action that policy evaluated and records who approved it and why.

Workers claim approved rows through the work-item store with a status compare-and-swap and a short opaque lease. The governed worker claim creates one immutable execution attempt against the current admitted plan, starts it at fencing epoch one, and returns its attempt, plan, input, workspace, and lease bindings. Worker startup marks expired running leases as failed before claiming new work, then the local worker path re-checks policy and action-hash approvals before applying the read-only worker scope and entering dry-run sandbox simulation. A result submission for an attempt lease must carry those persisted bindings; the store rejects stale epochs, superseded plans, tampered inputs, and legacy envelopes that omit attempt authority. Privileged transitions that assert an actor identity reject an actor other than the current active lease owner, and the asserted identity is included in the audit event. One SQLite transaction appends the immutable attempt result and compatibility result projection, transitions the attempt and work item, closes both lease projections, and records audit evidence. Retry and clone are append-only lineage operations that create new work-item IDs, plans, attempts, and execution action hashes; policy and approval are evaluated again.
