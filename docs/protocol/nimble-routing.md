# Nimble authoritative routing

## Authority

With `ACS_NIMBLE_ROUTING_ENABLED=1`, Nimble selects the semantic winner only
after ACS has evaluated every registered agent against deterministic
eligibility rules. ACS owns approval, policy, worker identity, admission,
attempts, leases, execution, result acceptance, and audit. Nimble receives
bounded descriptive context and returns a Noul `P(yes)` score; it receives no
work-item ID, action parameters, environment, credentials, or approval data.

Only `AVAILABLE` agents with a fresh heartbeat, all requested capabilities,
capacity, an active mapped worker identity, an allowing claim-policy result,
and a compatible registered-agent target are sent to Nimble. Ineligible agents
are excluded before any model request. All eligible candidates are scored
within the configured concurrency limit. The highest score at or above the
threshold wins; equal scores within `1e-9` use ascending agent ID. The default
threshold is `0.80`, preserving the existing Noul routing boundary. This is a
compatibility threshold, not a claim of broad statistical calibration.

Every eligible candidate must return a valid response from the configured
model. Timeout, unavailable runtime, malformed response, model mismatch, or
oversized request fails the whole route closed; ACS does not fall back to the
legacy heuristic or assign a partial result. The default client is the local
loopback endpoint `http://127.0.0.1:11434/v1/systemone`; only loopback HTTP(S)
URLs are accepted.

## Dispatch and claim

An authorized operator or service calls `POST /routing/dispatch` with
`{"workItemId":"..."}`. The item must already be approved. Successful
selection, the compatibility routing decision, immutable worker assignment,
and exact Nimble evidence are persisted in one SQLite transaction. The
assignment is insert-only and keyed to routing generation 1. Repeated dispatch
returns the durable assignment without another inference call.

The selected worker calls `POST /worker/claim` using its authenticated worker
credential. The request accepts only an optional `leaseMs`; worker ID comes
from authentication. ACS finds an approved assignment for that worker and
passes the exact work-item ID and authenticated identity through the existing
claim policy gate, admission, approval binding, attempt creation, and lease
fencing. A caller cannot claim an unassigned item or an item assigned to a
different worker. When Nimble mode is enabled, the legacy unassigned
`claim_next_approved_work_item` path is closed.

The in-repository one-shot worker also honors `ACS_NIMBLE_ROUTING_ENABLED=1`:
it looks up an approved assignment for its configured worker ID and claims that
work item by ID. It returns without claiming when no matching assignment
exists.

Routing evidence is append-only and includes candidate scores, hard-eligibility
reasons, model ID/version, threshold, exact selected score, algorithm version,
correlation ID, and evaluation time. No request content outside the bounded
descriptive state is persisted in the Nimble evidence record.

## Configuration

| Variable                                       | Default                               | Bound                                                  |
| ---------------------------------------------- | ------------------------------------- | ------------------------------------------------------ |
| `ACS_NIMBLE_ROUTING_ENABLED`                   | disabled                              | Must be `1` to activate authoritative routing          |
| `ACS_NIMBLE_URL`                               | `http://127.0.0.1:11434/v1/systemone` | Loopback HTTP(S) only                                  |
| `ACS_NIMBLE_MODEL`                             | `nimble:latest`                       | Non-empty, at most 128 characters                      |
| `ACS_NIMBLE_MODEL_VERSION`                     | model ID                              | Non-empty, at most 128 characters                      |
| `ACS_NIMBLE_ROUTING_THRESHOLD`                 | `0.80`                                | Number from 0 through 1                                |
| `ACS_NIMBLE_ROUTING_TIMEOUT_MS`                | `1200`                                | 1–30,000 milliseconds                                  |
| `ACS_NIMBLE_ROUTING_MAX_CANDIDATES`            | `8`                                   | 1–32 candidates                                        |
| `ACS_NIMBLE_ROUTING_CONCURRENCY`               | `4`                                   | 1–8 simultaneous evaluations                           |
| `ACS_NIMBLE_MAX_ACTIVE_ASSIGNMENTS_PER_WORKER` | `1`                                   | 1–32 active assignments                                |
| `ACS_AGENT_WORKER_BINDINGS`                    | empty                                 | JSON object mapping registered agent IDs to worker IDs |

Jev remains an independent advisory observation path. Its enabled state,
availability, and output do not affect eligibility, selection, assignment, or
claim. Nimble routing does not consume Jev evidence.

## Failure behavior

No eligible candidate, candidate-limit overflow, score below threshold,
runtime failure, malformed output, or changed eligibility creates no
assignment. Routing outcomes are recorded as audit events with stable failure
categories. Routing being disabled does not affect gateway readiness; dispatch
returns `503` with `ROUTING_DISABLED` until explicitly enabled.
