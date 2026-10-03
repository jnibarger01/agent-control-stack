# Semantic Agent Routing

## Authority boundary

ACS remains authoritative for approval, policy, eligibility, routing persistence,
worker identity, assignment, claim, leases, and execution attempts. Nimble answers
only whether one already-eligible agent is semantically appropriate for an
approved work item. Nimble cannot select a worker, create an assignment, claim,
or execute work. JEV intake, trace, and shadow observation remain independent
and are not consulted by this routing path.

## Dispatch sequence

An operator or service credential with `acs:write` calls
`POST /routing/dispatch` with `{ "workItemId": "..." }`. The route accepts only
approved, unassigned work items. ACS evaluates candidate eligibility first,
including registry status and heartbeat freshness, requested action
capabilities, policy for the candidate's mapped worker, and worker credential
availability. Only the remaining candidates are sent to Nimble, one at a time.

The local TypeSafe request uses `POST /v1/systemone`, model `nimble:latest`,
and a Noul question named `appropriate`. Noul is P(yes). A score at or above
the configured threshold is a semantic match. The default threshold is `0.80`;
comparison uses the returned value without rounding. If several candidates
match, actor-router applies ACS's deterministic fit score and stable agent ID
tie-break. Nimble never ranks the candidate set.

ACS persists the routing decision, resolves the selected agent through the
explicit agent-to-worker binding, and records the assignment with the
authorized dispatcher actor. `POST /worker/claim` then accepts only approved
items assigned to the authenticated worker. Claim-time policy and approval
checks still run, and ACS atomically creates the lease and execution attempt.
An item with no semantic match, a degraded Nimble result, or no dispatchable
worker path remains approved and unassigned so a later dispatch can retry it.

## Configuration

| Setting                         | Default                               | Purpose                                                   |
| ------------------------------- | ------------------------------------- | --------------------------------------------------------- |
| `ACS_NIMBLE_URL`                | `http://127.0.0.1:11434/v1/systemone` | Noul endpoint; redirects and URL credentials are rejected |
| `ACS_NIMBLE_MODEL`              | `nimble:latest`                       | Nimble model identifier                                   |
| `ACS_NIMBLE_ROUTING_THRESHOLD`  | `0.80`                                | Exact semantic match threshold in `[0, 1]`                |
| `ACS_NIMBLE_ROUTING_TIMEOUT_MS` | `750`                                 | Per-candidate request timeout                             |
| `ACS_AGENT_WORKER_BINDINGS`     | `{}`                                  | JSON map from registered agent IDs to worker IDs          |

The mapped worker must have an active `WorkerIdentityRegistry` identity or an
active static gateway credential with the worker role and `acs:worker` scope.
Agent IDs and worker IDs are separate namespaces; ACS never assumes they are
equal. Do not place credentials or tokens in the binding map.

Nimble receives only the work-item title and intent, requested action kind and
description, modeled target service, and candidate agent ID, role, and
capability names. ACS redacts secret-shaped input before transmission, sends
no authorization headers or environment values, and does not persist the raw
model request or response. Candidate audit events retain bounded score,
threshold, status, latency, model, and fixed failure codes.

## Local Ollama residency

The ACS development host keeps `nimble:latest` warm through the lingering
user-level `acs-nimble-residency.service`. Install or refresh it from the
repository root with
`./scripts/install-acs-nimble-residency.sh`. The user systemd manager must be
enabled at boot (user lingering). The service waits for the local Ollama API,
verifies that `nimble:latest` is already installed, then sends a model-specific
one-token warm-up request with `keep_alive: -1` and confirms the model is
resident. It repeats this check every minute, including after an Ollama restart,
when the server has discarded its in-memory model state. It never pulls models
and does not change Ollama's global keep-alive setting. If another model is
already resident, it preserves that model, logs the contention, and retries on
the next check rather than forcing an eviction.

Check the service with `systemctl --user status acs-nimble-residency.service`
and residency with `ollama ps`; `nimble:latest` should show `Forever`. The
service only manages this model. If the model is removed, it reports an error
instead of downloading it.

On the ACS routing host, a live residency snapshot measured about **9.67 GiB of
VRAM** for Nimble on a GPU reporting **15.92 GiB total** (about 61%). This is a
host- and runtime-specific observation, not a model guarantee. Pinning Nimble
reserves substantial accelerator capacity while Ollama is running; other local
models may fail to load, share the device, or spill layers to system memory.
Keep this tradeoff intentional and remeasure after changing the model, context
size, Ollama version, or GPU. ACS's 750 ms routing timeout depends on Nimble
being warm; cold model loading is outside that request budget.

## Observable routing states

Audit events include `agent.routing.started`,
`agent.routing.candidate_evaluated`, `agent.routing.selected`,
`agent.routing.no_match`, `agent.routing.no_eligible_agents`,
`agent.routing.degraded`, `agent.routing.assignment_failed`, and
`work_item.worker_assigned`. Mission Control shows candidate score and match
status, the selected agent and worker, and subsequent claim and running events
in the work-item timeline. No raw prompt or model payload is displayed.
