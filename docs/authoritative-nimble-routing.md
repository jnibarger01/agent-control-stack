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

**Admin execution mode is the one exception to the persisted-executor requirement, and only for by-id claims.** Capability items issued by `/jc/capability/issue` and `/dc/capability/issue` are never routed, so they carry no routing evidence. While the canonical execution mode is `admin` (TTL-aware), a by-id claim skips the routing-evidence check only when all of the following hold:

- the claim carries the admin fence, which the gateway sets only after it authorized the call in admin mode, whether that authorization recorded an ACS admin approval or policy already allowed the action;
- the canonical mode is `admin` at claim time, and managed authority is valid (the gateway re-checks both inside the claim transaction and refuses otherwise);
- policy does not deny the item;
- if policy requires approval, then for the item's current plan every approval-required action holds a granted, unexpired plan approval, and each of those approvals was granted by ACS admin. A historical admin approval on a superseded plan, or an admin approval covering only some required actions, does not count. If policy already allows every action (for example `jc_status` or `jc_doctor`), there is no approval to require and no plan yet (the claim creates it): the fence plus canonical admin mode is the authority, and no approval record is fabricated.

Each override is audited once per work item as `execution_mode.routing_override`. In `strict` mode the routing-evidence requirement applies unchanged to every claim. `claim_next`, durable assignments, registered-agent targets, and attempt fencing are not affected by admin mode.

Evidence is stored in `actor_routing_evidence`. Execution outcomes are stored in `routing_execution_outcomes`. Neither table stores the raw prompt or secrets. Migration `013` decision rows stay append-only and readable.

JEV shadow classification remains telemetry. It is not consulted by this path. `harness/routing.md` is a model cost policy, not this executor router.
