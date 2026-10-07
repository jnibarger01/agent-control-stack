# Authoritative Nimble routing

ACS selects an executor for an approved work item in one place:
`decideAuthoritativeRoute`.

```text
approved work item
  -> hard capability, health, authorization, execution-mode, operator, and capacity filters
  -> Nimble choice over the remaining executors
  -> persisted decision and evidence
  -> execution admission
  -> claim and dispatch of that executor
  -> outcome row bound to the decision id
```

Nimble is the decision-maker for a valid response. `routeActor` only removes ineligible executors and ranks the deterministic fallback. It does not replace a Nimble choice that names an eligible executor.

## Failure policy

| Condition                                                         | Result                                                             |
| ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| No eligible executor                                              | `reject` / `no_eligible_candidate`. Nimble is not called.          |
| One eligible executor                                             | `fallback` / `sole_eligible_candidate`. Nimble is not called.      |
| More than 26 eligible executors                                   | `fallback` / `candidate_set_too_large`. Nimble is not called.      |
| Work item is not approved                                         | `reject` / `not_ready`. Nimble is not called.                      |
| Timeout, connection failure, malformed response, unknown executor | `fallback` via deterministic score. The reason is stored.          |
| Confidence below `ACS_NIMBLE_CONFIDENCE_THRESHOLD`                | `ACS_NIMBLE_LOW_CONFIDENCE_POLICY=fallback` (default) or `reject`. |
| Selected executor becomes ineligible before dispatch              | Append `candidate_invalidated`, then append a new decision.        |
| Decision exists and the executor is still eligible                | Resume that decision. Nimble is not called again.                  |
| Attempt is running without a result                               | `reconcile`. Do not route or claim again.                          |
| Terminal result or terminal status                                | Do not route or execute again.                                     |

## Configuration

Set `ACS_NIMBLE_ROUTING_ENABLED=1` to make this the claim path. Any other value than `0` or `1` fails at gateway construction. An enabled but invalid URL, model, timeout, threshold, or fallback mode also fails at gateway construction.

| Variable                           | Default                               |
| ---------------------------------- | ------------------------------------- |
| `ACS_NIMBLE_URL`                   | `http://127.0.0.1:11434/v1/systemone` |
| `ACS_NIMBLE_MODEL`                 | `nimble:latest`                       |
| `ACS_NIMBLE_TIMEOUT_MS`            | `5000`                                |
| `ACS_NIMBLE_CONFIDENCE_THRESHOLD`  | `0.8`                                 |
| `ACS_NIMBLE_LOW_CONFIDENCE_POLICY` | `fallback`                            |
| `ACS_NIMBLE_FALLBACK_MODE`         | `deterministic_score`                 |
| `ACS_NIMBLE_OPERATOR_DENY`         | empty                                 |

Nimble Choice requires 2–26 criteria. ACS sends one choice question whose criteria names are the eligible executor ids. When routing is enabled, `/readyz` sends that same contract with two readiness criteria and returns 503 if the probe fails. Claims then require the persisted executor id. A worker cannot claim a different executor.

Agents whose provider is `admin-only` are eligible only while the canonical execution mode is `admin`. Claim-time policy still runs after the routing decision and can block dispatch.

Evidence is stored in `actor_routing_evidence`. Execution outcomes are stored in `routing_execution_outcomes`. Neither table stores the raw prompt or secrets. Migration `013` decision rows stay append-only and readable.

## Route decision enrichment (migration 056)

When the caller supplies the mission work unit (`context.workUnit`), the persisted route also carries a structured
execution strategy. It is stored on the same `actor_routing_evidence` row, not in a second table or router.

| Field                                         | Owner                                                                                               |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `executor_class`                              | Derived from the unit kind (`coding`, `shell`, `desktop`, `cua`, `agent`, `swarm`).                 |
| `strategy`, `strategy_source`                 | Chosen from a policy-derived candidate set. `deterministic` unless a model recommendation is valid. |
| `parallelism`                                 | Capped by `routePolicy.maxParallelism`, the eligible executor count and a global cap of 8.          |
| `verification_required`                       | The unit's verification policy is not `none`.                                                       |
| `model_class`, checkpoint/retry               | Taken from `routePolicy`. Never from a model.                                                       |
| `reasons_json`, `deterministic_evidence_json` | Why that strategy, and the facts it was derived from.                                               |

Candidate strategies are decided by hard policy: `single` always; `plan_execute` for coding/agent units;
`maker_verifier` only if verification is required **and** a second eligible executor exists (the verifier must differ
from the maker); `parallel_candidates` only if policy allows 2+ and 2+ executors are eligible; `specialist_delegation`
only if policy allows delegation; `cua_recovery` only for CUA units. `routePolicy.allowedStrategies` narrows the set.
A `StrategyChooser` recommendation outside the set is rejected and recorded as `strategy_recommendation_rejected`; it is
never repaired. No chooser is wired in production yet, so every strategy today is the deterministic default (`single`).
Enrichment never changes which executor is selected, and a resumed route returns the stored enrichment without asking again.
Routes made without a work-unit context persist exactly as before, with NULL strategy fields (meaning "not decided").
Rejected routes carry no enrichment.

## Shadow comparison telemetry

`routing_comparison_v` (read-only) joins, per decision: the incumbent route and its enrichment, the Nimble choice, the
Jev shadow observation (`routing_shadow_observations`), and the latest `routing_execution_outcomes` row. Outcomes may
carry `actual_strategy`, `tool_calls`, `model_tokens` and `cost_micro_usd`; a missing value means not reported, never
zero. `store.listRoutingComparisons()` reads it; `summarizeRoutingComparisons` and `evaluateShadowGates` (actor-router)
compute the ADR 0025 metrics and gates. Gates the data cannot decide (agreement against the incumbent, decision regret,
stability, calibration, counterfactual cost) are `UNPROVEN`, and the verdict is `PROMOTABLE` only if every gate passes,
so with single-choice outcomes it is always `NOT_PROMOTABLE`. The Jev recommendation is never stored in the replayed route.

JEV shadow classification remains telemetry. It is not consulted by this path. `harness/routing.md` is a model cost policy, not this executor router.
