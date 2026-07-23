# Protocol Specification: Worker Results

ACS Wave 2 models a complete worker lifecycle without running a real command. The worker claims an approved item, receives an opaque lease, performs a dry-run simulation, and submits one immutable result.

## Endpoint

`POST /work-items/:id/results`

Authentication is required. The configured credential must resolve to the `agent` role and a bound worker ID. The request body worker ID must equal that binding. Anonymous, malformed, non-worker, and wrong-worker requests fail closed before protected result lookup.

## Canonical request

```json
{
  "workItemId": "wrk_...",
  "leaseId": "lease_...",
  "workerId": "worker_local_1",
  "actionHash": "<64 lowercase hex characters>",
  "idempotencyKey": "attempt-1",
  "outcome": "succeeded",
  "startedAt": "2026-07-20T18:00:00.000Z",
  "finishedAt": "2026-07-20T18:00:00.010Z",
  "exitCode": 0,
  "summary": "dry-run simulation completed; no real command ran",
  "stdout": "",
  "stderr": "",
  "structuredOutput": { "simulated": true },
  "artifacts": [],
  "simulationMetadata": { "executionMode": "dry_run", "simulated": true }
}
```

The schema is strict. Identifiers and idempotency keys are bounded; timestamps must parse and finish no earlier than start; stdout/stderr, structured output, errors, resource usage, and artifacts are capped. Secret-like structured keys, credentials, raw environment variables, and unrestricted path metadata are rejected. Simulation metadata must explicitly state `dry_run` and `simulated: true`.

Worker-submittable outcomes are `succeeded`, `failed`, `cancelled`, and `worker_infrastructure_failure`. `blocked` and `lease_expired` are ACS-derived outcomes and cannot be submitted through the public route.

## Acceptance transaction

One `BEGIN IMMEDIATE` transaction:

1. Loads the running work item and active lease.
2. Verifies lease/item/worker/action-hash binding and expiry.
3. Resolves the durable `(workerId, idempotencyKey)` record.
4. Returns the original result for an exact replay or rejects a conflict.
5. Inserts the immutable execution result.
6. Transitions the work item to the outcome-derived terminal state.
7. Consumes the lease and clears its legacy token material from the work item.
8. Appends `execution_result.accepted` and the terminal work-item event.

Any failure rolls back result, state, lease, and audit writes together.

## Responses

| Case                                              | HTTP                              |
| ------------------------------------------------- | --------------------------------- |
| First accepted result                             | `201`                             |
| Exact idempotent replay                           | `200` with the original result ID |
| Malformed or oversized request                    | `400`/`413`                       |
| Missing or invalid authentication                 | `401`                             |
| Wrong role, worker, lease binding, or action hash | `403`                             |
| Expired lease                                     | `410`                             |
| Conflicting result or terminal-state submission   | `409`                             |

The response contains the bounded stored result and work-item projection. It does not expose lease token material, raw SQL errors, stack traces, or internal filesystem paths.

## Immutability and retry

Execution results are append-only and unique per work item. A terminal work item cannot be reopened or edited. A retry or clone creates a new work-item ID, fresh execution action hash, and lineage record, then returns to normal policy and approval evaluation. The source item and its result remain unchanged.

This contract proves local ACS lifecycle behavior only. The worker and sandbox remain simulated, and external ChatGPT connector proof is a separate acceptance boundary.
