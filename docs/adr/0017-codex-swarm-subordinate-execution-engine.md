# ADR 0017: Codex Swarm is a subordinate execution engine, not a peer control plane

## Status

Proposed

## Context

`codex-swarm` is a separate repository and service that decomposes a coding
task into parallel lanes, isolates each lane in a git worktree, runs a worker
transport (Codex `exec`, Claude/Gemini/OpenCode CLIs, an HMAC-signed HTTP
worker), derives an authoritative return report from real git state plus real
acceptance/validation command runs, aggregates lanes with footprint-overlap
detection, and runs a deterministic gate chain (lint/typecheck/unit/build +
diff-scoped secret scan). That execution capability is genuinely useful and is
not duplicated anywhere in ACS.

Codex Swarm also ships its own control plane: a loopback HTTP API with an
operator bearer token (`POST /api/v1/tasks`, `/aggregation`, `/approvals`,
`/tasks/:id/promote`), a fail-closed `PromotionGuard` that records human grants
in its own SQLite `approval_grants` table, a `promotion-executor` that merges
verified lane branches into the real root repository and a `git-runner` whose
grant-gated `push` writes to a real remote, a non-hash-chained `audit_events`
table, and a crash-recovery path that autonomously requeues in-flight lanes.

Every one of those overlaps an authority ACS already owns exclusively
([ADR 0009](0009-engine-harness-authority-and-dependencies.md),
[ADR 0011](0011-canonical-audit-sink.md),
[ADR 0001](0001-local-control-plane-boundary.md)): work-item and attempt
lifecycle, policy, approval, leases/fencing, execution authorization, result
acceptance, the canonical hash-chained audit sink, retries/clones, and final
promotion authorization. Two components able to decide whether the same change
may merge and push is the split-brain defect ADR 0009 exists to prevent.

Merging Codex Swarm into this monorepo is not required and is not proposed.
Codex Swarm stays its own repository, process, and service, and must remain
independently usable. What this ADR defines is the boundary that lets ACS drive
it as one execution attempt without inheriting a second control plane.

## Decision

Codex Swarm, when launched by ACS, is an `EXECUTION_PRINCIPAL`
([ADR 0015](0015-advisory-reasoning-evidence-and-independent-verification.md)):
an untrusted execution backend with no policy, approval, audit, lifecycle, or
promotion authority. ACS drives it through the existing `EngineAdapter`
interface, behind the existing `ExecutionController`, exactly as it drives
`CodexEngineAdapter`.

### Integration surface

- A new `CodexSwarmEngineAdapter` in `packages/engine-adapter/src/codex-swarm.ts`
  implements `EngineAdapter` (`id = "codex-swarm"`). It builds an immutable
  `ExecutionEnvelope` from the `EngineTask` and the admitted plan, spawns a
  Codex Swarm child process in ACS-controlled mode, and returns one terminal
  `EngineOutcome` plus a typed `SwarmExecutionEvidence` side channel.
- Transport is a dedicated, minimal `/acs/v1/*` HTTP contract over a
  per-attempt Unix domain socket whose path ACS supplies to the child process.
  Not MCP (a tool-call surface and a second governed control plane; wrong shape
  and forbidden by ADR 0009 for ACS-owned work). Not Codex Swarm's operator
  HTTP API (it carries the authority being removed). Not an in-process library
  adapter (Codex Swarm owns `node:sqlite`, worktrees, process trees, and its
  own restart recovery; linking that into `apps/worker` couples failure
  domains). A per-attempt child process means ACS owns start/stop/kill and the
  socket dies with the attempt.

### `ExecutionEnvelope` (ACS -> Codex Swarm)

Immutable, tamper-evident, and bound to exactly one attempt. Carried fields:
`schemaVersion`, `acsWorkItemId`, `acsAttemptId`, `planId`, `admittedPlanHash`,
`leaseId`, `fencingEpoch`, `auditCorrelationId`, `idempotencyKey`,
`workspace { allocationId, hostPath, expectedBaseSha }`, `objective`,
`permittedPaths[]`, `forbiddenPaths[]`, `permittedOwnerProfiles[]`, `maxLanes`,
`maxLoopIterations`, `networkPolicy` (`"none"` or
`"scoped-egress:<sha256 of the sorted host:port allowlist>"`), `timeoutMs`,
`acceptanceCommands[]`, `validationCommands[]`, `evidenceRequirements[]`,
`issuedAt`, `expiresAt`, `envelopeHash`, and `mac`.

`envelopeHash` is `domainHash("acs:codex-swarm-envelope:v1", body)`. `mac` is
`HMAC-SHA256` over the canonical body keyed by a per-attempt secret delivered
to the child process out of band (the same single-credential injection model
`EngineIsolationBackend` uses; not ed25519 — ADR 0012 retired that reference).

Codex Swarm must fail closed if the envelope is absent, unparseable, its MAC
does not verify, it has expired, its `acsAttemptId` is not the one bound to the
injected secret, or the workspace HEAD is not descended from
`expectedBaseSha`. Codex Swarm may narrow any bound (fewer paths, fewer
profiles, fewer lanes); it may never widen one.

### `SwarmExecutionEvidence` (Codex Swarm -> ACS)

