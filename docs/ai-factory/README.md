# ACS AI Factory

**Status:** Proposed production program; Slice F0 planning contract implemented in this PR. No live factory dispatcher, worker, API, or autonomous publisher is enabled.

ACS AI Factory is the **production management layer** for governed engineering missions. It converts bounded demand into evidence-defined outcomes, routes eligible execution through the existing ACS mission/attempt lifecycle, uses Codex Swarm as an *untrusted subordinate engine*, and delivers reviewable PRs. It is not a new scheduler, approval service, lease system, audit database, or agent runtime.

## Start here

1. [Product requirements](PRD.md): users, requirements, service levels, non-goals and success measures.
2. [Slice-by-slice production plan](production-roadmap.md): ordered F0–F12 implementation slices, dependencies, precise acceptance and rollback.
3. [Architecture and integration](architecture.md): ACS ownership, Codex Swarm contract, event/state design and cross-repo seams.
4. [Factory input contract](contracts.md): versioned proposal, trust semantics, compatibility and example.
5. [Threat model](threat-model.md): abuse cases, controls, negative acceptance tests.
6. [Verification matrix](verification.md): test taxonomy, fixed gates, injected failures, go/no-go rubric.
7. [Operations runbook](runbook.md): on-call, safe rollout, rollback, incident handling and evidence retention.
8. [Metrics and economics](metrics.md): what to measure, how to prevent unverified "success".
9. [Decision ADR 0030](../adr/0030-ai-factory-demand-management-layer.md): authority and rejected alternatives.

## Ownership in one sentence

**Factory proposes; ACS admits and governs; Codex Swarm executes bounded lanes; independent verification assesses evidence; ACS publication creates a PR; humans or an explicitly authorized ACS policy decide consequential transitions.**

## Current repo evidence and limits

- ACS already has a general mission/work-unit state machine, budget tracking and fenced dispatch (`docs/mission-runtime.md`).
- ACS already defines the Codex Swarm envelope/evidence schema (`packages/engine-adapter/src/codex-swarm-envelope.ts`). This is **not** equivalent to a production adapter.
- ADR 0017 is still **Proposed**. Its controlled-child / UDS isolation and acceptance conditions must be resolved before live factory execution.
- Production worker documentation continues to describe a dry-run-first boundary (`docs/runbooks/production.md`). Do not equate a demo, sandbox test, or proposal with verified real execution.
- Factory Slice F0 supplies a deterministic, strictly validated **non-authoritative** proposal model; it does not mint ACS credentials, work items, approvals, claims, leases, capabilities, receipts or verdicts.
- Codex Swarm is a separate repository and can have unmerged local branches. Cross-repo compatibility must be reverified against pinned SHAs during integration; its standalone API is not an ACS authority channel.
- None of the following documents represent completed rollout evidence. Unchecked gates are future work.

## Definition of production

Production means a pinned and reproducible build can accept a real scoped engineering request, bind it to an ACS mission, dispatch an ACS-authorized isolated Codex Swarm attempt, recover coherently after failures, independently verify the candidate, produce a draft PR, account for spend and evidence, honor approvals and revocation, and roll back safely. Each claim must link to an actual run on a specific commit.

## PR scope

This first PR intentionally contains a large, inspectable **program definition** plus the F0 executable planning contract and focused tests. Follow-on slices are separate PRs; they are *not* authorized or implemented by merging this PR.

