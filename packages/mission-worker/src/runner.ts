/**
 * ACS-side driver for a MissionWorker.
 *
 * The driver binds a worker to a durable claim before anything runs, ingests the worker's report under the claim
 * fence, and never lets a worker's own "done" complete a unit that needs independent verification. Reports are
 * evidence: they are stored, then applied only if they still match the live claim.
 */
import { ControlStackError, stableHash } from "@agent-control-stack/shared";
import {
  TERMINAL_MISSION_STATES,
  type CodingMissionStore,
  type FailureCategory,
  type UnitCheckpoint
} from "@agent-control-stack/coding-mission";
import type {
  CancellationReason,
  ClaimIdentity,
  ExecutionHandle,
  ExecutionReport,
  MissionWorker,
  PrepareContext,
  PreparedExecution,
  WorkerAuthority,
  WorkerCheckpoint
} from "./contract.js";
import { failureFromError } from "./failure.js";

export interface RunnerDeps {
  store: CodingMissionStore;
  now(): string;
}

export type IngestResult =
  | { applied: "completed" | "awaiting_verification" | "failed" | "retryable" | "cancelled" | "checkpointed" }
  | { applied: "marked_unknown" }
  | { applied: "rejected_stale" | "rejected_invalid"; reason: string };

export type RunResult =
  | {
      ran: false;
      reason:
        | "mission_not_active"
        | "unit_not_found"
        | "claim_mismatch"
        | "worker_mismatch"
        | "kind_unsupported"
        | "resume_unsupported"
        | "not_resumable"
        | "budget_exhausted";
    }
  | { ran: true; handle?: ExecutionHandle; ingest: IngestResult };

/** Strip the claim token before a report becomes durable evidence. */
function evidenceForReport(report: ExecutionReport): unknown {
  return JSON.parse(JSON.stringify(report)) as unknown;
}

export function ingestReport(deps: RunnerDeps, handle: ExecutionHandle, report: ExecutionReport): IngestResult {
  const { store } = deps;
  const now = deps.now();
  const reject = (applied: "rejected_stale" | "rejected_invalid", reason: string): IngestResult => {
    store.putEvidence(
      handle.missionId,
      `${applied}:${handle.unitId}`,
      { reason, report: evidenceForReport(report) },
      now
    );
    return { applied, reason };
  };
  if (
    report.handle.executionId !== handle.executionId ||
    report.handle.missionId !== handle.missionId ||
    report.handle.unitId !== handle.unitId ||
    report.claim.workerId !== handle.workerId ||
    report.claim.claimTokenHash !== stableHash(handle.claimToken)
  ) {
    return reject("rejected_invalid", "report does not match the execution handle or claim");
  }
  const unit = store.workUnits(handle.missionId).find((candidate) => candidate.unitId === handle.unitId);
  if (!unit) return reject("rejected_invalid", "work unit does not exist");
  // The report is durable evidence of what the worker did, whatever ACS decides to do with it.
  store.putEvidence(
    handle.missionId,
    `execution_report:${handle.unitId}:${handle.attempt}`,
    evidenceForReport(report),
    now
  );
  try {
    switch (report.outcome) {
      case "succeeded": {
        if (!report.result) {
          store.failUnit(handle.missionId, handle.unitId, handle.claimToken, {
            category: "invalid_output",
            retryable: false,
            now
          });
          return { applied: "failed" };
        }
        const result = { resultHash: report.result.resultHash, files: report.result.files };
        if (unit.verificationPolicy !== "none") {
          store.awaitVerification(handle.missionId, handle.unitId, handle.claimToken, result, now);
          return { applied: "awaiting_verification" };
        }
        store.completeOperation(handle.missionId, handle.unitId, handle.claimToken, result, now);
        return { applied: "completed" };
      }
      case "failed": {
        const failure = report.failure ?? { category: "unknown" as const, retrySafe: false };
        const next = store.failUnit(handle.missionId, handle.unitId, handle.claimToken, {
          category: failure.category,
          retryable: failure.retrySafe && !report.externalStateUncertain,
          now
        });
        return { applied: next };
      }
      case "cancelled": {
        if (unit.status === "cancelled") return { applied: "cancelled" };
        store.failUnit(handle.missionId, handle.unitId, handle.claimToken, {
          category: "cancelled",
          retryable: false,
          now
        });
        return { applied: "failed" };
      }
      case "checkpointed": {
        if (!report.checkpoint) return reject("rejected_invalid", "checkpointed report carries no checkpoint");
        store.checkpointUnit(
          handle.missionId,
          handle.unitId,
          handle.claimToken,
          {
            checkpointId: report.checkpoint.checkpointId,
            stateRef: report.checkpoint.stateRef,
            completedActions: report.checkpoint.completedActions,
            ...(report.checkpoint.resumeHint ? { resumeHint: report.checkpoint.resumeHint } : {})
          },
          now
        );
        return { applied: "checkpointed" };
      }
      case "unknown": {
        // The worker cannot say whether its effect happened. That is never retried blindly.
        store.markOperation(handle.missionId, handle.unitId, "unknown");
        return { applied: "marked_unknown" };
      }
    }
  } catch (error) {
    if (error instanceof ControlStackError && error.code === "coding_mission_claim_conflict") {
      return reject("rejected_stale", "claim no longer matches: stale worker, cancelled unit, or superseded attempt");
    }
    throw error;
  }
}

