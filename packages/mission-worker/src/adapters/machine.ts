import { ControlStackError, stableHash } from "@agent-control-stack/shared";
import type { WorkUnitKind } from "@agent-control-stack/coding-mission";
import type { MachineController } from "@agent-control-stack/machine-controller";
import type {
  CancellationReason,
  ExecutionHandle,
  ExecutionObservation,
  ExecutionReport,
  MissionWorker,
  PrepareContext,
  PreparedExecution
} from "../contract.js";
import { failureFromError } from "../failure.js";
import { ExecutionTable, type Settled } from "./base.js";

/** Machine tools that cannot change anything outside ACS. Only these are ever declared retry-safe. */
export const READ_ONLY_MACHINE_TOOLS: ReadonlySet<string> = new Set([
  "system.status",
  "fs.list",
  "fs.stat",
  "fs.read",
  "fs.search_name",
  "cmd.preview"
]);

export interface MachineCall {
  name: string;
  args: unknown;
}

export interface MachineWorkerOptions {
  workerId: string;
  controller: Pick<MachineController, "callTool">;
  kinds?: readonly WorkUnitKind[];
  /**
   * Resolves the approved call for this unit. A `tool` payload carries only the tool name and an argument hash; the
   * arguments come from the approved action, and the wrapper refuses a call whose hash does not match the payload.
   */
  resolveCall(ctx: PrepareContext): MachineCall | Promise<MachineCall>;
  now?: () => string;
}

/**
 * Wraps the local machine controller (read-only tools, previewed commands) as a MissionWorker.
 *
 * `callTool` is not abortable, so cancel is best effort: a cancelled read-only call is reported cancelled, and a
 * cancelled call to any other tool is reported with externalStateUncertain because it may already have run.
 */
export class MachineToolMissionWorker implements MissionWorker {
  readonly workerId: string;
  readonly kinds: readonly WorkUnitKind[];
  private readonly table: ExecutionTable<MachineCall>;
  private readonly authority = new Map<string, PrepareContext["authority"]>();

  constructor(private readonly options: MachineWorkerOptions) {
    this.workerId = options.workerId;
    this.kinds = options.kinds ?? ["tool", "shell"];
    this.table = new ExecutionTable(options.workerId, options.now ?? (() => new Date().toISOString()));
  }

  async prepare(ctx: PrepareContext): Promise<PreparedExecution> {
    const call = await this.options.resolveCall(ctx);
    if (ctx.payload?.kind === "tool") {
      if (ctx.payload.toolName !== call.name) {
        throw new ControlStackError("policy_denied_tool", "resolved call does not match the unit's tool");
      }
      if (ctx.payload.argsHash !== undefined && ctx.payload.argsHash !== stableHash(call.args)) {
        throw new ControlStackError(
          "policy_denied_arguments",
          "call arguments do not match the approved argument hash"
        );
      }
    }
    const prepared = this.table.prepared(ctx, call, [call.name], READ_ONLY_MACHINE_TOOLS.has(call.name));
    this.authority.set(prepared.executionId, ctx.authority);
    return prepared;
  }

  async execute(prepared: PreparedExecution, signal: AbortSignal): Promise<ExecutionHandle> {
    return this.table.start(prepared, signal, (call, abort) => this.run(call, abort));
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

  private async run(call: MachineCall, signal: AbortSignal): Promise<Settled> {
    const at = new Date().toISOString();
    const readOnly = READ_ONLY_MACHINE_TOOLS.has(call.name);
    const argsHash = stableHash(call.args);
    const action = { name: call.name, at, argsHash };
    if (signal.aborted) {
      return {
        outcome: "cancelled",
        state: "cancelled",
        externalStateUncertain: false,
        actions: [{ ...action, ok: false }]
      };
    }
    try {
      const result = await this.options.controller.callTool(call.name, call.args);
      const hash = stableHash(result ?? null);
      // callTool cannot be interrupted, so a call that finished despite a cancel request is reported as it happened.
      return {
        outcome: "succeeded",
        state: "succeeded",
        externalStateUncertain: false,
        actions: [{ ...action, ok: true }],
        receipts: [{ kind: "machine_tool_result", hash }],
        result: { resultHash: hash, files: [], filesReported: false },
        selfAssessment: { claimedComplete: true }
      };
    } catch (error) {
      const failure = failureFromError(error, !readOnly);
      return {
        outcome: signal.aborted ? "cancelled" : "failed",
        state: signal.aborted ? "cancelled" : "failed",
        externalStateUncertain: !readOnly,
        actions: [{ ...action, ok: false }],
        failure
      };
    }
  }
}
