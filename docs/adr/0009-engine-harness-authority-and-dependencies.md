# ADR 0009: ACS remains the sole Engine Harness authority

## Status

Accepted

## Context

Agent Control Stack already owns policy decisions, approvals, work-item state,
worker claims and leases, result acceptance, and the canonical SQLite audit
chain. The repository also contains model-facing and tool-facing code in
`harness/`, `packages/acp-adapter`, and `packages/machine-controller`. Those
surfaces are useful implementation evidence, but they are not separate
authorities.

Adding live engine execution without an explicit ownership boundary would make
it easy to create a second orchestrator, policy layer, approval path, lifecycle,
or audit record. Two components able to decide whether the same action may run
is a split-brain security defect.

The first Engine Harness release is deliberately narrow: one repository, one
engine adapter, one worktree per execution attempt, local Git operations,
allowlisted validation commands, no general-purpose shell, no arbitrary
network, no push, no deployment, no scheduler, and no new control dashboard.

## Decision

ACS is the only execution authority. Engine Harness components extend the
existing control plane; they do not form a peer control plane.

### Authority ownership

| Concern                              | Sole authority                                                        | Non-authoritative collaborators                                      |
| ------------------------------------ | --------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Policy and risk decisions            | `packages/policy-gate`                                                | Intake classifiers and engine suggestions are evidence only          |
| Approval requirements and decisions  | `packages/policy-gate` plus approval records in `packages/work-items` | UIs and adapters may request or display approval                     |
| Work-item lifecycle                  | `packages/work-items`                                                 | Apps invoke domain operations but do not invent states               |
| Dispatch authorization               | Claim-time policy and approval checks in `packages/policy-gate`       | `apps/worker` coordinates the call                                   |
| Worker claims, leases, and fencing   | `packages/work-items`                                                 | Workers hold opaque lease identity but do not define validity        |
| Result acceptance and terminal state | `packages/work-items`                                                 | Sandbox and engines return untrusted observations                    |
| Canonical audit and replay           | Hash-chained `audit_events` managed by `packages/work-items`          | JSONL logs, process logs, and LoopTrace are projections or telemetry |
| Process containment                  | `packages/sandbox`                                                    | The worker supplies an already-authorized execution request          |
| Workspace allocation                 | A dedicated domain package introduced by Phase 2                      | Git is an adapter; engines receive only the allocated path           |
| Engine protocol translation          | A dedicated adapter package introduced by Phase 3                     | The engine is untrusted and has no policy or approval authority      |

Policy can increase restrictions at any later boundary. No advisory component
may lower a decision already made by ACS.

### Dependency direction

The allowed dependency direction is inward:

```text
apps/gateway      apps/worker
      |                |
      v                v
policy-gate   engine-adapter (future coordinator-facing port)
      |                |
      v                v
work-items     sandbox / workspaces (future capability adapters)
      \                /
       \              /
             shared
```

The diagram is ownership-oriented, not a requirement that every package depend
directly on every lower package. In particular:

- Apps may compose packages; packages must not import apps.
- `packages/work-items` owns durable domain state and may depend only on
  lower-level shared primitives and SQLite adapters.
- `packages/policy-gate` may inspect work-item contracts and shared primitives.
- `packages/sandbox` and the future workspace package enforce capabilities; they
  must not grant approvals, transition work-item lifecycle independently, or
  write a second audit history.
- The future engine adapter must expose engine protocol events as untrusted
  proposals. It must not execute tools directly or depend on gateway/worker
  implementation details.
- `harness/` remains evaluation and reference code until individual behavior is
  adapted behind the authoritative path.

### Forbidden paths

The following are architectural violations:

- An engine, adapter, sandbox, workspace manager, or worker self-approves.
- A model-facing path invokes a privileged filesystem, process, network, Git,
  MCP, or external-service action without execution-time policy evaluation.
- A worker accepts engine text as proof of completion.
- A package or service stores a second authoritative work lifecycle, approval
  state, lease, result, or audit chain.
- `packages/machine-controller` JSONL records are used to prove authorization,
  approval, execution, or completion.
- Mission Router, `openclaw-agent-orchestrator`, LoopTrace, or an engine provider
  is imported as an execution authority.
- A missing capability adapter falls back to direct host execution.

`packages/machine-controller` may continue serving its current bounded,
read-only local MCP tools. Its development-only `test.agent.run` path remains
disabled by default and cannot become a live Engine Harness path.

## Consequences

- The worker can stay thin: it coordinates domain decisions and adapters, while
  authoritative mutations remain in existing packages.
- New packages must represent capability adapters or domain concepts, not new
  control planes.
- Existing root `harness/` code is not promoted wholesale. Reusable contracts
  move behind tests into the authoritative path; obsolete direct execution is
  deprecated.
- Live engine execution remains blocked until sandbox and workspace authority
  are implemented and tested.
- Scheduling and operator UI remain later consumers of the same work-item API.

## Enforcement

Before any live engine adapter is enabled:

1. Static dependency tests must reject package-to-app imports and direct
   execution imports outside the approved coordinator.
2. Adversarial adapter tests must prove that an engine tool request cannot
   bypass policy, lease, workspace, sandbox, or audit checks.
3. Every accepted result must reference the authoritative work item, lease,
   action/plan hash, attempt, workspace, and canonical audit events.
4. Direct model-execution helpers must be absent from production entry points
   or fail closed behind explicit development-only configuration.

## Rejected alternatives

### Add a separate harness orchestrator service

Rejected. It would duplicate dispatch, lifecycle, recovery, and audit authority.

### Make the engine adapter responsible for approvals

Rejected. The engine is an untrusted principal and cannot approve its own
proposals.

### Use LoopTrace as the live audit backend

Rejected. LoopTrace is a downstream replay and regression consumer. ACS must be
able to authorize and recover locally without it.

### Import the prototype orchestrator as a dependency

Rejected. Prototype patterns may be inspected selectively, but importing its
authority would preserve the split brain this ADR removes.
