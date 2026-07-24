# ADR 0003: Out-of-band human approval for risky actions

## Status

Accepted, with a 2026-07-24 clarifying note: "capability" in Implementation Requirements below does not mean a bearer token — see [ADR 0004](0004-request-bound-approval-tokens.md), which was itself amended the same day to retire that requirement. The core decision here (approval must not be grantable through the same MCP/requester channel) is unchanged and is enforced today. Two things below are narrower in the current implementation than this ADR's original wording suggests, noted inline rather than rewritten:

- "Acceptable approval channels" (below) lists local-only surfaces (CLI, localhost UI, tray app). The actual implementation permits approval from any authenticated gateway mutation actor calling `/work-items/:id/approve` over HTTP — which is not restricted to a local-only channel, only to a channel distinct from the MCP tool-call path. If approval is meant to be physically local, that constraint isn't enforced by anything today.
- "Approval grant must produce a capability that is request-bound and one-time use" (Implementation Requirements): the capability is the stored approval record itself (bound to the policy-evaluated action hash, single-consumption via an atomic status transition), not a bearer token a human re-presents. See [approval-lifecycle.md](../protocol/approval-lifecycle.md) for the enforced mechanism.

## Context

The system will expose tools to ChatGPT. Some tools may mutate files, run commands, restart services, open tunnels, or dispatch work to local workers.

If ChatGPT can approve its own privileged action through another MCP tool, approval is theater. Theater has its place. Security architecture is not it.

## Decision

Risky actions require out-of-band human approval.

The approval path must not be controlled solely through the same ChatGPT/MCP request channel that requested the action.

Acceptable approval channels include:

- Local CLI
- Local web UI bound to localhost
- Desktop notification/tray app
- Hardware-backed confirmation in the future

MCP may expose pending approval state, but it must not expose reusable approval authority to the model.

## Required approval contents

Every approval prompt must show:

- Requested tool
- Exact normalized arguments
- Real working directory
- Risk level
- Policy reason
- Files/services/processes affected
- Expected mutation, if known
- Expiration time
- Request hash

## Consequences

- Approval UX must be built as a first-class subsystem, not an afterthought.
- Tests must prove an MCP client cannot approve and execute a risky action by itself.
- Approval events must be audited.
- The human should have enough detail to reject obviously bad requests.

## Rejected alternatives

### MCP approval tool callable by ChatGPT

Rejected. It collapses requester and approver into the same compromised channel.

### Natural-language confirmation only

Rejected. The model can hallucinate, omit, or reframe the risk.

### Global session approval

Rejected for MVP. It creates broad authority that is too easy to misuse. Approval should bind to a specific request.

## Implementation requirements

- Approval creation may be exposed through MCP as a pending request.
- Approval grant must happen outside MCP.
- Approval grant must produce a capability that is request-bound and one-time use.
- Approval decisions must be recorded in the audit log.
