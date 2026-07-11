# ADR 0001: Local control plane is the security boundary

## Status

Accepted

## Context

`agent-control-stack` is intended to let ChatGPT or other agents request local-machine actions. Those actions may include filesystem reads, command execution, service inspection, work-item execution, and eventually controlled mutation.

The dangerous design would let the model, connector, or tunnel become the trust boundary. That design fails as soon as the prompt context is hostile, stale, confused, or injected. So, naturally, it is the design every demo gravitates toward first.

## Decision

The local control plane is the security boundary.

All privileged actions must pass through local server-side controls:

1. Authentication of the connector/client.
2. Tool schema validation.
3. Policy classification.
4. Human approval when required.
5. Lease or approval-token validation when applicable.
6. Sandboxed execution.
7. Audit/event logging.
8. Result submission validation.

The ChatGPT client, MCP client, tunnel provider, and model output are not trusted to enforce security.

## Consequences

- Client-side confirmations are useful UX, not security.
- Every tool implementation must call the policy layer before execution.
- The policy layer must be difficult to bypass accidentally.
- Any future direct shell, filesystem, browser, desktop, or process-control tool must route through this boundary.

## Rejected alternatives

### Trust ChatGPT confirmation dialogs

Rejected. A compromised prompt or tool description can manipulate the model into requesting unsafe work.

### Trust MCP tool descriptions

Rejected. Tool descriptions are hints, not enforcement.

### Put security in the tunnel layer

Rejected. The tunnel can authenticate traffic, but it does not understand local intent, cwd containment, command risk, file sensitivity, or approval semantics.

## Implementation notes

- No privileged action should be implemented as a direct helper outside the policy/execution path.
- Internal APIs should make bypasses awkward: `execute(action)` should require a policy decision, approval state, and audit context.
- Tests should include a bypass regression suite for each privileged tool family.
