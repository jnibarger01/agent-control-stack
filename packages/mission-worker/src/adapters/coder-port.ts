import { stableHash } from "@agent-control-stack/shared";
import type { CodingMissionPorts, CodingMissionStore, WorkUnitKind } from "@agent-control-stack/coding-mission";
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

export interface CoderPortWorkerOptions {
  workerId: string;
  coder: CodingMissionPorts["coder"];
  store: CodingMissionStore;
  now?: () => string;
}

/**
 * Presents the existing coding-mission `coder` port as a MissionWorker, so the coding path and every other executor
 * go through one contract. The port is unchanged; this only translates its ExternalOutcome into a normalized report.
 * An `unknown` outcome stays `unknown`: it is never turned into a failure that could be retried.
 */
export class CoderPortMissionWorker implements MissionWorker {
  readonly workerId: string;
  readonly kinds: readonly WorkUnitKind[] = ["coding"];
  private readonly table: ExecutionTable<{ operationId: string; missionId: string }>;
  private readonly authority = new Map<string, PrepareContext["authority"]>();

  constructor(private readonly options: CoderPortWorkerOptions) {
    this.workerId = options.workerId;
    this.table = new ExecutionTable(options.workerId, options.now ?? (() => new Date().toISOString()));
  }

  async prepare(ctx: PrepareContext): Promise<PreparedExecution> {
    const prepared = this.table.prepared(
      ctx,
      { operationId: ctx.unitId, missionId: ctx.missionId },
      ["coder.execute"],
      false
    );
    this.authority.set(prepared.executionId, ctx.authority);
    return prepared;
  }

  async execute(prepared: PreparedExecution, signal: AbortSignal): Promise<ExecutionHandle> {
    return this.table.start(prepared, signal, (detail) => this.run(detail));
  }

  async observe(handle: ExecutionHandle): Promise<ExecutionObservation> {
    return this.table.observe(handle);
  }

  async cancel(handle: ExecutionHandle, reason: CancellationReason): Promise<void> {
    // The coder port has no cancel. The request is recorded, and the result of an in-flight call is still reported.
    this.table.cancel(handle, reason);
  }

  async report(handle: ExecutionHandle): Promise<ExecutionReport> {
    return this.table.report(handle, this.authority.get(handle.executionId) ?? {});
  }

  private async run(detail: { operationId: string; missionId: string }): Promise<Settled> {
    const at = new Date().toISOString();
    const mission = this.options.store.require(detail.missionId);
    const action = { name: "coder.execute", at };
    const outcome = await this.options.coder.execute({
      mission,
      operationId: detail.operationId,
      workerId: this.workerId
    });
    if (outcome.status === "succeeded" && outcome.value) {
      return {
        outcome: "succeeded",
        state: "succeeded",
        externalStateUncertain: false,
        actions: [{ ...action, ok: true }],
        resources: outcome.value.files.map((file) => ({ kind: "file" as const, ref: file, access: "write" as const })),
        receipts: [{ kind: "coder_result", hash: stableHash(outcome.value) }],
        result: { resultHash: outcome.value.resultHash, files: outcome.value.files, filesReported: true },
        selfAssessment: { claimedComplete: true }
      };
    }
    if (outcome.status === "rejected") {
      return {
        outcome: "failed",
        state: "failed",
        externalStateUncertain: false,
        actions: [{ ...action, ok: false }],
        failure: normalizeFailure({
          category: outcome.code === "conflict" ? "environment_changed" : "tool_failure",
          ...(outcome.code ? { nativeCode: outcome.code } : {}),
          sideEffectsPossible: true
        })
      };
    }
    // `unknown`, `absent`, or a success with no value: the port cannot say what happened.
    return {
      outcome: "unknown",
      state: "failed",
      externalStateUncertain: true,
      actions: [{ ...action, ok: false }],
      failure: normalizeFailure({
        category: "unknown",
        nativeCode: outcome.code ?? outcome.status,
        sideEffectsPossible: true
      })
    };
  }
}
