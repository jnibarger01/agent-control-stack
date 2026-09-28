# ADR 0020: Native route to persisted engine adapter dispatch contract

## Status

Accepted

## Context

ACS now persists mission routing evidence and has a registry of native engine
adapters. A worker claim is the authority-bearing boundary: it supplies the
current work item, admitted plan, attempt, lease, fencing epoch, and allocated
workspace. The engine adapter is an execution principal, not a second control
plane. Desktop Commander remains a separate, explicitly selected execution
boundary.

The previous integration risk was resolving a persisted route and then losing
that selection before invocation. A native route must therefore be a strict
route -> engine -> claim/dispatch path, with no implicit backend substitution.

## Decision

Use direct invocation through the persisted adapter, coordinated by
`apps/worker`; do not introduce an adapter-authorized coordinator or a second
orchestrator.

1. After the approved item is claimed, the worker loads and verifies the
   persisted mission routing record for the exact work-item ID.
2. The closed routed mission is parsed with the canonical route contract. The
   worker calls `EngineAdapterRegistry.require(route.engineId)` and invokes
   exactly that adapter. Missing or unavailable adapters deny the dispatch.
3. The worker re-reads the current execution plan and active attempt lease and
   verifies the complete binding before constructing `EngineTask`: work item,
   attempt, lease, worker identity, fencing epoch, plan hash, input hash,
   policy version, and attempt-scoped workspace allocation must match.
4. The worker constructs the prompt and all execution limits from persisted ACS
   state. No route, engine ID, prompt, workspace path, credential, or backend
   choice supplied by an engine or external caller is trusted.
5. `EngineAdapter.invoke` is the only engine execution port. Each concrete
   adapter must launch through `EngineIsolation` (ADR 0014), including its
   private workspace boundary, clean environment, single named credential,
   provider-specific scoped egress, bounded output, timeout, cancellation, and
   process-tree cleanup. Direct host subprocesses and legacy engine helpers are
   forbidden.
6. The adapter returns an untrusted `EngineOutcome`. ACS validates the outcome,
   maps it to the worker result, applies the configured result validator, and
   submits the result through the work-item store with the same attempt, lease,
   action hash, plan hash, input hash, fencing epoch, and idempotency key.
   Result persistence failure is not success.

### Execution modes and result mapping

`native_engine` is a truthful live execution mode. It is never represented as
`dry_run` or `desktop_commander`.

| Engine outcome | ACS terminal outcome | Success |
| --- | --- | --- |
| `completed`, exit code `0` | `succeeded` | yes, subject to validation |
| `completed`, non-zero exit code | `failed` | no |
| `timeout` | `failed` | no |
| `cancelled` | `cancelled` | no |
| `process_error` | `failed` | no |

Captured stdout/stderr are observations, not proof of authorization or
completion. They remain bounded and redacted by the adapter/isolation
contract. A failed ACS result validation produces `failed`, never a successful
or downgraded result.

### Approval, lease, workspace, and fence bindings

Approval is established by the existing claim-time policy and exact action/plan
approval checks. Native dispatch does not create, infer, or consume a separate
engine approval. The invocation authorization is the admitted plan and current
claim; the `EngineTask.authorization` field carries the plan hash binding.

The worker must reject dispatch if any of these are absent, stale, mismatched,
expired, revoked, or unverifiable:

- work-item ID and admitted plan ID/hash;
- action hash and attempt input hash;
- attempt ID and active lease ID;
- lease owner/worker ID and fencing epoch;
- policy version used for the claim;
- workspace allocation ID, work-item/attempt/lease owner, fencing epoch, and
  canonical host path.

The store remains the sole authority for lifecycle mutation. A stale worker
cannot persist a native result, advance lifecycle, consume approval, or tear
  down a newer owner's workspace.

### Screening, validation, and audit

Before invocation, route parsing, registry lookup, plan/lease/workspace
binding checks, and isolation preflight fail closed. During invocation, the
adapter validates the strict `EngineTask` and isolation validates the authority
record, credential, egress, limits, and workspace. After invocation, ACS
validates the strict `EngineOutcome`, runs the configured worker validator,
redacts/bounds captured output, and persists only the canonical result fields.

The canonical SQLite audit chain records, at minimum:

- `execution.authorization_denied` for route, registry, authority, or
  preflight denial, with stable failure code and route engine ID when known;
- `execution.authorization_granted` after all preconditions pass, with route
  ID, engine ID, plan/attempt correlation, and `native_engine` mode;
- `execution.started` with route ID, engine ID, attempt and correlation;
- `execution.result_persisted` with the adapter invocation hash and result
  hash; and
- `execution.completed` with the terminal success/failure decision and result
  hash.

Audit bodies and attributes never contain credentials or unrestricted engine
output. Adapter/isolation telemetry is subordinate to the SQLite audit chain.

### Desktop Commander boundary and forbidden fallback

`desktop_commander` remains a distinct backend and continues through
`packages/desktop-commander-adapter` and its ACS authorization, tool policy,
argument validation, containment, approval, audit, and result-screening path.
A native route never switches to Desktop Commander, dry-run, a generic engine,
or direct host execution. An item without native routing evidence may retain the
pre-routing compatibility path; a persisted native route that cannot be
verified or resolved is blocked.

## Acceptance criteria for `backend-api`

1. Native dispatch loads verified persisted routing for the claimed work-item
   and calls `registry.require(route.engineId)`; a missing adapter produces a
   blocked/denied result and no invocation.
2. Exactly the adapter returned by `require` receives one strict
   authority-bound `EngineTask`; tests prove the task includes plan, attempt,
   lease, worker, fence, workspace, policy, and idempotency bindings.
3. Native dispatch cannot fall back to `dry_run`, `desktop_commander`, another
   engine ID, an unsandboxed subprocess, or caller-provided workspace/prompt.
4. Every authority mismatch, isolation preflight failure, malformed outcome,
   timeout, cancellation, non-zero exit, or validation failure is non-success
   and is represented by a stable denial/failure code or truthful terminal
   outcome.
5. Result submission is fenced by the same persisted lease/epoch/hash bindings
   and is atomic with the canonical work-item transition and audit event; a
   persistence error is surfaced as failure.
6. Native results use `executionMode: "native_engine"` and the mapping table
   above. Tests assert that no native completion is reported as dry-run or
   Desktop Commander.
7. Audit tests cover denied route/registry lookup, granted/start, persisted
   result, completion, adapter invocation hash, and result hash without secrets.
8. Existing Desktop Commander containment/authorization tests remain green and
   its implementation is not routed through the native adapter path.

## Rejected alternatives

### Adapter-authorized coordinator

Rejected. It would duplicate ACS authorization and lifecycle authority and
would make it unclear whether the adapter or ACS owns the claim/lease boundary.
The worker is a thin coordinator; the adapter only translates and executes the
already-authorized task.

### Generic engine selection after routing

Rejected. Re-selecting by environment or capability after reading a persisted
route breaks deterministic routing and permits an unintended engine to execute.

### Fallback to dry-run, Desktop Commander, or direct host execution

Rejected. A missing or unusable native capability is a denial, not permission
to change execution semantics. Silent fallback would make results and audit
records untruthful and weaken the execution boundary.
