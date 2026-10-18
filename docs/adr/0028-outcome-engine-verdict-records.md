# ADR 0028: Outcome Engine verdicts are evidence records, never authority

## Status

Accepted (first milestone, read-only)

## Context

ACS manages agents well. It does not yet answer the question an operator actually asks: "did this objective get achieved?" An "Outcome Engine" should accept an objective with measurable acceptance criteria, plan the verification, and report `PASS`, `PARTIAL`, `BLOCK` or `FAIL` with evidence, while merges and deployments stay under human control.

Two facts constrain the first milestone:

- The worker still runs in `dry_run` mode (`apps/worker/src/index.ts`, `scripts/check-dry-run-boundary.mjs`). An engine that claimed "outcome achieved" from work ACS performed would be measuring simulated work.
- Merging is not exclusively an ACS action. `.github/workflows/jnibarger01-pr-review-merge.yml` merges non-draft pull requests by `jnibarger01` on a green internal gate (and via `workflow_dispatch` can evaluate any pull request number), and `.github/workflows/dependabot-auto-merge.yml` enables auto-merge for dependabot patch and minor updates. A verdict can therefore never be the only thing standing between a change and `main`.

## Decision

Add `packages/outcome-engine` as a **verified-assessment** engine. It accepts a pull-request-scoped outcome (goal text plus typed criteria), persists a deterministic read-only probe plan, and appends an evidence-backed chain of evaluations. It has no execution, merge, deploy, push, comment, label or approval path.

- **A verdict is evidence, not authority.** Every evaluation carries `merged: false`, `verdictIsApproval: false`, `causality: "assessed_only"` and `executionBasis: "none"`. Verdicts never feed policy, routing, approval, leases, capabilities or completion (ADR 0015, 0020, 0021, 0027).
- **Honest by construction.** `computeVerdict` is pure and is the only producer of a verdict. `PASS` requires every required criterion satisfied by trusted evidence (`acs_observed` or `forge_attested`) read from live GitHub, an identical snapshot hash across two reads, a rollup commit equal to the head commit, a valid audit chain, a present readiness floor, and a fresh observation. Simulated, fixture, asserted, missing or untrusted evidence can neither satisfy nor contradict a criterion. Absence of evidence is undecided.
- **Fail closed.** Any gate (integrity, authority, unavailable evidence, moving snapshot, pull request not open) yields `BLOCK`, never `FAIL` or `PARTIAL`. Unknown criterion kinds, unknown fields and unknown GitHub enum values are rejected.
- **Append-only audit events.** The engine writes only `outcome.accepted` and `outcome.evaluation_recorded`, through a runtime three-method port (`recordSystemEvent`, `readEvents`, `verifyAuditChain`). No migration, table, gateway route or MCP tool is added. Records are brought to their redacted, canonical persisted form before hashing; the reader recomputes content and chain hashes and re-runs the verdict over the stored inputs.
- **Honest limits.** `outcome.*` records are tamper-evident only: any writer to the database can forge them. Acceptance is a local CLI action recorded as `unauthenticated_local_operator` and grants nothing. A recorded `PASS` older than one hour renders as `STALE`.
- **Exit codes.** `acs outcome evaluate` never exits 0 for a verdict (10 PASS, 11 PARTIAL, 12 BLOCK, 13 FAIL), so `&& gh pr merge` cannot turn evidence into authority.
- **Disclosed merge exposure.** Every evaluation reports `humanControl.exposure` as `likely`, `possible` or `unknown`, never `none`, from a table of the repository's merge workflows pinned by a drift test.

## Consequences

- Items 1, 4 and 5 of the milestone (accept a measurable goal, independently verify, report with evidence) are met for pull-request readiness. Items 2 and 3 (plan, assign agents) are met only for the verification plan and verifier assignment. Remediation planning and agent assignment are deferred until a real executor exists.
- The defining metric (share of accepted objectives brought to a verified outcome) is documented but its command is deferred, because without a verified binding between a work item and the pull request the numerator would be dishonest.
- New boundary: an ESLint override for `packages/outcome-engine` composes with, and never replaces, the global Jev/advisor import bans; `packages/outcome-engine/src/architecture.test.ts` and `tests/outcome-boundary.test.ts` enforce it.
- `packages/integration-manager` gains an additive by-number reader (`createGhPullRequestReader`) that also surfaces the base commit, the rollup commit and the app behind each check run.

## Rejected alternatives

- **Drive remediation from the engine now.** Rejected: no real executor exists, and the demonstration would measure simulated work.
- **Sign records with an engine key.** Rejected for this milestone: it needs key management and `secret-broker` is not wired. The trust level is stated as tamper-evident only instead.
- **Add `POST /outcomes` and an MCP tool.** Deferred: it needs `requireHumanApprovalActor`, a preview/accept two-step and rate limiting, none of which should be rushed into the first slice.
- **Reuse `harness/outcomes.ts`.** Rejected: it wraps the Managed Agents `user.define_outcome` event and has no relation to this record family.
- **A new database table and migration.** Rejected: audit events are sufficient for the volume of a first milestone; a table is the upgrade path if the scan cap is reached.
