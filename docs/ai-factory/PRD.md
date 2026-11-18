# Product Requirements Document: ACS AI Factory

**Document ID:** ACS-FACTORY-PRD-001
**Revision:** 1.0 proposal, 2026-11-17
**Status:** Proposed; implementation scope in [roadmap](production-roadmap.md).
**Product owner:** ACS operator
**Systems:** ACS / Codex Swarm / Jace Commander / Mission Control / GitHub CI

## 1. Problem

Managing individual prompts and ad hoc agents does not create repeatable engineering throughput. Demand lacks reliable prioritization; workers can report success without external proof; failures produce manual recovery; parallel agent systems can duplicate authority. The operator needs a durable, inspectable path from request to verified engineering deliverable without creating another source of approval or lease truth.

## 2. Product statement

An operator can give the factory a bounded, outcome-oriented engineering order. The factory turns it into a **proposal** and an acceptance plan; ACS evaluates policy, human approval where required, execution budget and admission; Codex Swarm executes authorized work in segregated lanes; ACS independently verifies and records results; the publication path opens a draft PR with reproducible evidence.

The product is an **ACS capability**, not a standalone coordinator. Work must continue to be governable even if the factory dashboard, planning model or Codex Swarm itself is offline.

## 3. Personas / jobs to be done

| Persona | Need | Right |
|---|---|---|
| Operator / owner | Request work, approve constrained actions, pause/cancel, inspect proof and cost | Authenticated ACS operator |
| Engineering reviewer | Inspect diff, scope, tests, provenance, hazards and rollback | Read evidence, review PR |
| Factory planner | Suggest decomposition, dependencies and acceptance steps | Proposals only; no execution authority |
| Codex Swarm worker | Build code within an attempt-bound sandbox and return facts | Only its ACS-issued execution envelope |
| Independent verifier | Confirm acceptance against candidate and source of truth | Evidence-only; cannot self-authorize production |
| On-call operator | Diagnose stuck jobs, revoke, reconcile, resume safely | Authenticated ACS operations |

## 4. Goals

- G1: A new accepted order becomes exactly one deduplicated ACS mission, with traceable versioned intent.
- G2: No factory surface can create capabilities, approvals, policy exceptions, leases or audit authority.
- G3: Only admitted work is dispatchable; lane bounds cannot exceed the admitted plan.
- G4: A killed, expired, stale or replayed attempt cannot mutate authoritative state after it loses ownership.
- G5: A reported "done" is **not** a verified outcome. External checks and independent acceptance are necessary.
- G6: The default deliverable is a **draft PR** with a signed-off-by-evidence trail, never an implicit merge or deployment.
- G7: The operator can inspect objective, stage, blocked reason, approvals, spending and source SHA.
- G8: Production operation has rollout, rollback, incident recovery and measurable SLOs.

## 5. Out of scope

- General-purpose AI company, staffing, billing or CRM.
- A second queue, approval DB, policy engine, promotion service or canonical audit.
- Automatic merges, prod deployments, autonomous expenditure outside ACS budgets.
- Broad browser/desktop privileges or unrestricted internet for coding workers.
- Training/fine-tuning models, evaluation of frontier models as a product.
- Retrofitting standalone Codex Swarm's operator API as an ACS-managed authority API.
- Promising fully autonomous recovery of unknown external effects.

## 6. Functional requirements

| ID | Priority | Requirement | Production acceptance |
|---|---|---|---|
| FR-01 | P0 | Versioned strict intake of objective, repo, base SHA, path scope, criteria, budget, mode | Unknown/privileged fields rejected |
| FR-02 | P0 | Deterministic proposal identity, no ambient state or authority fields | Replay yields same proposal hash |
| FR-03 | P0 | Bounded dedupe and idempotent admission in ACS mission store | Same key returns same mission; changed payload conflicts |
| FR-04 | P0 | Map plan to existing mission/work-unit dependencies and budgets | No parallel factory lease or approval records |
| FR-05 | P0 | ACS-issued envelope over per-attempt UDS, enforced isolated process tree | Invalid MAC, epoch, workspace or bound rejected |
| FR-06 | P0 | Explicitly forbidden push/merge/publish in ACS-controlled swarm | Negative bypass tests through all reachable paths |
| FR-07 | P0 | Independent verification and source-bound receipts | Exit code or self-assessment cannot imply success |
| FR-08 | P0 | Draft PR-only output with allowed-path diff validation | Wrong branch/tree/repo or non-draft blocked |
| FR-09 | P0 | Cancellation, revocation, restart reconciliation | No double dispatch or stale result acceptance |
| FR-10 | P0 | End-to-end audit, redaction and budget accounting | Queryable end-to-end correlation; unknown spend not zero |
| FR-11 | P1 | Mission Control factory backlog and stage drill-down | Operator sees ground-truth state and proof |
| FR-12 | P1 | Deterministic prioritization and fair capacity planning | Predictable, bounded scheduling; no starvation |
| FR-13 | P1 | Reusable templates for dependency-scoped repository work | Template cannot broaden accepted scope |
| FR-14 | P1 | Production readiness health and alerting | Fault injection meets operational targets |
| FR-15 | P2 | Multi-project portfolio optimization and trend reporting | Measured gain vs single-line baseline |

