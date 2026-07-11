# Architecture Decision Records

This directory records the security and architecture decisions for `agent-control-stack`, a local control plane intended to sit between ChatGPT/MCP clients, autonomous agents, and privileged local-machine actions.

ADR status values:

- `Proposed`: not yet accepted.
- `Accepted`: baseline decision for implementation.
- `Superseded`: replaced by a later ADR.
- `Rejected`: considered and intentionally not used.

## Current ADRs

| ADR | Title | Status |
|---|---|---|
| [0001](0001-local-control-plane-boundary.md) | Local control plane is the security boundary | Accepted |
| [0002](0002-fail-closed-policy-gate.md) | Fail-closed policy gate for every privileged action | Accepted |
| [0003](0003-out-of-band-human-approval.md) | Out-of-band human approval for risky actions | Accepted |
| [0004](0004-request-bound-approval-tokens.md) | Request-bound one-time approval tokens | Accepted |
| [0005](0005-hash-chained-audit-log.md) | Hash-chained audit/event log | Accepted |
| [0006](0006-read-only-by-default-tooling.md) | Read-only by default MCP tooling | Accepted |
| [0007](0007-chatgpt-https-mcp-transport.md) | HTTPS streaming MCP transport for ChatGPT connector mode | Proposed |

## Decision rules

1. If a decision affects privilege, auditability, approval, or remote exposure, create an ADR before implementation.
2. A tool may not bypass the policy gate because its caller is trusted. The caller is not trusted. That is the entire point, despite what the tiny optimism goblin says.
3. Security decisions must name their rejected alternatives.
4. Implementation tasks must link back to the relevant ADRs and threat-model sections.
