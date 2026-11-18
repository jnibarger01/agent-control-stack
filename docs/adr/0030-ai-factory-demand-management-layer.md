# ADR 0030: AI Factory is an ACS demand and evidence workflow, not a second control plane

## Status

**Proposed** (2026-11-17). Subject to ADR 0017's Codex Swarm integration review and independent authority tests.

## Context

ACS already owns mission lifecycle, plans, leases, approvals, execution modes, sandboxing, verification and the canonical audit. Codex Swarm supplies within-attempt parallel work and candidate evidence, but its standalone operator service also contains approval/promotion features. An "AI factory" that adds a new queue/lease/approval/promotion pipeline would create an unreviewable split-brain authority.

Operators nevertheless need a product-level work order, acceptance rubric, priority, service-level view and reliable end-to-end delivery into a draft PR.

## Decision

Add `packages/ai-factory` as a **pure advisory demand contract** initially. Strict parsing and deterministic proposal hashing do not grant any rights, spawn workers, call APIs or persist authority. Later slices may bind proposals to existing authenticated ACS missions and compose the existing budget, execution, verifier and publication abstractions. No parallel lifecycle or audit DB is permitted.

Codex Swarm remains subordinate and untrusted in ACS-controlled mode. It may schedule *within a bounded ACS attempt* but cannot approve, merge, push, self-recover across attempt boundaries or determine final success. ACS derives acceptance independently.

Publication is **draft PR only** in the initial product scope, with a separate authenticated ACS authorization for the actual external action. A read-only Outcome Engine PASS is never an execution permit or approval.

## Consequences

- A versioned factory intent/proposal and tests can ship without widening authority.
- Runtime admission, cross-repo transport, sandbox, evidence, publisher, UI and rollout remain separate gated slices.
- The operator can inspect a concrete product contract before approving any new execution.
- A production factory cannot be claimed while ADR 0017 is still proposed and live host/CI gates are missing.

## Rejected alternatives

1. **New factory scheduler/DB/lease system:** duplicates canonical ACS mission control and creates split-brain retries.
2. **Call standalone Swarm REST API:** would inherit its approval and promotion authority, violating ADR 0009 and proposed ADR 0017.
3. **Model-generated grants or "autonomous admin":** prompt text is not an authenticated human approval.
4. **Immediate end-to-end factory PR:** crosses transport, host sandbox, GitHub and recovery boundaries without independent test evidence.
5. **Auto-merge production deliverables:** external side effects and existing repository auto-merge workflows demand a separate authorization and policy review.
6. **Use Outcome Engine verdict to trigger publication:** evidence is not permission (ADR 0028).
7. **Assume worktree cwd is a sandbox:** symlink, process and network access require host enforcement (ADR 0014).

## References

- `docs/ai-factory/PRD.md`
- `docs/ai-factory/production-roadmap.md`
- `docs/architecture.md`
- `docs/mission-runtime.md`
- `docs/security-contracts.md`
- `docs/adr/0009-engine-harness-authority-and-dependencies.md`
- `docs/adr/0011-canonical-audit-sink.md`
- `docs/adr/0014-engine-isolation-boundary.md`
- `docs/adr/0017-codex-swarm-subordinate-execution-engine.md`
- `docs/adr/0028-outcome-engine-verdict-records.md`

## Decision proof required before Accepted

Cross-repo contract fixtures; security review of ACS-controlled Swarm mode; process/credential/egress containment proof; audit and lease fencing; tests proving Swarm cannot promote or self-authorize in ACS mode.

