# ADR 0025: Routing ownership and staged, bounded Jev influence

## Status

Accepted. Supersedes the routing, executor-selection and model-selection clauses of
[ADR 0020](0020-jev-advisory-only-evidence.md). Every other ADR 0020 clause (approvals, capability
issuance, policy, verification, promotion, lifecycle) is unchanged and still binds.

## Context

ACS is growing from "route one approved work item to one executor" into a mission control plane that
chooses an execution _strategy_ (executor class, strategy, model class, parallelism, verification
requirement) per work unit. Two learned components are candidates to help:

- **Nimble** is already the authoritative learned router (`decideAuthoritativeRoute`,
  [authoritative-nimble-routing.md](../authoritative-nimble-routing.md)). It chooses among executors that
  already passed hard eligibility, and its decision is persisted append-only
  (`actor_routing_decisions` + `actor_routing_evidence`, migration 050).
- **Jev** is a probabilistic engine that ADR 0020 pins to advisory telemetry. ADR 0020 forbids it from
  influencing routing, executor selection or model selection, and enforces that with an ESLint
  import boundary and `tests/jev-boundary.test.ts`.

The planned mission runtime needs a defined path by which Jev evidence _could_ become one bounded input
to a route decision, without ever becoming an authority. ADR 0020 as written has no such path, and
silently loosening the lint rule would be exactly the "advisory model quietly becomes a gate" failure
it exists to prevent. This ADR defines the path, the gates, and the boundary, and turns on only the
first stage.

## Decision

### Ownership

| Layer                        | Owns                                                                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **ACS**                      | Final route decision, admissibility, permissions, grants, budgets, route persistence, execution state, verification policy, promotion.                                    |
| **Deterministic ACS policy** | Hard constraints, executor eligibility, capability requirements, security boundaries, mission policy, tool permission checks. Always outranks any model output.           |
| **Nimble**                   | The learned authoritative choice _inside_ the candidate set that deterministic policy produced. Its scope may widen from "which executor" to "which structured strategy". |
| **Jev**                      | An optional probabilistic _input_ to an ACS-owned decision, staged below. It never selects, admits, claims, executes, retries, verifies or promotes anything by itself.   |

A model recommendation (Nimble or Jev) that names anything outside the deterministic candidate set is
invalid and is handled with the existing `candidate_invalidated` / fallback semantics. A persisted
route is replayed on resume; it is never silently re-derived from a later model call.

### Jev stages

```
shadow  ->  advisory  ->  bounded influence        (never: Jev output -> execution authority)
```

Each stage is a separate, explicit, auditable change. Advancing a stage requires the promotion gates
below to pass on measured data **and** an amendment to this ADR that names the stage, the exact
decision field Jev may influence, and the bound on that influence. Code may not enable a later stage
because an environment variable is set.

1. **Shadow (enabled by this ADR).** Jev receives the same eligible decision context that Nimble
   received, after the authoritative decision is persisted. It runs off the decision path (not awaited,
   bounded by a timeout, failure-isolated). Its recommendation is persisted in its own append-only
   table, `routing_shadow_observations` (migration 053), keyed by `decision_id`, together with the
   authoritative executor, whether they agree, and a status. The route, admission, claim and outcome
   rows are byte-for-byte what they would have been without Jev. The eventual outcome is the existing
   `routing_execution_outcomes` row, joined on `decision_id`; it is not copied.
2. **Advisory (not enabled).** Jev evidence may be shown to operators and to the reconciliation step
   as context. Still no effect on the persisted decision. Requires a migration that widens the `mode`
   constraint and an amendment to this ADR.
3. **Bounded influence (not enabled).** Jev may break a tie or adjust a score _within_ the
   deterministic candidate set and only for fields this ADR names. Hard policy is evaluated first and
   last: before Jev (candidate set) and after Jev (reconciliation re-validates the choice against the
   same hard constraints). Requires a migration and an amendment.

### Shadow-mode rules (binding now)

- Jev runs only when `ACS_JEV_ENABLED=1`; otherwise inert (no network call, no row).
- The observation is recorded **after** the authoritative decision is persisted and **only** for fresh
  or replacement decisions that routed or fell back with two or more candidates. Replays, rejects and
  sole-candidate decisions are not shadowed, so a resume never re-queries Jev.
- The observer cannot throw into, delay, or alter the decision: it is not awaited, errors are
  swallowed into a recorded `error` status, and a timeout is recorded as `timeout`.
- A recommendation outside the candidate set is recorded as `invalid_recommendation` and counted
  against Jev; it is never "repaired" to the nearest candidate.
- Degraded, disabled, incompatible-model, malformed or tied outputs are recorded as
  `degraded` / `no_recommendation`. Nothing is fabricated, and no heuristic fallback is used.
- The `mode` column is constrained to `'shadow'` in migration 053, so a later stage cannot be written
  without a schema change that review sees.
- A differential test (`packages/policy-gate/src/route-shadow.test.ts`) asserts the persisted decision
  and evidence are identical with Jev absent, agreeing, disagreeing, invalid, throwing, hanging and
  degraded.

### Promotion gates

