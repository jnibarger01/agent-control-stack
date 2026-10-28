# ADR 0029: The desktop harness is an ACS client; ACS stays the only execution authority

## Status

Proposed. Depends on one explicit decision (anchor choice, below) that **amends the rejected alternatives of [ADR 0022](0022-human-authorized-agent-runs.md)**. Do not mark Accepted without a human owner of ADR 0022 confirming it.

Numbering note: earlier harness work in a separate worktree used 0025 to 0028 for harness ADRs [see `docs/desktop-harness-slice1-assessment-20261022.md`]. Those numbers are taken in this repository by other decisions; any such ADRs must be renumbered when they land. This ADR uses the next free number.

## Context

The goal is a desktop workstation where Claude Code, Codex, Gemini CLI, Hermes, local models and custom agents run under one orchestration, permissions and observability system. The architecture review recommends a Claude Desktop-style experience on top of ACS, and warns against a second control plane.

Facts that constrain the decision:

- ACS is the sole execution authority (ADR 0008, 0009) and the SQLite hash chain is the canonical audit sink (ADR 0011).
- ADR 0022 and 0024 dispatch CLI agents as **agent runs**. Those have no work item, plan, lease or approval record; ACS authority over what the CLI does is limited to the worktree and the CLI's own permission mode. ADR 0022 explicitly rejected extending the hash-bound execution plan with a third backend that allows network.
- The governed path (work item, approval, lease, fencing epoch, capability, validated result, independent verification) exists for Desktop Commander and Jace Commander execution.
- The investigation of Claude Desktop recovered neither its approval gate location nor its agent loop, and observed a permission bypass in its local configuration. Static analysis only; the native-analysis mandate was not met.
- A local desktop prototype (Relay) shows a native "allow once" dialog and can spawn MCP servers directly. Those are local decisions with no ACS binding.

## Decision

1. **Authority.** The harness is an ACS **client and worker-class executor**. It may request, claim, observe, execute within a lease, and submit results. It never approves, grants, widens, infers or records authority. The renderer and the agent hold none.
2. **Anchor (the decision needing confirmation).** A harness run is anchored on an ACS **work item and attempt with a lease and fencing epoch**, using the existing approval, claim, result and verification machinery. This needs a plan backend for an interactive agent session (contract gap G1). The alternative, extending agent runs, is listed under rejected alternatives.
3. **Adapters.** Every runtime implements the versioned `harness.adapter.v1` interface. Adapters report only capabilities they can prove, and report a governance level using the ADR 0024 vocabulary (`governed`, `acs_guarded`, `os_sandboxed`, `host_permissions`). The harness refuses a run whose adapter reports a lower level than the work item requires.
4. **Permission bypass.** Agent-side bypass settings are never authorization. An adapter whose effective configuration enables one refuses to start.
5. **Approvals.** A tool approval binds the exact invocation (name and arguments), requesting account, workspace, adapter configuration, attempt and expiry, and is single use. Until ACS binds configuration into the approved hash (gap G2), runs must not be described as configuration-bound.
6. **Uncertainty.** An uncertain result is `outcome_unknown` until reconciled from evidence. There is no automatic retry edge from it; retry is an operator action creating a new ACS attempt.
7. **Events.** The harness event log is an ordered, gapless projection with replay cursors. It is never authoritative. ACS audit refs anchor the facts that matter.
8. **Isolation.** Agents run in a fail-closed sandbox on an isolated worktree with no host credential file mounted and no long-lived provider credential in the child. Anything weaker is labeled at its true level.
9. **Scope of ADR 0022.** Operator-dispatched host-side CLI runs (ADR 0022, 0024) are unchanged and remain ungoverned in the sense they already state. They are not used as a substitute for harness runs.

## Consequences

- Positive: no second lease, approval, audit or policy system. Multi-agent delegation later reuses the same authority path, with `parentRunId` already reserved.
- Positive: adapter honesty is mechanically testable (conformance suite), so a UI can trust the governance label.
- Cost: ACS changes are required (gaps G1 to G9 in the [integration contract](../multi-agent-harness/acs-integration-contract.md#11-gaps-in-acs-today-all-ask-first-each-is-its-own-acs-slice)). The plan backend change touches a hash-bound authority contract and every consumer of it.
- Cost: slower first demo than reusing agent runs, in exchange for real lease, fencing and approval binding.
- Risk: the harness process is a worker with a credential and a lease token. Mitigated by worker-credential TTL and rotation, memory-only lease token, and the gate-token design.
- The harness package cannot import ACS stores; it speaks HTTP. This is enforced by lint (task T2) so it cannot drift into an in-process authority.

## Rejected alternatives

- **Extend ADR 0022/0024 agent runs with leases and per-call approvals.** Smaller first step, but it builds a second lease, fencing and approval system beside the work-item one: exactly the second control plane the review warns against. Revisit only if the plan-backend change (G1) is refused.
- **Keep local approvals in the desktop (Relay-style dialog).** A local decision is not ACS-bound, not single-use at ACS, and not in the audit chain.
- **Adopt Claude Desktop's permission model or its bypass defaults.** The gate location is unverified and the observed configuration disables prompts.
- **Patch the installed Claude Desktop package or call private endpoints.** Upgrade fragility, authentication problems, unreviewable security surface.
- **Let the harness event log be the source of truth for run state.** Splits authority from audit and makes crash recovery depend on a cache.
- **Treat the agent's exit code or self-report as success.** Already rejected for agent runs in ADR 0024 ("Exit 0 is not success").

## Links

[PRD](../multi-agent-harness/prd.md), [integration contract](../multi-agent-harness/acs-integration-contract.md), [Claude Code adapter](../multi-agent-harness/claude-code-adapter.md), [implementation plan](../multi-agent-harness/implementation-plan.md), [threat model](../threat-model.md).
