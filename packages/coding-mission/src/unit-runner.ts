import { randomUUID } from "node:crypto";
import { ControlStackError, redactValue } from "@agent-control-stack/shared";
import type { GovernedExecution } from "./governed-runtime.js";
import type { FailureCategory } from "./mission-model.js";
import {
  deadlineResult,
  type ApplyResult,
  type DispatchEnvelope,
  type ExecutorLane,
  type ResultEnvelope,
  type WorkUnitExecutorAdapter
} from "./worker-execution.js";

export interface UnitRunnerOptions {
  /** The governed root. The runner only uses its stores and its dispatch gate; it cannot mint or widen authority. */
  execution: Pick<GovernedExecution, "missions" | "dispatcher">;
  /** One adapter per lane this deployment can actually run. A lane with no adapter is never claimed. */
  adapters: readonly WorkUnitExecutorAdapter[];
  /** ACS's own clock. */
  now?: () => string;
  newClaimToken?: () => string;
  /**
   * The producer identity recorded on the claim route. A unit with a verification policy needs one: verified execution
   * will not dispatch without it, and the runner never invents one. Chosen by the deployment, never by the worker.
   */
  implementerEngineId?: string;
}

export interface RunUnitInput {
  missionId: string;
  unitId: string;
  workerId: string;
  lane: ExecutorLane;
  signal?: AbortSignal;
}

export type RunUnitResult =
  /** Nothing was claimed or changed. */
  | { status: "not_run"; reason: string }
  /** The unit was claimed but authority refused the dispatch; the unit is failed (non-retryable) and nothing ran. */
  | { status: "denied"; reason: string }
  /** The adapter ran (or failed) and the ledger applied its result. */
  | { status: "executed"; applied: ApplyResult; attemptId: string };

/** A success must name a non-empty result hash and list its files as strings; anything else is unauditable. */
function hasUsableEvidence(result: ResultEnvelope): boolean {
  const evidence = result.result as { resultHash?: unknown; files?: unknown } | undefined;
  return (
    typeof evidence?.resultHash === "string" &&
    evidence.resultHash.length > 0 &&
    Array.isArray(evidence.files) &&
    evidence.files.every((file) => typeof file === "string")
  );
}

/**
 * Runs one work unit end to end: claim, governed dispatch, lane adapter, apply result. This is the production caller of
 * `WorkUnitExecutionLedger.beginDispatch`, so authority is checked at the one point every lane passes before a worker
 * runs. The runner decides nothing about authority; it only refuses to run what the gate refuses.
 */
export class GovernedUnitRunner {
  private readonly adapters = new Map<ExecutorLane, WorkUnitExecutorAdapter>();
  private readonly now: () => string;
  private readonly newClaimToken: () => string;

  constructor(private readonly options: UnitRunnerOptions) {
    for (const adapter of options.adapters) this.adapters.set(adapter.lane, adapter);
    this.now = options.now ?? (() => new Date().toISOString());
    this.newClaimToken = options.newClaimToken ?? randomUUID;
  }

