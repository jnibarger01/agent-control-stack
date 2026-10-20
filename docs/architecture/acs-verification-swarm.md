# ACS-owned ten-agent verification swarm — implementation architecture

Status: **Proposed / experimental**. This document does not authorize execution or promotion.

## Decision

ACS is the **sole control authority** for plan admission, policy, work-item lifecycle,
attempt leases/fencing, retry authorization, verification acceptance, canonical audit,
and PR/deployment promotion. Codex Swarm is a replaceable, subordinate execution engine
when running an ACS-owned attempt. Codex, Claude, Gemini, Hermes, or later runtimes
must all satisfy the same ACS authorization, evidence, and result contracts.

This elaborates [ADR 0015](../adr/0015-advisory-reasoning-evidence-and-independent-verification.md)
(accepted) and [ADR 0017](../adr/0017-codex-swarm-subordinate-execution-engine.md)
(**proposed**). Do **not** treat ADR 0017 as accepted or its proposed adapter as deployed.

## Responsibility matrix

| Concern | Authority | Executor |
| --- | --- | --- |
| Mission decomposition and dependency DAG admission | ACS | Advisory planner proposes |
| Global capacity, budget, attempt ownership, leases | ACS | Scheduler dispatches authorized slots |
| Lane worktrees, processes, localized tests | ACS-scoped execution envelope | Codex Swarm / other engine |
| Evidence observation and validation | ACS evidence authority | Controlled test / artifact collectors |
| Semantic review, contradiction findings | ACS verification policy | Independent reviewer models (advisory) |
| Failure classification and retry/stop | ACS work-items and policy | Engine may only suggest |
| Final acceptance, audit, publication | ACS only | Engine cannot approve, push, or promote |

Codex Swarm's standalone control API may remain available for standalone usage,
but **ACS-owned attempts must not be able to fall back to standalone authority**.
Do not route ACS work through its operator-token task/approval/promotion API.

## Event-driven verification pipeline

1. ACS admits an immutable plan and determines risk, required checks, paths,
   reviewer independence, and a total concurrency/token/cost budget.
2. The selected engine receives a signed, attempt-bound, lease-fenced execution
   envelope. Codex Swarm lanes are restricted to ACS-allocated worktrees.
3. A lane emits *untrusted* artifact-ready telemetry containing attempt ID,
   lane ID, artifact type, workspace revision, content hash, and correlation ID.
   Event delivery must be idempotent and scoped to the active attempt.
4. ACS-controlled evidence collectors confirm the actual artifact revision and
   produce content-addressed observations. A worker's claim is never evidence.
5. A bounded verification queue schedules cheap deterministic checks first:
   schema, paths, secret scan, focused typecheck/lint/unit tests, then semantic
   review for ambiguous or policy-required cases. Parallelism is bounded.
6. Each result is linked to the exact artifact + check definition + toolchain
   + verification policy + sandbox/network profile. Cached PASS is only reusable
   when all dimensions match and ACS reconfirms freshness. FAIL/UNKNOWN must
   not become PASS by caching.
7. ACS reconciles conflicts and missing coverage as BLOCKED/UNKNOWN/DISPUTED.
   A passing reviewer opinion alone must never advance an attempt.
8. Only ACS authorizes a bounded repair iteration on fresh evidence/lease.
   Attempts stop on pass, denial, stop request, maximum iterations, expiry,
   cancellation, irrecoverable gate failure, or budget exhaustion.
9. ACS alone records the final decision in the canonical hash-chained audit
   and, if authorized, publishes through the governed publication path.

## Runtime execution envelope requirements

Use ADR 0017's `ExecutionEnvelope` and `SwarmExecutionEvidence`, with a
per-attempt transport that excludes standalone operator APIs. Enforce
`maxLanes <= 10` during initial rollout (higher schema ceilings do not imply
authorization); policy may lower it. Propagate lease and fencing epoch to all
lane dispatches and evidence ingestion. Reject stale epochs and workspace
mismatches. Cancellation must terminate child process trees.

Allow independent engines behind one `EngineAdapter` contract; models do not
inherit authority merely because their review labels say PASS.

## First implementation slice in this PR

`packages/verification/src/verification-dispatch.ts` introduces a small pure
dispatcher for a verified, admission-controlled queue. It prioritizes
deterministic jobs, caps issued slots, rejects duplicate IDs and invalid
capacities, and avoids repeating an exact cached PASS. This is **not** a live
queue, persistence mechanism, execution engine, cache authority, or rollout
flag. It has no side effects or grant power.

Follow-up slices, each with independent tests and explicit promotion gates:

1. Durable ACS-owned event inbox/outbox and artifact identity, idempotency,
   crash recovery, and lease-fenced ingestion.
2. Persistent queue with ACS-owned global/provider concurrency budgets,
   fairness, cancellation, backpressure, and evidence-first cache keys.
3. Separate deterministic and independent-review workers; emit machine
   observations and advisory findings, never accepted state.
4. Subordinate engine adapter end-to-end, with negative tests proving push,
   merge, approval, stale lease, and standalone fallback are forbidden.
5. Mission Control read-only event stream, benchmark dashboard, and staged
   2 -> 5 -> 10 agent validation.

## Required pre-promotion evidence

- RED/GREEN test evidence for new pure planner and complete package/build checks.
- End-to-end envelope/evidence contract parity across ACS and Codex Swarm.
- Adversarial tests: forged PASS, cache collision across checks, stale policy,
  changed toolchain, replay, revoked lease, divergent workspace, duplicate
  delivery, interrupted worker, over-budget dispatch, cancel, provider 429.
- Check throughput and p50/p95/p99 validation latency under 2, 5, and 10
  concurrent agents. A 100 ms target applies **only** to lightweight
  deterministic local checks, not semantic model/source verification.
- Independent security review before enabling production autonomy.
- No merge, remote push, or service exposure by a subordinate engine.

## Rollout

Default OFF. This PR does not wire dispatch into the running worker or enable
any new backend. Preserve all existing authorization and promotion gates.
Do not merge until CI and independent review are satisfactory.
