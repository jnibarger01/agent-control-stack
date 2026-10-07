/**
 * The mission worker contract.
 *
 * Every executor ACS can hand a work unit to (coding engine, shell/tool controller, later CUA and agents) is wrapped
 * behind this one shape. The contract exists so ACS can always answer: what is executing, who owns the claim, what
 * authority it holds, what it touched, what it did, what the result and normalized failure are, whether a retry is
 * safe, and whether a checkpoint exists. A worker only ever produces EVIDENCE (a report). ACS decides what the report
 * means, under the claim fence, and a worker never becomes its own authority boundary.
 */
import type { FailureCategory, WorkUnitKind, WorkUnitPayload } from "@agent-control-stack/coding-mission";

/** Opaque references to the authority a unit runs under. No secrets: the references are resolved by ACS, not trusted. */
export interface WorkerAuthority {
  grantId?: string;
  leaseId?: string;
  fencingToken?: number;
  /** Hash of the approved action or plan this execution is bound to. */
  actionHash?: string;
}

export interface ClaimIdentity {
  workerId: string;
  /** The fence. Held in-process only; reports carry its hash. */
  claimToken: string;
}

export interface PrepareContext {
  missionId: string;
  unitId: string;
  kind: WorkUnitKind;
  attempt: number;
  claim: ClaimIdentity;
  authority: WorkerAuthority;
  payload?: WorkUnitPayload;
  now: string;
}

export interface PreparedExecution {
  readonly executionId: string;
  readonly ctx: PrepareContext;
  /** Tool/action names the worker intends to use, declared up front so they can be audited against the report. */
  readonly plannedActions: readonly string[];
  /** True only if re-running the same execution after a failure cannot repeat an external side effect. */
  readonly idempotent: boolean;
}

export interface ExecutionHandle {
  readonly executionId: string;
  readonly missionId: string;
  readonly unitId: string;
  readonly workerId: string;
  readonly claimToken: string;
  readonly attempt: number;
  readonly startedAt: string;
}

export type ExecutionState = "running" | "checkpointed" | "succeeded" | "failed" | "cancelled" | "timed_out";

export interface ActionRecord {
  name: string;
  at: string;
  ok: boolean;
  /** Hash of the arguments, never the arguments themselves. */
  argsHash?: string;
}

export interface ResourceTouch {
  kind: "file" | "process" | "network" | "application" | "repository" | "other";
  ref: string;
  access: "read" | "write" | "execute";
}

export interface Receipt {
  kind: string;
  hash: string;
}

export interface ExecutionObservation {
  handle: ExecutionHandle;
  state: ExecutionState;
  observedAt: string;
  actions: ActionRecord[];
  resources: ResourceTouch[];
  checkpointId?: string;
}

export interface WorkerCheckpoint {
  checkpointId: string;
  /** Hash or reference of worker-held state. Never the state itself. */
  stateRef: string;
  completedActions: string[];
  resumeHint?: string;
  /** Always true: a checkpoint is a hint, never proof that external state is unchanged. */
  readonly externalStateMayHaveChanged: true;
}

export interface CancellationReason {
  code: "mission_cancelled" | "budget_exhausted" | "lease_lost" | "operator" | "timeout";
  detail?: string;
}

export interface ResumeContext {
  claim: ClaimIdentity;
  authority: WorkerAuthority;
  attempt: number;
  now: string;
  /** Always true: re-observe external state before acting; a checkpoint does not prove it is unchanged. */
  readonly reobserveBeforeActing: true;
}

export interface NormalizedFailure {
  category: FailureCategory;
  /** The worker's own error code/message, kept beside the category, scrubbed and bounded. */
  nativeCode?: string;
  nativeMessage?: string;
  /** True only when no external side effect can have occurred, so repeating the unit cannot duplicate one. */
  retrySafe: boolean;
}

export type ReportOutcome = "succeeded" | "failed" | "cancelled" | "checkpointed" | "unknown";

export interface ExecutionReport {
  handle: Omit<ExecutionHandle, "claimToken">;
  claim: { workerId: string; claimTokenHash: string };
  authority: WorkerAuthority;
  outcome: ReportOutcome;
  startedAt: string;
  finishedAt: string;
  actions: ActionRecord[];
  resources: ResourceTouch[];
  receipts: Receipt[];
  result?: { resultHash: string; files: string[]; filesReported: boolean };
  failure?: NormalizedFailure;
  checkpoint?: WorkerCheckpoint;
  /** What the worker says about itself. Evidence only; it can never complete a unit that needs verification. */
  selfAssessment?: { claimedComplete: boolean; summary?: string };
  /** True when external side effects may have happened that this report cannot fully account for. */
  externalStateUncertain: boolean;
}

export interface MissionWorker {
  readonly workerId: string;
  /** The unit kinds this worker may execute. A unit of any other kind is refused before prepare. */
  readonly kinds: readonly WorkUnitKind[];

  prepare(ctx: PrepareContext): Promise<PreparedExecution>;
  execute(prepared: PreparedExecution, signal: AbortSignal): Promise<ExecutionHandle>;
  /** A non-blocking snapshot of a running execution. */
  observe(handle: ExecutionHandle): Promise<ExecutionObservation>;
  checkpoint?(handle: ExecutionHandle): Promise<WorkerCheckpoint>;
  cancel(handle: ExecutionHandle, reason: CancellationReason): Promise<void>;
  resume?(checkpoint: WorkerCheckpoint, ctx: ResumeContext): Promise<ExecutionHandle>;
  /** Resolves once the execution is terminal (or has stopped at a checkpoint) with the full account of it. */
  report(handle: ExecutionHandle): Promise<ExecutionReport>;
}