  async runUnit(input: RunUnitInput): Promise<RunUnitResult> {
    const { missions, dispatcher } = this.options.execution;
    const adapter = this.adapters.get(input.lane);
    // Decided before any claim, so a deployment that cannot run a lane never strands a unit in `running`.
    if (!adapter) return { status: "not_run", reason: "lane_unavailable" };

    const token = this.newClaimToken();
    const claimed = missions.claimUnit(input.missionId, input.unitId, {
      token,
      workerId: input.workerId,
      route: {
        lane: input.lane,
        ...(this.options.implementerEngineId ? { implementerEngineId: this.options.implementerEngineId } : {})
      },
      claimedAt: this.now()
    });
    if (!claimed.ok) return { status: "not_run", reason: claimed.outcome };

    let dispatch: DispatchEnvelope;
    try {
      dispatch = dispatcher.beginDispatch({
        missionId: input.missionId,
        unitId: input.unitId,
        claimToken: token,
        workerId: input.workerId,
        lane: input.lane,
        now: this.now()
      });
    } catch (error) {
      if (error instanceof ControlStackError && error.code === "dispatch_authority_denied") {
        // The refusal and its reason are already durable. Fail the claimed unit so it is not left running. Neither
        // category can be fixed by a retry; reopening the unit takes an explicit operator retry. An expiry keeps its own
        // category so it stays distinguishable from a policy refusal.
        const reason = error.message.replace(/^dispatch refused: /u, "");
        missions.failUnit(input.missionId, input.unitId, token, {
          category: reason === "authority_expired" ? "authority_expired" : "policy_denied",
          retryable: false,
          now: this.now()
        });
        return { status: "denied", reason: error.message };
      }
      // Any other dispatch failure happened before anything ran, so give the claim back rather than strand the unit in
      // `running` until stale-claim recovery. The original error is what the caller needs, not a failure to release.
      try {
        missions.resetClaim(input.missionId, input.unitId);
      } catch {
        // the claim was already gone; recovery owns it now
      }
      throw error;
    }

    let result: ResultEnvelope;
    try {
      result = await this.executeWithinDeadline(adapter, dispatch, input.signal);
      // The ledger only checks that a result exists, and adapters can be remote or untyped, so a success that carries no
      // usable evidence is not allowed to drive the unit to `succeeded`.
      if (result.outcome === "succeeded" && !hasUsableEvidence(result)) {
        result = this.failedResult(
          dispatch,
          "invalid_output",
          "adapter reported success without valid result evidence"
        );
      }
    } catch (error) {
      // An adapter that throws leaves the outcome unknown, so the result says the external state may have changed.
      result = this.failedResult(dispatch, "tool_failure", error instanceof Error ? error.message : String(error));
    }
    const applied = dispatcher.applyResult({ claimToken: token, result });
    return { status: "executed", applied, attemptId: dispatch.attemptId };
  }

  /** A failed result whose external state is marked uncertain; the message is redacted before it can be persisted. */
  private failedResult(dispatch: DispatchEnvelope, category: FailureCategory, message: string): ResultEnvelope {
    return {
      schemaVersion: "acs.work-unit-result.v1",
      attemptId: dispatch.attemptId,
      missionId: dispatch.missionId,
      unitId: dispatch.unitId,
      unitAttempt: dispatch.unitAttempt,
      workerId: dispatch.workerId,
      lane: dispatch.lane,
      claimTokenHash: dispatch.claimTokenHash,
      outcome: "failed",
      startedAt: dispatch.issuedAt,
      finishedAt: this.now(),
      receipts: [],
      failure: { category, nativeMessage: String(redactValue(message)).slice(0, 500), retrySafe: false },
      externalStateUncertain: true
    };
  }

  /**
   * Races the executor against the deadline ACS set on a governed dispatch. ACS does not wait past it: the executor is
   * signalled to stop and the outcome is recorded as uncertain, because the operation may have started and may still be
   * running. A governed dispatch (it names a grant) with no deadline fails closed instead of running unbounded; a mission
   * with no authority binding has none and runs as before. `applyResult` separately judges a late result on ACS's clock.
   */
  private async executeWithinDeadline(
    adapter: WorkUnitExecutorAdapter,
    dispatch: DispatchEnvelope,
    callerSignal: AbortSignal | undefined
  ): Promise<ResultEnvelope> {
    const governed = dispatch.authority.grantId !== undefined;
    const deadlineAt = dispatch.authority.deadlineAt;
    if (deadlineAt === undefined) {
      if (governed) return deadlineResult(dispatch, this.now());
      return adapter.execute(dispatch, callerSignal);
    }
    const abort = new AbortController();
    const onCallerAbort = () => abort.abort();
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    if (callerSignal?.aborted) abort.abort();
    const budgetMs = Math.max(1, Date.parse(deadlineAt) - Date.parse(dispatch.issuedAt));
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<"deadline">((resolve) => {
      timer = setTimeout(() => {
        abort.abort();
        resolve("deadline");
      }, budgetMs);
    });
    const execution = adapter.execute(dispatch, abort.signal);
    execution.catch(() => undefined); // an executor that fails after the deadline is not an unhandled rejection
    try {
      const winner = await Promise.race([execution, expired]);
      return winner === "deadline" ? deadlineResult(dispatch, this.now()) : winner;
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  }
}
