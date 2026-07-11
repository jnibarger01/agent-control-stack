# ADR 0003: Out-of-band human approval for risky actions

## Status

Accepted

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
