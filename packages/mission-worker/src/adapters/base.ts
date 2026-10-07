import { randomUUID } from "node:crypto";
import { ControlStackError, stableHash } from "@agent-control-stack/shared";
import type {
  ActionRecord,
  CancellationReason,
  ExecutionHandle,
  ExecutionObservation,
  ExecutionReport,
  ExecutionState,
  PrepareContext,
  PreparedExecution,
  ResourceTouch
} from "../contract.js";

/** What a wrapped adapter produced, before it is expressed as a contract report. */
export interface Settled {
  outcome: ExecutionReport["outcome"];
  result?: ExecutionReport["result"];
  failure?: ExecutionReport["failure"];
  receipts?: ExecutionReport["receipts"];
  actions?: ActionRecord[];
  resources?: ResourceTouch[];
  selfAssessment?: ExecutionReport["selfAssessment"];
  externalStateUncertain: boolean;
  state: ExecutionState;
}

export interface Tracked<P> {
  prepared: PreparedExecution;
  detail: P;
  handle: ExecutionHandle;
  controller: AbortController;
  settled?: Settled;
  done: Promise<Settled>;
  cancelRequested?: CancellationReason;
}

/**
 * In-process table of the executions one wrapper has started. It is bookkeeping only: nothing here is authority.
 * A handle the wrapper did not issue is refused, so a forged handle cannot observe, cancel or report anything.
 */
export class ExecutionTable<P> {
  private readonly entries = new Map<string, Tracked<P>>();
  private readonly pendingPrepare = new Map<string, P>();

  constructor(
    private readonly workerId: string,
    private readonly now: () => string,
    private readonly newId: () => string = randomUUID
  ) {}

  prepared(ctx: PrepareContext, detail: P, plannedActions: readonly string[], idempotent: boolean): PreparedExecution {
    const prepared: PreparedExecution = { executionId: this.newId(), ctx, plannedActions, idempotent };
    this.pendingPrepare.set(prepared.executionId, detail);
    return prepared;
  }

  start(
    prepared: PreparedExecution,
    signal: AbortSignal,
    run: (detail: P, signal: AbortSignal) => Promise<Settled>
  ): ExecutionHandle {
    const detail = this.pendingPrepare.get(prepared.executionId);
    if (detail === undefined)
      throw new ControlStackError("worker_prepare_required", "execution was not prepared by this worker");
    this.pendingPrepare.delete(prepared.executionId);
    const { ctx } = prepared;
    const handle: ExecutionHandle = {
      executionId: prepared.executionId,
      missionId: ctx.missionId,
      unitId: ctx.unitId,
      workerId: this.workerId,
      claimToken: ctx.claim.claimToken,
      attempt: ctx.attempt,
      startedAt: this.now()
    };
    const controller = new AbortController();
    const relay = () => controller.abort();
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", relay, { once: true });
    const entry = { prepared, detail, handle, controller } as Tracked<P>;
    entry.done = run(detail, controller.signal).then(
      (settled) => {
        entry.settled = settled;
        return settled;
      },
      (error: unknown) => {
        // A wrapper's run() must resolve; a throw means the wrapper itself broke, so the outcome is unknown.
        const settled: Settled = {
          outcome: "unknown",
          externalStateUncertain: true,
          state: "failed",
          failure: {
            category: "unknown",
            nativeCode: error instanceof Error ? error.name : "thrown",
            nativeMessage: error instanceof Error ? error.message.slice(0, 200) : "wrapper failure",
            retrySafe: false
          }
        };
        entry.settled = settled;
        return settled;
      }
    );
    this.entries.set(handle.executionId, entry);
    return handle;
  }

  /** Mark a pre-existing execution as started by resume rather than prepare. */
  get(handle: ExecutionHandle): Tracked<P> {
    const entry = this.entries.get(handle.executionId);
    if (!entry || entry.handle.workerId !== this.workerId || entry.handle.claimToken !== handle.claimToken) {
      throw new ControlStackError("worker_handle_unknown", "execution handle was not issued by this worker");
    }
    return entry;
  }

  observe(handle: ExecutionHandle): ExecutionObservation {
    const entry = this.get(handle);
    return {
      handle: entry.handle,
      state: entry.settled?.state ?? "running",
      observedAt: this.now(),
      actions: entry.settled?.actions ?? [],
      resources: entry.settled?.resources ?? []
    };
  }

  cancel(handle: ExecutionHandle, reason: CancellationReason): void {
    const entry = this.get(handle);
    entry.cancelRequested ??= reason;
    entry.controller.abort();
  }

  async report(handle: ExecutionHandle, authority: PrepareContext["authority"]): Promise<ExecutionReport> {
    const entry = this.get(handle);
    const settled = await entry.done;
    const { claimToken: _claimToken, ...publicHandle } = entry.handle;
    void _claimToken;
    return {
      handle: publicHandle,
      claim: { workerId: entry.handle.workerId, claimTokenHash: stableHash(entry.handle.claimToken) },
      authority,
      outcome: settled.outcome,
      startedAt: entry.handle.startedAt,
      finishedAt: this.now(),
      actions: settled.actions ?? [],
      resources: settled.resources ?? [],
      receipts: settled.receipts ?? [],
      ...(settled.result ? { result: settled.result } : {}),
      ...(settled.failure ? { failure: settled.failure } : {}),
      ...(settled.selfAssessment ? { selfAssessment: settled.selfAssessment } : {}),
      externalStateUncertain: settled.externalStateUncertain
    };
  }

  detailFor(handle: ExecutionHandle): P {
    return this.get(handle).detail;
  }
}
