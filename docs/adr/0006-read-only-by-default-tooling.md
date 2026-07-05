# ADR 0006: Read-only by default MCP tooling

## Status

Accepted

## Context

ChatGPT-facing tools should start with inspection and diagnostics. Mutation is useful, but early unrestricted mutation is how a helpful assistant becomes a locally hosted accident generator.

## Decision

MCP tools are read-only by default.

Mutating tools must be separately named, separately tested, approval-gated, and audited.

Tool families should be split by capability:

| Family | Default posture |
|---|---|
| `system_*` | Read-only |
| `fs_*` | Read-only except explicit write/patch/move tools |
| `cmd_*` | Preview first, execution constrained |
| `service_*` | Status read-only, restart approval-gated |
| `approval_*` | Visibility only through MCP; approval grant out-of-band |
| `work_*` | Work creation controlled; worker execution lease-bound |

## Consequences

- Tool descriptions must not imply broad authority.
- Read operations still require path and sensitivity checks.
- Mutating operations must not be hidden inside generic tools.
- A model should be able to inspect before proposing action.

## Rejected alternatives

### One generic `run` tool

Rejected. It destroys useful policy granularity.

### One generic filesystem tool

Rejected. It makes read/write/delete distinction too easy to blur.

### Start with full power and restrict later

Rejected. That is not an MVP. That is a cleanup bill.

## Implementation requirements

- Tool names should be compatible with ChatGPT function naming constraints; prefer snake_case names.
- Every tool schema must be explicit and narrow.
- Mutating tools must return pending approval state when no valid approval exists.
- Read-only tools must still redact sensitive output.
