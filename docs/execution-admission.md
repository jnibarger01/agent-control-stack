# Execution Admission

Execution admission is an in-process, non-authoritative capacity layer in the ACS gateway. It sits after deterministic preflight, policy, and approval checks but before ACS claims an approved work item.

The authority split is explicit:

- **authorization = ACS**
- **capacity/timing = execution admission scheduler**
- **execution authority = ACS lease + capability**

Admission never approves work, changes risk, modifies plans, grants capabilities, changes execution results, or replaces ACS lease/fencing semantics. Jev remains advisory-only and LoopTrace remains evidence/replay-only.

## Request ordering

Before this change, the governed JC/DC issuance path could claim work and create a lease as soon as policy and approval allowed it:

```text
preflight -> policy/approval -> claim -> attempt/lease -> capability -> executor -> result
```

The path is now:

```text
preflight -> policy/approval -> admission.acquire()
          -> claim -> attempt/lease -> capability -> executor -> result
          -> admission permit release
```

The critical invariant is that `claim_approved_work_item_by_id()` is never called before a permit is granted. A queued RPC therefore has no attempt, lease, capability, or durable execution commitment. Queue delay cannot consume lease lifetime.

## Configuration

All admission limits are positive integers. An explicitly configured zero, negative, fractional, malformed, or non-finite value fails gateway startup instead of silently falling back.

| Variable                         | Default | Meaning                                               |
| -------------------------------- | ------: | ----------------------------------------------------- |
| `ACS_EXECUTION_MAX_INFLIGHT`     |       4 | Normal execution permits across independent executors |
| `ACS_EXECUTOR_MAX_INFLIGHT`      |       1 | Normal permits for one downstream executor            |
| `ACS_EXECUTION_QUEUE_MAX`        |      32 | Maximum queued admission requests across classes      |
| `ACS_EXECUTION_QUEUE_TIMEOUT_MS` |   30000 | Maximum scheduler wait                                |
| `ACS_WAIT_MAX_INFLIGHT`          |       1 | Isolated long-wait/poll capacity                      |

A full queue returns structured `queue_full` backpressure. An expired queue deadline returns `executor_busy` with `retry_after_ms`. Disconnects abort and remove queued entries.

## Fairness and executor isolation

The scheduler maintains FIFO ordering inside a stable source group and round-robins among groups. Gateway groups use the authenticated actor plus client ID; lane is also part of the scheduler group key. This prevents one actor/session from monopolizing a downstream executor while remaining deterministic.

Capacity checks are executor-aware. JC and DC can run concurrently when they target independent executors and global capacity permits. The scheduler does not serialize the whole gateway.

## WAIT class

Admission classification is derived from the canonical JC and DC governed-tool manifests. Known blocking/polling `read_process_output` calls use the `wait` class. Governed tools not explicitly classified as WAIT, and unknown names reaching the classifier, deterministically default to normal `execution`.

WAIT capacity is isolated from normal capacity. A long `read_process_output` therefore cannot consume the normal JC/DC execution slot needed by `get_runtime_identity`, file reads, process starts, or other normal operations. Classification changes capacity only; it creates no policy or authorization authority.

## Permit lifetime and ACS leases

A successful admission permit is held for the real governed execution lifetime, not merely the capability-signing HTTP request. After claim and successful capability issuance, the gateway binds the permit to the exact ACS attempt, work item, lease, worker, and fencing epoch.

The permit is released when the authenticated terminal result callback matches that binding. Claim failure, authorization failure, capability issuance failure, evidence failure, and other pre-execution errors release immediately through `finally` paths. Release is idempotent.

ACS leases remain the sole execution authority. Admission permits cannot execute anything and are intentionally ephemeral. `countActiveAttemptLeases()` is never used as a semaphore because a count-then-claim design would race. It is used only for reconciliation diagnostics.

If bound permit accounting materially diverges from active lease state, ACS emits `scheduler_runtime_reconciliation_required`. The signal does not cancel or create leases, mutate attempts, change policy, alter capacity, or block control traffic.

## Crash and shutdown semantics

The queue is memory-only. If ACS crashes, queued requests fail and clients may retry; there is no durable queue replay.

Gateway shutdown reuses the existing `ShutdownController`. Beginning shutdown synchronously stops new admissions and rejects queued requests before they can claim. Already admitted attempts keep their permits and follow the existing ACS lease-drain behavior. Final process close defensively releases local permit objects; it does not change ACS authority state.

## Readiness and control fast path

Execution saturation and control-plane readiness are separate states. `/readyz` exposes a cheap execution snapshot but remains ready solely because execution capacity is saturated. `/healthz` is a liveness fast path.

No execution admission permit is required for readiness/liveness, authentication, result callbacks, lease/result completion, cancellation, metrics, audit reads, or admission-state reads. Admission status is available at authenticated `GET /internal/execution-admission`.

## Telemetry

The gateway exports bounded-cardinality admission metrics:

- `acs_admission_active`
- `acs_admission_queue_depth`
- `acs_admission_wait_ms`
- `acs_admission_service_ms`
- `acs_admission_rejected_total`
- `acs_admission_cancelled_total`
- `acs_executor_inflight`
- `scheduler_runtime_reconciliation_required`

Labels are limited to bounded dimensions such as lane, execution class, and rejection reason. Request IDs, actor IDs, and arbitrary executor IDs are not metric labels.

For operational troubleshooting, first inspect `/internal/execution-admission` for saturation, queue depth, oldest queue age, and p95 wait/service latency. Then compare active admission permits with ACS lease telemetry. A reconciliation diagnostic means operators should inspect runtime/lease state; the scheduler never repairs authorization state automatically.

## Backpressure interpretation

`READY + SATURATED` means the control plane is healthy and clients should honor structured execution backpressure. `NOT_READY` means a control-plane dependency failed its readiness contract. Do not turn scheduler saturation into readiness failure or retry amplification.

The scheduler does not persist queued calls, predict cost, use historical runtimes, use Jev, adapt concurrency, or coordinate through Redis/distributed locks.
