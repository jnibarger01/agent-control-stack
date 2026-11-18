# ACS AI Factory: architecture and boundaries

## Authoritative topology

```text
 Operator / GitHub issue / project backlog
                  |
          [Factory intake]
      validate + hash + propose
                  |
         [ACS mission runtime]
     policy, identity, admission,
    dependency DAG, budgets, audit
                  |
         [ACS execution controller]
    grant, attempt, lease, fencing,
    workspace, capability, isolation
                  |
      [Codex Swarm ACS child process]
       per-attempt UDS, lane worktrees
       no operator API, no promotion
                  |
          [Untrusted evidence]
                  |
       [ACS result validation]
        + independent verifier
                  |
          [ACS publication]
         exact tree -> draft PR
                  |
      [Mission Control projection]
   stages / review / audit / spend
```

**ACS is the control plane.** Factory is a demand/prioritization layer *inside* ACS. Codex Swarm is an execution backend, not an ACS peer. This follows ADR 0009, 0011, 0014, 0015, 0017 (proposed), 0024, 0028 and 0029 (proposed). Neither a planner nor a model is a principal capable of authorization.

## Reuse, do not duplicate

| Capability | Existing owner | Factory treatment |
|---|---|---|
| Identity, roles, approvals | ACS gateway / policy gate / Jace Auth integration | Requester authentication, NEVER planner-provided |
| Job/mission state and dependency DAG | `packages/coding-mission` | Mapping, no parallel job store |
| Claim, lease, epoch and attempt | ACS execution/work-item services | Reuse canonical fence |
| Budget and admission | ACS mission budgets / execution-admission | Translate requested bounds to stricter admitted limits |
| Worktree allocation | ACS workspace-manager | ACS owns candidate root |
| Tools and command execution | ACS controller / sandbox / Jace Commander | Execution via approved envelope only |
| Internal parallel work | Codex Swarm | Lane decomposition under maxLanes; no cross-attempt scheduling authority |
| Validation and independent QA | ACS result-validation / verification | Recheck actual repo and receipts |
| Outcome verdicts | ACS outcome-engine | Evidence and reporting, not authorization |
| Audit | ACS work-items audit chain | Single canonical store |
| PR publish | ACS publication | Draft PR with fresh exact-tree check |
| Backlog and visibility | Mission Control | Read-only projection + authenticated actions to ACS |

## Control/data planes

- **Demand plane:** strictly parsed untrusted factory intent and deterministic proposal. It cannot carry work-item IDs, leases, tokens, operator identity, or approval grants.
- **Control plane:** ACS authenticates caller, evaluates policy and budgets, creates durable mission/units, grants bounded authorization, dispatches/interrupts and accepts evidence.
- **Execution plane:** per-attempt subordinate Codex Swarm process. It may internally coordinate *within* an attempt and may only narrow the task. No independent root push, merge, user approval or cross-attempt recovery.
- **Evidence plane:** objective, candidate commit/tree, lane footprints, validation results, model spend, snapshot and audit provenance, independent verifier receipts.
- **Presentation plane:** Mission Control never reads Swarm local DB as authority and never derives success from model claims.

## Intended data flow

1. `parseFactoryIntent` checks closed schema, relative path scope and finite budgets.
2. `createFactoryProposal` produces a deterministic digest and a delivery recipe: **draft PR only**. It confers zero rights.
3. *F1–F3 future:* authenticated ACS admission resolves GitHub ref, compares base against repo, checks deny/allow and creates mission/work units bound to the immutable proposal hash.
4. *F4–F6 future:* ACS issues a scoped attempt and calls its Codex Swarm adapter with the ADR 0017 envelope. Per-attempt secret out-of-band, UDS health proves `control_plane=acs` and `operator_api_listening=false`.
5. *F7 future:* Codex Swarm returns execution evidence. ACS revalidates binding, tree scope, checks, hashes, lease and independent verifier findings. Failure is never coerced to success.
6. *F8 future:* ACS publication re-checks candidate SHA and authorized output action before opening a **draft** PR; audit records remote operation idempotently.
7. *F9+ future:* Mission Control exposes the ACS-owned stage and evidence; analytics use correlated receipts.

## Contract trace

| Input/output | Version | Authoritative? | Owner |
|---|---|---|---|
| FactoryIntent | `acs.ai-factory.intent.v1` | No | Factory parser |
| FactoryProposal | `acs.ai-factory.proposal.v1` | No | Factory planner |
| ACS mission / work units | Existing versioned ACS schema | **Yes** | ACS mission runtime |
| Codex Swarm execution envelope | `acs.codex-swarm-envelope.v1` | Scoped, ACS-issued only | ACS execution controller |
| Swarm execution evidence | `acs.codex-swarm-evidence.v1` | **No** | Codex Swarm / ACS verifier |
| Verification/outcome receipt | Existing ACS verifier/outcome contracts | Evidence; no merge authority | ACS |
| Draft PR publication | Existing ACS publication contract | Consequential action, ACS-controlled | ACS |

## Failure handling

- **Planner unavailable:** bounded deterministic rejection or manual review; never grant authority.
- **ACS admission unavailable:** orders are not dispatched; retry only with original idempotency key.
- **Swarm child dies:** ACS fences attempt; reconcilers distinguish never-run, running, unknown and terminal facts. No subordinate autonomous restart.
- **UDS or auth mismatch:** kill child when ownership can be proven; refuse evidence.
- **Budget exhausted:** stop new dispatch, signal owned processes and record overshoot/unknown usage truthfully.
- **Late evidence:** retain rejected-stale trace; cannot modify latest attempt.
- **Git remote changes:** compare candidate/base/target HEAD afresh; record a conflict instead of force-push.
- **Publication uncertain:** reconcile remote PR by idempotency marker and exact head; do not blindly create a second PR.
- **Audit invalid:** block acceptance and publication; invoke incident runbook.

## Parallelism policy

Codex Swarm can fan out independent lanes **only within one ACS attempt**, bounded by ACS budget and allocation. ACS owns all cross-attempt scheduling, retry, cancellation and terminal acceptance. If lanes overlap touched files, the attempt is blocked pending deterministic integration or revision, never silently last-write-wins.

## Implementation guardrails

Avoid a new `factory_jobs` table until a documented projection-read bottleneck justifies it; if required, it is a rebuildable non-authority materialized view. Do not add a new gateway mutation in F0. Do not expose manual `approve` or `promote` methods on an ACS-controlled swarm adapter. Do not implement "admin factory mode." Capability checks and approvals remain ACS entry conditions, not UI booleans.

## Deployment topology (target)

Single-host pilot: loopback ACS gateway + SQLite WAL/audit, ACS worker and sandbox, per-attempt Codex Swarm UDS, local workspace and Jace Commander, GitHub connector for draft publication, metrics exporter and backup. Multi-host execution requires a new explicit threat and lease design and is not implied by this PR.

