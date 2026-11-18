# Factory metrics, economics and SLOs

Every metric must identify an authoritative ACS source, the measured population, and failure/unknown classifications. **Agent count is not output.**

| Metric | Definition | Source | Concern |
|---|---|---|---|
| Intake volume | Distinct bounded proposal hashes per day | F1 authenticated intake records | Duplicate/replayed demand excluded |
| Admission rate | Admitted distinct missions / valid distinct requests | ACS mission admission | Denied requests not "worker failure" |
| Verified throughput | Distinct missions with fresh independent accepted outcome per interval | ACS verification + mission audit | Never use worker "done" |
| Delivery rate | Draft PRs exactly bound to verified candidate / accepted orders | ACS publication + GitHub reconciliation | Do not count duplicates |
| First-pass yield | Units verified without remediation / verification attempts | ACS attempts and receipts | Stale/partial evidence excluded |
| Cycle time p50/p95 | First authenticated admission -> final reviewed draft PR | ACS event timestamps | Report timeouts/cancellations separately |
| Recovery time p95 | Failure detected -> reconciled canonical terminal state | ACS event history | Unknown effect is unresolved |
| Scope escape | Verified forbidden write attempts / admitted attempts | Sandbox audit | Should remain zero accepted escapes |
| Audit join completeness | Runs with every required correlation edge / runs | ACS canonical event chain | Missing edge = incomplete |
| Cost per verified output | Actual recorded total spend / fresh verified delivered PRs | ACS budget receipts | Unreported spend = unknown, not zero |
| Human touch count | Explicit approval/review steps per delivered PR | ACS operator audit | Fewer is useful only with safety maintained |

## Targets at F11 pilot

- 100% of negative authority, isolation, lease and PR publication tests **deny**.
- Zero unauthorized publication and zero double publication on replay.
- ≥99% end-to-end trace correlation coverage, with missing rows surfaced.
- ≥95% of eligible jobs get a correctly classified terminal or operator-actionable blocked outcome within their specified budget (target, not evidence).
- 100% of required verification criteria supported by trustworthy artifacts before "verified".
- No misleading $0 cost recorded for an attempt with unknown capped usage.

## Dashboard facets

Filter by project/repository, mission, accepted order hash, source commit, worker/engine, failure category, control plane authority state, cost and elapsed time. Preserve separate stages: proposed, policy blocked, admitted, dispatched, candidate returned, independently verified, publication pending, draft PR delivered, unknown external effect.

## Counterfactual evaluation

Compare a pinned baseline of one manually orchestrated ACS coding mission against the factory workflow on matched issue classes and target repos. Record total engineer review minutes, regressions found, rework attempts, elapsed time and actual billed spend; do not infer ROI from speculative token prices.

## Accounting

Budget estimates are admission inputs, not actual bills. Costs from opaque providers must be reported as unaccounted until reconciled. Never calculate "cost per successful PR" using a denominator that includes unverified, duplicate or merely opened PRs.

