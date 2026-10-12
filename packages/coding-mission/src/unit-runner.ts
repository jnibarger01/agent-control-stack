import { randomUUID } from "node:crypto";
import { ControlStackError } from "@agent-control-stack/shared";
import type { GovernedExecution } from "./governed-runtime.js";
import type {
  ApplyResult,
  DispatchEnvelope,
  ExecutorLane,
  ResultEnvelope,
  WorkUnitExecutorAdapter
} from "./worker-execution.js";

export interface UnitRunnerOptions {
  /** The governed root. The runner only uses its stores and its dispatch gate; it cannot mint or widen authority. */
  execution: Pick<GovernedExecution, "missions" | "dispatcher">;
  /** One adapter per lane this deployment can actually run. A lane with no adapter is never claimed. */
  adapters: readonly WorkUnitExecutorAdapter[];
  /** ACS's own clock. */
  now?: () => string;
  newClaimToken?: () => string;
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
      route: { lane: input.lane },
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
        // The refusal and its reason are already durable. Fail the claimed unit so it is not left running, and as
        // policy_denied, which a retry can never fix; reopening it takes an explicit operator retry.
        missions.failUnit(input.missionId, input.unitId, token, {
          category: "policy_denied",
          retryable: false,
          now: this.now()
        });
        return { status: "denied", reason: error.message };
      }
      throw error;
    }

    let result: ResultEnvelope;
    try {
      result = await adapter.execute(dispatch, input.signal);
    } catch (error) {
      // An adapter that throws leaves the outcome unknown, so the result says the external state may have changed.
      result = {
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
        failure: {
          category: "tool_failure",
          nativeMessage: (error instanceof Error ? error.message : String(error)).slice(0, 500),
          retrySafe: false
        },
        externalStateUncertain: true
      };
    }
    const applied = dispatcher.applyResult({ claimToken: token, result });
    return { status: "executed", applied, attemptId: dispatch.attemptId };
  }
}
