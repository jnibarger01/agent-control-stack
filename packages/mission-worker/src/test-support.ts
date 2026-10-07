import { CodingMissionStore, type NewWorkUnit, type VerificationPolicy } from "@agent-control-stack/coding-mission";
import { stableHash } from "@agent-control-stack/shared";
import type {
  CancellationReason,
  ExecutionHandle,
  ExecutionObservation,
  ExecutionReport,
  MissionWorker,
  PrepareContext,
  PreparedExecution,
  WorkerCheckpoint
} from "./contract.js";
import type { RunnerDeps } from "./runner.js";

export const T0 = "2026-10-06T00:00:00.000Z";
let counter = 0;
export const token = () => `claim-token-${(counter += 1)}`;

export function setup(
  options: {
    budget?: Parameters<CodingMissionStore["createGeneral"]>[0]["budget"];
    policy?: VerificationPolicy;
    units?: NewWorkUnit[];
  } = {}
) {
  const store = new CodingMissionStore(":memory:");
  store.createGeneral({
    missionId: "m1",
    summary: "s",
    ...(options.budget ? { budget: options.budget } : {}),
    now: T0
  });
  store.addWorkUnits(
    "m1",
    options.units ?? [
      {
        unitId: "u1",
        kind: "coding",
        title: "u1",
        ...(options.policy ? { verificationPolicy: options.policy } : {}),
        payload: { instructions: "do it" }
      }
    ],
    T0
  );
  const deps: RunnerDeps = { store, now: () => T0 };
  return { store, deps };
}

export function claimUnit(store: CodingMissionStore, unitId = "u1", workerId = "w1") {
  const claim = { token: token(), workerId, route: { workerId }, claimedAt: T0 };
  const result = store.claimUnit("m1", unitId, claim);
  if (!result.ok) throw new Error(`claim failed: ${JSON.stringify(result)}`);
  return { workerId, claimToken: claim.token };
}

export type Behavior = (
  ctx: PrepareContext,
  signal: AbortSignal
) => Promise<Partial<ExecutionReport> & { outcome: ExecutionReport["outcome"] }>;

/** A scriptable worker that records every call so tests can prove what did and did not run. */
export class FakeWorker implements MissionWorker {
  readonly calls: string[] = [];
  readonly kinds;
  cancelled: CancellationReason | undefined;
  resumeContext: unknown;
  private handles = new Map<
    string,
    { ctx: PrepareContext; behavior: Promise<Partial<ExecutionReport> & { outcome: ExecutionReport["outcome"] }> }
  >();
  prepareError: Error | undefined;
  executeError: Error | undefined;
  reportError: Error | undefined;
  supportsResume = false;

  constructor(
    readonly workerId = "w1",
    public behavior: Behavior = async () => ({
      outcome: "succeeded",
      result: { resultHash: "h", files: ["a.ts"], filesReported: true }
    }),
    kinds: MissionWorker["kinds"] = ["coding"]
  ) {
    this.kinds = kinds;
  }

  async prepare(ctx: PrepareContext): Promise<PreparedExecution> {
    this.calls.push("prepare");
    if (this.prepareError) throw this.prepareError;
    return { executionId: `exec-${ctx.unitId}-${ctx.attempt}`, ctx, plannedActions: ["fake"], idempotent: false };
  }

  async execute(prepared: PreparedExecution, signal: AbortSignal): Promise<ExecutionHandle> {
    this.calls.push("execute");
    if (this.executeError) throw this.executeError;
    return this.start(prepared.ctx, prepared.executionId, signal);
  }

  private start(ctx: PrepareContext, executionId: string, signal: AbortSignal): ExecutionHandle {
    const handle: ExecutionHandle = {
      executionId,
      missionId: ctx.missionId,
      unitId: ctx.unitId,
      workerId: this.workerId,
      claimToken: ctx.claim.claimToken,
      attempt: ctx.attempt,
      startedAt: T0
    };
    this.handles.set(executionId, { ctx, behavior: this.behavior(ctx, signal) });
    return handle;
  }

  async observe(handle: ExecutionHandle): Promise<ExecutionObservation> {
    return { handle, state: "running", observedAt: T0, actions: [], resources: [] };
  }

  async cancel(_handle: ExecutionHandle, reason: CancellationReason): Promise<void> {
    this.calls.push("cancel");
    this.cancelled = reason;
  }

  get resume() {
    if (!this.supportsResume) return undefined;
    return async (_checkpoint: WorkerCheckpoint, ctx: { claim: { claimToken: string }; attempt: number }) => {
      this.calls.push("resume");
      this.resumeContext = ctx;
      const prepared = {
        ctx: {
          missionId: "m1",
          unitId: "u1",
          kind: "coding" as const,
          attempt: ctx.attempt,
          claim: { workerId: this.workerId, claimToken: ctx.claim.claimToken },
          authority: {},
          now: T0
        }
      };
      return this.start(prepared.ctx, `exec-u1-resume-${ctx.attempt}`, new AbortController().signal);
    };
  }

  async report(handle: ExecutionHandle): Promise<ExecutionReport> {
    this.calls.push("report");
    if (this.reportError) throw this.reportError;
    const entry = this.handles.get(handle.executionId);
    if (!entry) throw new Error("unknown handle");
    const partial = await entry.behavior;
    const { claimToken: _claimToken, ...publicHandle } = handle;
    void _claimToken;
    return {
      handle: publicHandle,
      claim: { workerId: handle.workerId, claimTokenHash: stableHash(handle.claimToken) },
      authority: {},
      startedAt: T0,
      finishedAt: T0,
      actions: [],
      resources: [],
      receipts: [],
      externalStateUncertain: false,
      ...partial
    };
  }
}
