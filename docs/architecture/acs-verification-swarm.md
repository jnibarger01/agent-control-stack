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
deterministic jobs, caps issued slots, rejects duplicate job IDs and invalid
capacities, and avoids repeating an exact cached PASS. Each job carries a
per-run `jobId` and a stable `checkId`; the cache matches on `checkId`. Every
pending job is returned in exactly one of `dispatch`, `satisfiedByCache` (with
the matched entry, for ACS to reconfirm) or `deferred`, so missing coverage is
never silent. This is **not** a live
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

## S0 decision record — review required before ADR 0017 acceptance

**Recommendation:** accept the *authority separation* in ADR 0017, but do not
change its status from Proposed until the network isolation profile and
negative enforcement tests are reviewed. This is a decision proposal, not an
authorization to deploy or to broaden egress.

### Network contract decision proposal

- Default network policy remains `none`. For model-backed lanes, introduce
  a distinct, versioned `codex-swarm-v1` isolation profile that enforces
  `scoped-egress:<allowlistHash>` at the actual process-tree boundary.
- The admitted plan must bind the exact profile, provider endpoint allowlist,
  DNS/proxy behavior, tool permissions, secret-injection channel, and revision.
  All changes require re-admission and fresh attempt authority.
- Do not interpret a hashed allowlist string as network enforcement. Verify
  the actual sandbox mechanism, redirects, DNS resolution, sub-processes,
  and denial of unlisted hosts before enabling any provider traffic.
- No `unmanaged-egress` fallback for governed swarm attempts. Provider
  unavailability, policy mismatch, and egress denial must fail closed.
- No networked swarm launch until contract tests and independent security
  review pass. This PR does not modify the plan contract.

### Cache and dispatch safety correction

The experimental `planVerificationDispatch` helper currently compares only
check ID, artifact hash, policy hash, and toolchain hash. **These are not
sufficient production cache keys.** A future ACS-owned cache must additionally
bind: admitted plan hash, attempt/fencing context or an explicitly proven
cross-attempt reuse rule, workspace tree SHA, exact command/argv and check
definition, dependency lockfile, environment allowlist, sandbox/network
profile, verifier implementation and identity, evidence manifest hash,
expiry/revocation, and validation freshness.

Until that full binding and trusted ACS evidence-store lookup exist, callers
MUST pass an empty cache array and must never use a skipped job as proof that
a required check passed. A cache hit is only an optimization after ACS
independently validates the corresponding machine observation.

The helper does not authorize work, satisfy gates, or accept semantic PASS.
Semantic reviewers produce advisory findings; ACS policy alone concludes.

### Scheduling and retries

Do not create a second global scheduler. Reuse ACS mission admission, budget,
resource claims, lease/fencing, and attempt lifecycle. Any backend may narrow
its `maxLanes`, never expand ACS concurrency. Swarm loop iterations are
strictly within a single ACS attempt and bounded by its envelope; retries
across attempts require a new ACS authorization.

### Durable verification completion

Swarm EventBus notifications are telemetry, not reliable verification
completion. ACS must persist an idempotent check record before scheduling,
with terminal PASS/FAIL/BLOCKED/UNKNOWN, lease ownership, timeout, crash
recovery, and a canonical audit link. Missing, timed-out, or crashed checks
are BLOCKED/UNKNOWN, never silently treated as PASS.

### Delivery sequence

S1: add fail-closed envelope verification in Codex Swarm against shared ACS
golden fixtures (no runtime activation).

S2: add a hard ACS-mode fork disabling operator API, push, root promotion,
and automatic recovery; test standalone compatibility.

S3: add a disabled ACS `codex_swarm` backend adapter using a fake child first.

S4: ingest untrusted swarm evidence and independently run ACS ResultValidator,
EvidenceManifest creation, independent verification, and canonical audit.

S5: implement durable ACS verification queue, strict cache, hard timeouts,
and advisory semantic review with crash/replay tests.

S6: benchmark isolated 2, then 5, then 10 lanes under existing ACS budgets;
raise limits only through explicit reviewed policy changes.

**Merge gates:** focused and full CI, contract compatibility across both
repositories, adversarial tests, independent security review, and explicit
acceptance of the egress isolation profile. No production rollout in this PR.
