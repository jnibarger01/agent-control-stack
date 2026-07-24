# ADR 0013: Systemd-timer-driven worker invocation, not a long-running daemon

## Status

Accepted

## Context

`apps/worker/src/index.ts`'s `runWorkerOnce` is a single-pass function: it sweeps expired leases (`workItems.failExpiredLeases()`), claims at most one approved work item (`tools.claim_next_approved_work_item`), executes it in the sandbox, submits the result, and closes the database handle in a `finally` block before returning. `apps/worker/src/cli.ts` is four lines — it calls `runWorkerOnce()` once and exits:

```ts
import { runWorkerOnce } from "./index.js";
const result = await runWorkerOnce();
console.log(JSON.stringify(result));
```

There is no loop, no poll interval, and no persistent process. `docs/runbooks/local-dev.md` already documents and names this behavior explicitly, and `docs/runbooks/production.md`'s incident-recovery entry for an expired worker lease already assumes repeated single invocations.

Two properties of the existing implementation make repeated one-shot invocation safe without new code:

1. **Crash-safe lease recovery.** `workItems.failExpiredLeases()` (`packages/work-items/src/store.ts`) runs at the start of every invocation, inside a write transaction, and fails any lease whose `expires_at` has passed, transitioning its work item out of `running` before a new claim is attempted. A worker process that crashes mid-execution simply never runs again until the next scheduled invocation, and that next invocation's `failExpiredLeases()` call reconciles the stale lease. No supervisor-level crash handling is required for correctness.
2. **Idempotent result submission.** `workerResultIdempotencyKey` derives a deterministic key from `{ workItemId, leaseId, workerId, attempt: 1 }`. `SqliteWorkItemStore.getExecutionResultForIdempotency` and the `UNIQUE (worker_id, idempotency_key)` constraint on `attempt_results` (migration 006) mean a duplicate submission for the same lease is rejected rather than double-applied. Repeated invocations — including overlapping ones from a misconfigured scheduler — cannot double-submit a result for work already accepted.

Both properties exist for reasons independent of this ADR (worker-crash recovery, retry safety) but happen to be exactly what a periodic-invocation deployment model needs to be correct, at zero additional implementation cost.

## Decision

Deploy the worker as a systemd timer/service pair that invokes the existing one-shot `apps/worker/dist/cli.js` binary (`npm run start:worker`) on a fixed interval, rather than building a new long-running daemon/poll-loop process.

A representative unit shape:

```ini
# acs-worker.service
[Service]
Type=oneshot
ExecStart=/usr/bin/node /opt/acs/apps/worker/dist/cli.js
Environment=ACS_DB_PATH=/var/lib/acs/control.db

# acs-worker.timer
[Timer]
OnUnitActiveSec=5s
AccuracySec=1s
```

`OnUnitActiveSec` (relative to the previous run's completion, rather than a fixed-wall-clock `OnCalendar`) naturally prevents overlapping invocations without an explicit lock, and backs off automatically if a single claim-and-execute cycle runs long.

This is the default recommendation, not a claim that a daemon process is wrong in general — see Consequences for when to revisit it.

## Consequences

- No new process-supervision code, health-check surface, or in-process connection-pooling logic is needed; systemd already provides restart-on-failure, logging via journald, and start/stop lifecycle management, which a hand-rolled loop would have to reimplement.
- Dispatch latency is bounded by the timer interval (suggested default: 5s), not by an in-process poll. For the current dry-run/early-sandbox production scope, this is acceptable; no user-facing SLA currently requires sub-interval dispatch.
- Each invocation pays SQLite connection open/close overhead. At current expected work-item volume this is negligible; it becomes a real cost only at high throughput.
- Operational model matches what `docs/runbooks/production.md` already documents for incident recovery — this ADR formalizes the existing implicit model rather than introducing a new one.
- Horizontal scaling is "run more timer instances / shorter interval," bounded by the one-claim-per-invocation design and SQLite single-writer characteristics already assumed elsewhere in this codebase.

### What would change this recommendation

Revisit if any of the following becomes a real requirement, not a hypothetical one:

- **Sub-second dispatch latency.** A systemd timer's practical floor is on the order of a few seconds between invocations before process-startup overhead (Node.js boot, SQLite open, migration checksum verification) dominates the cycle. A tighter latency requirement needs an in-process loop or a push-based dispatch signal.
- **In-process connection pooling or shared cache at scale.** If work-item volume grows enough that per-invocation SQLite open/close or repeated migration-checksum verification becomes measurable overhead, a long-running process amortizing that setup cost across many claims becomes worth the added supervision complexity.
- **Multiple concurrent workers needing coordinated fan-out** (not just multiple independent timer instances each claiming one item at a time) — coordinated fan-out is a scheduler-level concern this ADR does not address and would need its own design (Phase 7).

None of these apply to the current scope; the systemd-timer approach is the correct default until one does.

## Rejected alternatives

### Long-running daemon with an internal poll loop

Rejected as the default. It would require building and testing new supervision logic (restart-on-crash, backoff, signal handling, graceful shutdown of an in-flight sandbox execution) that systemd already provides for a oneshot unit, for no latency or throughput benefit at current scope. The crash-safety properties that make this safe (`failExpiredLeases`, idempotent result submission) exist regardless of which supervision model is chosen, so the daemon model buys correctness the existing code doesn't already lack — only latency, which isn't currently required.

### Cron instead of systemd timer

Rejected. `OnUnitActiveSec` scheduling (relative to previous completion) avoids overlapping invocations without an explicit lock file or mutex; cron's fixed wall-clock scheduling would need that complexity added back to guarantee non-overlap, especially if a single execution runs long under sandboxed process limits (ADR 0010).

### No scheduler; manual/on-demand invocation only

Rejected as a production default. Approved work items would sit unclaimed indefinitely between manual runs, which defeats the purpose of an approval-to-execution pipeline. Acceptable for local development only, matching `docs/runbooks/local-dev.md`'s existing workflow.

## Implementation requirements

- Add `acs-worker.service` / `acs-worker.timer` unit files (or an equivalent Compose/orchestrator periodic-job construct for containerized deployments) alongside the gateway's existing production deployment path.
- Document the timer interval and `ACS_DB_PATH` wiring in `docs/runbooks/production.md`, extending the existing expired-lease incident-recovery entry to reference the timer unit by name.
- No changes to `apps/worker/src/index.ts` or `apps/worker/src/cli.ts` are required; this ADR is a deployment-topology decision, not an application-code change.
- If a future change introduces sub-interval dispatch or an in-process loop per the "What would change this recommendation" section, it requires its own ADR superseding this one — do not silently add a loop to `runWorkerOnce`'s caller without documenting the shift.
