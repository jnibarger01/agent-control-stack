# Security Architecture Contracts

This document ties together the ADRs, threat model, and protocol specs for `agent-control-stack`.

## Contract hierarchy

1. [Architecture Decision Records](adr/README.md)
2. [Threat Model](threat-model.md)
3. [MCP Tool Protocol](protocol/mcp-tools.md)
4. [Approval Lifecycle](protocol/approval-lifecycle.md)
5. [Audit Events](protocol/audit-events.md)
6. [Worker Leases](protocol/worker-leases.md)

## Baseline security posture

`agent-control-stack` must treat ChatGPT, autonomous agents, and MCP callers as requesters, not trusted operators.

Privileged actions must pass through:

```text
request -> validation -> policy -> approval if required -> audit -> execution -> result audit
```

Skipping any step is a defect, not an optimization. Software loves calling missing brakes "simplicity."

## Implementation acceptance bar

A production-ready ChatGPT tunnel connector must prove:

- HTTPS connector transport is authenticated.
- Tool schemas are narrow and validated.
- Policy fails closed.
- Mutating actions require out-of-band approval.
- Approval tokens are request-bound, expiring, and one-time use.
- Commands run without shell interpolation by default.
- Paths are realpath-contained inside allowed roots.
- Sensitive files and output are redacted or denied.
- Audit events are hash-chained and verifiable.
- Worker result submission requires worker ID and lease token.
- Unauthenticated mutation fails in a live smoke test.

## Next bounded implementation task

Implement the protocol conformance test suite before adding new power.

Minimum first tests:

1. Unknown MCP tool denied.
2. Mutating tool without approval returns `approval_required`.
3. MCP cannot grant approval.
4. Argument swap invalidates approval.
5. Consumed approval cannot replay.
6. Result submission without worker ID and lease token fails.
7. Audit chain verification detects tampering.
8. Unauthenticated HTTP mutation fails.

Do that before widening filesystem or command authority. The machine you save may be your own, which is annoyingly practical.