Execution evidence only. There is no `succeeded`, `approved`, or `promoted`
field. Fields: the echoed `acsAttemptId` / `envelopeHash` / `leaseId` /
`fencingEpoch`, `exitStatus` (`completed` / `timeout` / `cancelled` /
`spawn_error`), `laneResults[]` (per lane: owner profile, transport id,
timing, worker run status, base/head/tree SHAs, commits, files changed,
footprint result, acceptance/validation results, gate verdict, secret-scan
result, blockers), `integration` (`integrationBranch`, `integratedHeadSha`,
`integratedTreeSha`, `topologicalOrder[]`, `overlaps[]`) or `null`,
`aggregateVerdict`, `swarmInternalRecommendationIdentity`, `loopIterationsRun`,
`loopStopReason`, and an `evidenceBundle` (redacted Codex Swarm `audit_events`
for the run's correlation id plus `auditLogHash` and `diffHash`).

ACS then independently: verifies the echoes; confirms the integrated tree is
descended from `expectedBaseSha`; runs `ResultValidator` against the workspace
with `allowedPaths` derived from the admitted plan (never from the evidence);
builds an `EvidenceManifest` (`sandboxProfile: "codex-swarm-v1"`); runs
`runIndependentVerification` with a verifier engine that is not `codex-swarm`;
transitions the attempt (`succeeded` / `failed` / `quarantined`) with a
hash-chained audit append; and, only on approval, promotes via
`packages/publication` (still PR-only, `allowPush` unchanged).

### Promotion

ACS owns mechanical promotion. Codex Swarm integrates its own lanes into an
attempt-local integration branch **inside the ACS-allocated workspace**
(`workspace.hostPath`) and returns one candidate `integratedTreeSha` plus
evidence. It does not touch the real root repository or any remote. In
ACS-controlled mode Codex Swarm's `PromotionGuard`, operator-token approval,
root-targeted `promotion-executor`, and `git-runner.push` are neutralized:
`push` throws unconditionally and `mergeLane` / `checkoutRoot` throw if the
resolved target is outside `workspace.hostPath`.

The alternative — ACS issues a narrowly scoped promotion authorization bound to
`{ acsAttemptId, integratedTreeSha, target repo/branch, actionHash,
fencingEpoch }` and Codex Swarm performs the mechanical merge/push — is
rejected for now: it keeps a real-root-mutation code path alive in the
subordinate, adds a second authorization artifact type with its own replay and
fencing surface, and duplicates the lease-fenced push/PR boundary
`packages/publication` already provides.

### Audit

The hash-chained SQLite `audit_events` table managed through
`packages/work-items` stays the sole canonical audit sink for the attempt
(ADR 0011). Codex Swarm's `audit_events` table is local telemetry; the
redacted slice for the run's correlation id is returned inside
`SwarmExecutionEvidence.evidenceBundle`, hashed, and referenced by the ACS
`EvidenceManifest`. No ACS consumer reads `swarm.db` as an authority.

### Independent usage

Standalone Codex Swarm is unchanged: its operator API, `PromotionGuard`, and
human-grant promotion flow behave exactly as before. The mode is selected by a
single environment variable (`SWARM_CONTROL_PLANE=acs`) that hard-forks
`main.ts` so the ACS-controlled path cannot also start the operator API. The
ACS adapter refuses to proceed unless the child's `/acs/v1/health` reports
`control_plane: "acs"` and `operator_api_listening: false`.

### Rollout guard

Until this ADR is accepted and a `codex-swarm-v1` isolation profile contains
Codex Swarm's process tree and egress the way `EngineIsolationBackend`
contains a single CLI, the `codex_swarm` execution backend is gated behind
`ACS_EXECUTION_BACKEND=codex_swarm` and refuses to run when
`NODE_ENV === "production"`.

## Consequences

- `packages/engine-adapter` gains one adapter and one envelope/evidence schema
  module. `EXECUTION_BACKENDS` gains `"codex_swarm"`.
- `ExecutionController` gains an optional evidence hook so a `codex-swarm`
  outcome feeds validation and the evidence manifest; its write boundary stays
  `planAllowedWritePaths`.
- Codex Swarm gains an `src/acs/` module and a `SWARM_CONTROL_PLANE=acs` fork
  of `main.ts` that disables its operator API, approval, promotion, and grant
  authority for ACS-owned attempts.
- ACS remains able to authorize, execute, verify, and recover locally with no
  dependency on Codex Swarm's control surface.

## Rejected alternatives

### Merge Codex Swarm into the monorepo

Rejected. Not required. Codex Swarm must remain independently usable, and
importing its authority would preserve the split brain this ADR removes.

### Reuse Codex Swarm's existing operator HTTP API as the transport

Rejected. That API carries task, approval, and promotion authority. Reusing it
guarantees drift and an accidental self-authority fallback path.

### MCP transport

Rejected. MCP is a reusable-tool surface, not an attempt-bound execution
envelope. It would be a second governed control surface for ACS-owned work,
which ADR 0009 forbids. Codex Swarm exposing MCP for independent use is
orthogonal and must not allow bypassing ACS authority for ACS-owned attempts.

### Let Codex Swarm merge and push under a scoped ACS grant

Rejected for now (see Promotion). Reconsider only if ACS needs cross-lane
integration merges that `packages/publication` cannot express; even then the
real push stays ACS-side.

## Required tests

- ACS dispatches a bounded Codex Swarm attempt end to end; ACS independently
  validates and verifies the returned evidence.
- Codex Swarm refuses: an unknown attempt, an expired envelope, a MAC
  mismatch, a stale fencing epoch, a workspace mismatch, a base-SHA mismatch,
  an owner profile outside `permittedOwnerProfiles`, a footprint escape.
- Codex Swarm cannot merge or push to a real remote in ACS mode by any path;
  `git-runner.push` throws.
- ACS approval is required before promotion; a changed workspace tree between
  evidence and promotion is refused; a replayed envelope or evidence is
  idempotent; concurrent promotion is single-flighted.
- Restart mid-attempt: Codex Swarm reports the interruption and does not
  self-resume; ACS records `interrupted`/`unknown`, never inferred success.
- Standalone Codex Swarm still works; ACS-controlled mode cannot silently fall
  back to standalone authority.
