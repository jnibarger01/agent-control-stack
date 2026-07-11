# ADR 0002: Fail-closed policy gate for every privileged action

## Status

Accepted

## Context

The control plane will receive natural-language-derived requests from ChatGPT and other agents. Those requests may be malformed, overbroad, prompt-injected, stale, or intentionally hostile.

A permissive policy engine creates a remote-control toy with an incident report attached. Nobody needs that hobby.

## Decision

The policy gate must fail closed.

If a request cannot be parsed, classified, authorized, bounded, audited, or approved, it must not execute.

Policy decisions use these minimum outcomes:

| Decision | Meaning |
|---|---|
| `allow_readonly` | Safe read-only operation may execute. |
| `require_approval` | Operation is potentially mutating or sensitive and must wait for human approval. |
| `deny` | Operation is not allowed under current policy. |
| `deny_forbidden` | Operation is categorically forbidden. |

Risk classification must consider:

- Tool name
- Arguments
- Working directory
- Realpath containment
- File sensitivity
- Command and subcommand
- Environment variables
- Network exposure
- Service/process impact
- Whether the request is replayed or stale

## Consequences

- Unknown tools are denied.
- Unknown commands are denied or approval-gated, never silently allowed.
- Path resolution errors deny execution.
- Missing config denies startup or privileged operation.
- Audit write failure denies mutation.
- Approval-store failure denies approval-gated execution.

## Rejected alternatives

### Allow by default inside configured roots

Rejected. Directory containment is necessary but not sufficient. Running `git status` and overwriting `.git/config` are not the same thing, despite both living in the same folder like two snakes in a drawer.

### Warn but execute

Rejected. Warnings are UX. They are not enforcement.

### Classify only by tool name

Rejected. Tool name alone is too coarse. `cmd.run` can be harmless or catastrophic depending on command, args, cwd, and environment.

## Implementation requirements

- Every tool handler must call the policy engine.
- Every policy decision must include a reason code.
- Tests must assert deny-by-default behavior.
- Policy changes must be covered by regression tests.