function toWorkerCheckpoint(checkpoint: UnitCheckpoint): WorkerCheckpoint {
  return {
    checkpointId: checkpoint.checkpointId,
    stateRef: checkpoint.stateRef,
    completedActions: checkpoint.completedActions,
    ...(checkpoint.resumeHint ? { resumeHint: checkpoint.resumeHint } : {}),
    externalStateMayHaveChanged: true
  };
}

function failBeforeReport(
  deps: RunnerDeps,
  ctx: PrepareContext,
  category: FailureCategory,
  retryable: boolean
): IngestResult {
  const next = deps.store.failUnit(ctx.missionId, ctx.unitId, ctx.claim.claimToken, {
    category,
    retryable,
    now: deps.now()
  });
  return { applied: next };
}

async function drive(
  deps: RunnerDeps,
  worker: MissionWorker,
  ctx: PrepareContext,
  start: (prepared: PreparedExecution, signal: AbortSignal) => Promise<ExecutionHandle>,
  signal: AbortSignal | undefined
): Promise<RunResult> {
  let prepared: PreparedExecution;
  try {
    prepared = await worker.prepare(ctx);
  } catch (error) {
    // Nothing was started, so no side effect can have happened.
    const failure = failureFromError(error, false);
    return { ran: true, ingest: failBeforeReport(deps, ctx, failure.category, failure.retrySafe) };
  }
  const mission = deps.store.get(ctx.missionId);
  if (!mission || TERMINAL_MISSION_STATES.has(mission.state)) return { ran: false, reason: "mission_not_active" };

  const controller = new AbortController();
  const relay = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener("abort", relay, { once: true });
  let handle: ExecutionHandle;
  try {
    handle = await start(prepared, controller.signal);
  } catch (error) {
    signal?.removeEventListener("abort", relay);
    // Whether the execution started is unknown, so this is a failure that is never declared retry-safe.
    const failure = failureFromError(error, true);
    return { ran: true, ingest: failBeforeReport(deps, ctx, failure.category, false) };
  }
  let cancelled = false;
  const cancel = (reason: CancellationReason) => {
    if (cancelled) return;
    cancelled = true;
    void worker.cancel(handle, reason).catch(() => undefined);
  };
  if (controller.signal.aborted) cancel({ code: "mission_cancelled" });
  controller.signal.addEventListener("abort", () => cancel({ code: "mission_cancelled" }), { once: true });
  try {
    const report = await worker.report(handle);
    return { ran: true, handle, ingest: ingestReport(deps, handle, report) };
  } catch (error) {
    // The worker could not account for the execution. Fail closed: outcome unknown, no blind retry.
    deps.store.putEvidence(
      ctx.missionId,
      `report_failed:${ctx.unitId}`,
      { workerId: worker.workerId, error: failureFromError(error, true) },
      deps.now()
    );
    try {
      deps.store.markOperation(ctx.missionId, ctx.unitId, "unknown");
    } catch {
      // The unit may already have moved (for example cancelled); the evidence above is the record.
    }
    return { ran: true, handle, ingest: { applied: "marked_unknown" } };
  } finally {
    signal?.removeEventListener("abort", relay);
  }
}