Gates compare Jev against the **actual incumbent** (Nimble inside the policy envelope, with its
deterministic fallback), measured from `routing_shadow_observations` joined to
`routing_execution_outcomes` over the same decisions. "Better than random" is explicitly not a gate.
A gate is evaluated on a window of at least the minimum sample below; below it the gate is `UNPROVEN`,
not passed.

| Gate                          | Definition                                                                                                           | Required to leave shadow                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Valid-output rate             | `recommended / (all observations)` excluding disabled                                                                | >= 0.99                                                                        |
| Invalid-recommendation rate   | `invalid_recommendation / (recommended + invalid_recommendation)`                                                    | <= 0.005                                                                       |
| Policy violations             | Recommendations that name an executor excluded by hard policy                                                        | 0 (any is a hard fail, not a rate)                                             |
| Agreement vs trusted outcomes | On decisions with a verified outcome, share where Jev's recommendation matches an executor that succeeded + verified | Greater than the incumbent's own success rate on the same decisions, by margin |
| Decision regret               | Mean `(best observed success among candidates) - (success of the recommended executor)`                              | <= incumbent regret                                                            |
| Stability                     | Same inputs re-asked yield the same recommendation                                                                   | >= 0.95                                                                        |
| Confidence calibration        | Expected calibration error of Jev confidence vs observed success                                                     | <= 0.10, and no worse than Nimble's                                            |
| Cost impact                   | Mean cost of the recommended executor vs the incumbent's choice                                                      | Not materially worse (<= +5%) where cost is known                              |
| Latency                       | p95 Jev recommendation latency, and zero added decision-path latency while shadow                                    | p95 within the routing latency budget                                          |
| Minimum sample                | Decisions with a joined, verified outcome                                                                            | >= 500 and >= 30 per executor class compared                                   |

Thresholds are initial values chosen before any data exists. They must be re-baselined against measured
incumbent performance before the first promotion decision and the re-baseline recorded in the
amendment that promotes the stage. If the incumbent is stronger on any gate, Jev stays at its current
stage. Missing accounting (cost, tokens) is reported as unknown and excluded, never counted as zero.

### Boundary change

ADR 0020's lint rule stays in force: `@agent-control-stack/jev-advisor` may be imported only by the
adapter package, `packages/policy-gate/src/jev-shadow.ts` and
`packages/evidence/src/observation-worker.ts`. This ADR adds, and does not widen:

- `actor-router` defines a plain-data **route shadow port** (`route-shadow.ts`). It imports nothing from
  Jev, and the port's return value is never read by the decision. The type shape carries no field that
  `decideAuthoritativeRoute` consumes.
- The Jev-backed observer (`createJevRouteShadowObserver`) lives in the allow-listed `jev-shadow.ts` and
  is exposed through the policy-gate barrel.
- The barrel name is added to the restricted `importNames`, and may be imported only by the two
  composition roots that already call `claimNextAuthoritativeWorkItem`
  (`apps/worker/src/index.ts`, `apps/gateway/src/tools/execute-approved.ts`). Policy, classification,
  routing, admission and store code remain forbidden from touching it.
- `tests/jev-boundary.test.ts` gains cases proving the new name is refused in authority code and in the
  router package, and permitted only in those two roots.

Widening any of these lists requires amending this ADR.

## Consequences

- Jev can accumulate evidence against real routing outcomes with provably zero effect on execution.
- Advancing Jev's stage is a reviewed, schema-visible, ADR-amended change gated on measurements, not a
  flag flip.
- One new append-only table and one new ESLint allow-list entry pair. No change to
  `actor_routing_decisions`, `actor_routing_evidence`, admission, claim, lease or fencing.
- ACS routing stays a single pipeline. A future `RouteDecision` enrichment (strategy, model class,
  parallelism, verification requirement) extends `actor_routing_evidence`, not a second router.

## Rejected alternatives

- **Flip ADR 0020 to "Jev may influence routing".** Rejected: no measured basis, and it removes the
  guard before the guarded behaviour has been observed.
- **Let Jev choose the executor and have policy veto afterwards.** Rejected: a veto-only policy cannot
  express "least privilege first" and makes the model the first mover on an authority decision.
- **Persist the Jev recommendation inside `actor_routing_evidence.normalized_decision_json`.**
  Rejected: that table is the replayed source of truth for a resumed decision, so any Jev field there
  could leak into a replay. A separate append-only table keeps replay inputs Jev-free.
- **Await Jev on the decision path with a short timeout.** Rejected: it adds up to the Jev timeout to
  every route and couples route latency to an advisory dependency.
- **A second `RouteDirector` datastore.** Rejected: duplicates `decideAuthoritativeRoute` and its
  persistence.
- **Promote when agreement merely exceeds chance.** Rejected: the comparison class is the incumbent.

## Enforcement

- ESLint boundary and `tests/jev-boundary.test.ts`, as above.
- `packages/policy-gate/src/route-shadow.test.ts`: differential non-interference test, plus the
  append-only table, mode constraint, agreement computation and one-observation-per-decision checks.
- Migration 053 and the migration registry in `packages/shared/src/migration.ts`.