## 7. Nonfunctional requirements

- **Security:** fail closed; strict default; scoped operator actions; separate approval for privileged or consequential writes; no raw secrets in model prompts, persisted intents or logs.
- **Durability:** restart recovery and idempotency on every externally consequential step; terminal attempts immutable.
- **Isolation:** dedicated worktree and host enforcement; a cwd restriction or prompt is insufficient.
- **Determinism:** canonical artifacts, fixed schema versions, explicit dependency gates and predictable planner fallback.
- **Observability:** every stage has timestamps, correlation IDs, failure category, source SHAs and evidence provenance.
- **Cost control:** hard per-mission spend/tokens/tools/wall-time/parallelism caps; unreported costs block completion where capped.
- **Compatibility:** pin ACS and Codex Swarm SHAs + fixture versions, test both directions, no silent fallback to standalone Swarm.

## 8. User journeys

### A. Standard engineering order
1. Operator submits scoped order referencing repo, immutable base commit, exact objective, measurable criteria, budget, safe output mode.
2. Planner returns a proposal with immutable hash. Operator may edit and resubmit; edits create a different hash.
3. ACS authenticates origin, validates policy, deduplicates, records the mission and stages units; no planner-authored identity is accepted.
4. ACS allocates a safe workspace and issues a bound execution envelope under a current lease.
5. Codex Swarm creates bounded lanes, runs tools inside isolation, produces commit/diff/test facts and returns untrusted evidence.
6. ACS verifies hashes, independent tests, path scope, provenance, resource usage and terminal state; records the evidence chain.
7. A draft PR is created by the existing ACS publication boundary; operator receives a review-ready evidence summary.

### B. Failed or unsafe work
On denied scope, expired authority, worker escape, unknown external effect, budget exhaustion or inconclusive verification: stop, quarantine/mark blocked, preserve evidence, and require operator-directed recovery. No implicit reissue of approval.

### C. Duplicate request
A duplicate idempotency key with equal immutable order hash returns the same mission; equal key with different payload refuses. Old results never overwrite a new attempt.

## 9. State and vocabulary

**Order:** untrusted desired outcome. **Proposal:** validated, hashed, advisory planning artifact. **Mission:** ACS-owned authoritative lifecycle record. **Unit:** ACS-owned dependency-scoped work. **Attempt:** leased/fenced authorized execution. **Lane:** subordinate Codex Swarm work partition. **Candidate:** Git tree/commit proposed by execution; not accepted. **Verified:** independent evidence supports acceptance. **Published:** ACS created a draft PR, not merged.

Existing ACS mission states and budget rules are authoritative (`docs/mission-runtime.md`); factory UI uses a **projection**, not a new transition graph. No "factory succeeded" state may bypass ACS outcome verification.

## 10. Delivery and acceptance

An order is delivered only when: scope is unchanged; ACS mission and latest attempt are terminal in the correct disposition; verification is independent and evidence-backed; audit chain validates; all required criteria have trusted observation; draft PR references exactly the accepted tree/base; no critical policy/secret gate fails; cost reporting is complete or explicitly marked unaccounted; and the PR/receipt URLs are recorded.

Known scope: initial release supports **one repository, one task order, one candidate draft PR**. Multi-repository transactions are later work.

## 11. Success measures and target SLOs

Targets are **proposals**, not observed results: at least 95% of *eligible admitted* jobs reach a correctly classified terminal state within their configured time budget; 100% of unauthorized execution/promotion negative tests reject; no double publication from replay; ≥99% of receipt correlation joins succeed; 0 accepted outcomes with unknown required evidence; 0 unaccounted spend on jobs with hard spend caps. Delivery throughput and p50/p95 cycle time are measured from actual production receipts. See [metrics](metrics.md).

## 12. Open decisions / dependencies

- ADR 0017 remains proposed; ratify the authority boundary with evidence, not just prose.
- Codex Swarm's ACS-controlled sidecar, UDS service, isolation, crash semantics, and fixture parity need verified shipping SHAs.
- Definition of output publication permission: draft PR creation is still an externally consequential action, requiring the existing ACS publication authorization. No new blanket factory consent.
- Resolve ACS dry-run vs live execution profile on a pinned deploy candidate. A plan cannot declare a feature live.
- Source of truth for terminal acceptance: ACS verification / Outcome Engine records are advisory evidence; publisher still enforces authorization.
- Model/provider strategy and budgeting must be tested for opaque token/spend reporting.

## 13. Release policy

**No production flag** is to be enabled by this PR. Each roadmap slice has a dedicated acceptance record, reviewer signoff, and rollback; F12 alone is the production promotion gate.

