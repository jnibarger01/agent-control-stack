import { ControlStackError, stableHash } from "@agent-control-stack/shared";
import type { WorkUnitKind } from "@agent-control-stack/coding-mission";
import type { EngineAdapter, EngineOutcome, EngineTask } from "@agent-control-stack/engine-adapter";
import type {
  CancellationReason,
  ExecutionHandle,
  ExecutionObservation,
  ExecutionReport,
  MissionWorker,
  PrepareContext,
  PreparedExecution
} from "../contract.js";
import { normalizeFailure } from "../failure.js";
import { ExecutionTable, type Settled } from "./base.js";

export interface EngineWorkerOptions {
  workerId: string;
  adapter: EngineAdapter;
  kinds?: readonly WorkUnitKind[];
  /**
   * Builds the authority-bound engine task for this unit. It runs in prepare and may throw, which fails the unit
   * before anything starts. The wrapper never invents authority: lease, fencing token and worker id must come from here.
   */
  resolveTask(ctx: PrepareContext): EngineTask | Promise<EngineTask>;
  now?: () => string;
}

/**
 * Wraps a sandboxed coding-agent engine (EngineAdapter) as a MissionWorker without changing it.
 *
 * The engine is one opaque process, so there is no checkpoint or resume, and a failed or cancelled run may have changed
 * the workspace: those reports are marked externalStateUncertain and never retry-safe.
 */
export class EngineMissionWorker implements MissionWorker {
  readonly workerId: string;
  readonly kinds: readonly WorkUnitKind[];
  private readonly table: ExecutionTable<EngineTask>;
  private readonly authority = new Map<string, PrepareContext["authority"]>();

  constructor(private readonly options: EngineWorkerOptions) {
    this.workerId = options.workerId;
    this.kinds = options.kinds ?? ["coding", "agent"];
    this.table = new ExecutionTable(options.workerId, options.now ?? (() => new Date().toISOString()));
  }

  async prepare(ctx: PrepareContext): Promise<PreparedExecution> {
    const task = await this.options.resolveTask(ctx);
    if (task.workerId !== this.workerId) {
      throw new ControlStackError("policy_denied_worker_identity", "engine task is bound to a different worker");
    }
    if (ctx.authority.leaseId !== undefined && task.leaseId !== ctx.authority.leaseId) {
      throw new ControlStackError("policy_denied_lease", "engine task lease does not match the unit's authority");
    }
    if (ctx.authority.fencingToken !== undefined && task.fencingToken !== ctx.authority.fencingToken) {
      throw new ControlStackError(
        "policy_denied_fencing",
        "engine task fencing token does not match the unit's authority"
      );
    }
    const prepared = this.table.prepared(ctx, task, ["engine.invoke"], false);
    this.authority.set(prepared.executionId, ctx.authority);
    return prepared;
  }

  async execute(prepared: PreparedExecution, signal: AbortSignal): Promise<ExecutionHandle> {
    return this.table.start(prepared, signal, (task, abort) => this.run(task, abort));
  }

  async observe(handle: ExecutionHandle): Promise<ExecutionObservation> {
    return this.table.observe(handle);
  }

  async cancel(handle: ExecutionHandle, reason: CancellationReason): Promise<void> {
    this.table.cancel(handle, reason);
  }

  async report(handle: ExecutionHandle): Promise<ExecutionReport> {
    return this.table.report(handle, this.authority.get(handle.executionId) ?? {});
  }

  private async run(task: EngineTask, signal: AbortSignal): Promise<Settled> {
    const at = new Date().toISOString();
    let outcome: EngineOutcome;
    try {
      outcome = await this.options.adapter.invoke(task, signal);
    } catch (error) {
      return {
        outcome: "unknown",
        state: "failed",
        externalStateUncertain: true,
        actions: [{ name: "engine.invoke", at, ok: false }],
        failure: normalizeFailure({
          category: "unknown",
          nativeCode: "engine_threw",
          nativeMessage: error,
          sideEffectsPossible: true
        })
      };
    }
    const actions = [{ name: "engine.invoke", at, ok: outcome.status === "completed" && outcome.exitCode === 0 }];
    const resources = [
      { kind: "file" as const, ref: `workspace:${task.workspace.allocationId}`, access: "write" as const }
    ];
    switch (outcome.status) {
      case "completed": {
        const hash = stableHash({
          exitCode: outcome.exitCode,
          stdout: outcome.stdout,
          stderr: outcome.stderr,
          stdoutTruncated: outcome.stdoutTruncated,
          stderrTruncated: outcome.stderrTruncated
        });
        if (outcome.exitCode === 0) {
          return {
            outcome: "succeeded",
            state: "succeeded",
            externalStateUncertain: false,
            actions,
            resources,
            receipts: [{ kind: "engine_output", hash }],
            // The engine does not enumerate the files it changed; ACS must not read that as "none changed".
            result: { resultHash: hash, files: [], filesReported: false },
            selfAssessment: { claimedComplete: true }
          };
        }
        return {
          outcome: "failed",
          state: "failed",
          externalStateUncertain: true,
          actions,
          resources,
          receipts: [{ kind: "engine_output", hash }],
          failure: normalizeFailure({
            category: "tool_failure",
            nativeCode: `exit_${outcome.exitCode}`,
            nativeMessage: outcome.stderr,
            sideEffectsPossible: true
          })
        };
      }
      case "timeout":
        return {
          outcome: "failed",
          state: "timed_out",
          externalStateUncertain: true,
          actions,
          resources,
          failure: normalizeFailure({ category: "timeout", nativeCode: "engine_timeout", sideEffectsPossible: true })
        };
      case "cancelled":
        return { outcome: "cancelled", state: "cancelled", externalStateUncertain: true, actions, resources };
      case "process_error":
        return {
          outcome: "failed",
          state: "failed",
          externalStateUncertain: true,
          actions,
          resources,
          failure: normalizeFailure({
            category: "worker_unavailable",
            nativeCode: "process_error",
            nativeMessage: outcome.message,
            sideEffectsPossible: true
          })
        };
    }
  }
}