function contextFor(
  deps: RunnerDeps,
  unit: { unitId: string; kind: PrepareContext["kind"]; attempt: number; payload?: PrepareContext["payload"] },
  missionId: string,
  claim: ClaimIdentity,
  authority: WorkerAuthority
): PrepareContext {
  return {
    missionId,
    unitId: unit.unitId,
    kind: unit.kind,
    attempt: unit.attempt,
    claim,
    authority,
    ...(unit.payload ? { payload: unit.payload } : {}),
    now: deps.now()
  };
}

/**
 * Run a unit that this worker already holds the durable claim for. The worker, claim token and unit kind are all
 * checked against the persisted row before prepare runs, so a worker that does not hold the claim never executes.
 */
export async function runClaimedUnit(
  deps: RunnerDeps,
  worker: MissionWorker,
  input: { missionId: string; unitId: string; claim: ClaimIdentity; authority?: WorkerAuthority; signal?: AbortSignal }
): Promise<RunResult> {
  const mission = deps.store.get(input.missionId);
  if (!mission || TERMINAL_MISSION_STATES.has(mission.state)) return { ran: false, reason: "mission_not_active" };
  const unit = deps.store.workUnits(input.missionId).find((candidate) => candidate.unitId === input.unitId);
  if (!unit) return { ran: false, reason: "unit_not_found" };
  if (
    unit.status !== "running" ||
    unit.claimToken !== input.claim.claimToken ||
    unit.workerId !== input.claim.workerId
  ) {
    return { ran: false, reason: "claim_mismatch" };
  }
  if (worker.workerId !== input.claim.workerId) return { ran: false, reason: "worker_mismatch" };
  if (!worker.kinds.includes(unit.kind)) return { ran: false, reason: "kind_unsupported" };
  const ctx = contextFor(deps, unit, input.missionId, input.claim, input.authority ?? {});
  return drive(deps, worker, ctx, (prepared, signal) => worker.execute(prepared, signal), input.signal);
}

/**
 * Resume a checkpointed unit on a (possibly different) worker. The durable claim is replaced first, which fences out
 * the previous worker; the new worker is told to re-observe external state before acting.
 */
export async function resumeCheckpointedUnit(
  deps: RunnerDeps,
  worker: MissionWorker,
  input: {
    missionId: string;
    unitId: string;
    claim: ClaimIdentity;
    route: unknown;
    authority?: WorkerAuthority;
    signal?: AbortSignal;
  }
): Promise<RunResult> {
  if (!worker.resume) return { ran: false, reason: "resume_unsupported" };
  if (worker.workerId !== input.claim.workerId) return { ran: false, reason: "worker_mismatch" };
  const unit = deps.store.workUnits(input.missionId).find((candidate) => candidate.unitId === input.unitId);
  if (!unit) return { ran: false, reason: "unit_not_found" };
  if (!worker.kinds.includes(unit.kind)) return { ran: false, reason: "kind_unsupported" };
  const resumed = deps.store.resumeUnit(input.missionId, input.unitId, {
    token: input.claim.claimToken,
    workerId: input.claim.workerId,
    route: input.route,
    claimedAt: deps.now()
  });
  if (!resumed.ok) {
    if (resumed.outcome === "budget_exhausted") return { ran: false, reason: "budget_exhausted" };
    if (resumed.outcome === "mission_not_active") return { ran: false, reason: "mission_not_active" };
    return { ran: false, reason: "not_resumable" };
  }
  const authority = input.authority ?? {};
  const ctx = contextFor(deps, { ...unit, attempt: resumed.attempt }, input.missionId, input.claim, authority);
  const checkpoint = toWorkerCheckpoint(resumed.checkpoint);
  return drive(
    deps,
    worker,
    ctx,
    () =>
      worker.resume!(checkpoint, {
        claim: input.claim,
        authority,
        attempt: resumed.attempt,
        now: deps.now(),
        reobserveBeforeActing: true
      }),
    input.signal
  );
}
