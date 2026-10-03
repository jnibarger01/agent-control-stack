import type { AdmissionLane } from "@agent-control-stack/execution-admission";
import type { ChangeSetRecord } from "@agent-control-stack/work-items";
import type { OperationLane } from "./types.js";

export interface MissionRoutingRequest {
  missionId: string;
  workItemId: string;
  operationId: string;
  requiredCapabilities: string[];
  lane: OperationLane;
}

export type MissionRoutingOutcome =
  | {
      kind: "assigned";
      decisionId: string;
      selectedAgentId: string;
      selectedWorkerId: string;
      source: "nimble" | "deterministic_fallback";
      model: string;
      confidence?: number;
      threshold: number;
      evidence: Record<string, unknown>;
    }
  | { kind: "rejected"; decisionId?: string; reason: string; evidence: Record<string, unknown> };

/** The host delegates semantic choice and durable assignment to ACS routing. */
export interface MissionRouter {
  assign(request: MissionRoutingRequest): Promise<MissionRoutingOutcome>;
}

export interface DispatchRequest {
  missionId: string;
  operationId: string;
  executionId: string;
  lane: OperationLane;
  attempt: number;
  operationType: "execute" | "validate";
  assignment: Extract<MissionRoutingOutcome, { kind: "assigned" }>;
}

export type DispatchOutcome =
  | { kind: "result"; payload: Record<string, unknown>; observations?: Record<string, string> }
  | { kind: "unknown"; reason: string }
  | { kind: "retryable_failure"; reason: string }
  | { kind: "fatal_failure"; reason: string };

export interface OperationExecutor {
  dispatch(request: DispatchRequest): Promise<DispatchOutcome>;
}

export type ReconciliationInspection =
  | { kind: "not_started" }
  | { kind: "running" }
  | { kind: "completed"; payload: Record<string, unknown>; observations?: Record<string, string> }
  | { kind: "unavailable" };

export interface OperationReconciler {
  inspect(executionId: string): Promise<ReconciliationInspection>;
}

export interface MutationApplyRequest {
  idempotencyKey: string;
  changeSetHash: string;
  expectedBaseRevision: string;
  mutation: unknown;
}

export type MutationApplyOutcome =
  | { kind: "succeeded"; observedRevision: string }
  | { kind: "failed"; reason: string }
  | { kind: "diverged"; reason: string }
  | { kind: "unknown"; reason: string };

export interface MutationApplier {
  apply(input: MutationApplyRequest): Promise<MutationApplyOutcome>;
  inspect(
    idempotencyKey: string
  ): Promise<{ kind: "not_started" } | { kind: "succeeded"; observedRevision: string } | { kind: "unknown" }>;
}

export interface ChangeSetApplyRequest {
  operationId: string;
  changeSetId: string;
  changeSetHash: string;
  actionHash: string;
  authorityPermitId: string;
  changeSet: ChangeSetRecord;
}

export type ChangeSetApplyOutcome =
  | { kind: "APPLIED"; operationId: string; observedRevision: string }
  | { kind: "DENIED"; operationId: string; reason: string }
  | { kind: "FAILED"; operationId: string; reason: string }
  | { kind: "UNKNOWN"; operationId: string; reason: string };

export type ChangeSetApplyInspection =
  | { kind: "NOT_STARTED" }
  | { kind: "APPLIED"; operationId: string; observedRevision: string }
  | { kind: "DENIED"; operationId: string; reason: string }
  | { kind: "FAILED"; operationId: string; reason: string }
  | { kind: "UNKNOWN"; operationId: string; reason?: string };

/**
 * Applies only the persisted, approved canonical Change Set. Implementations
 * must durably record operationId before side effects and reconcile that ID on
 * retry. actionHash must equal changeSetHash and approvals must bind to the
 * current Change Set head.
 */
export interface ChangeSetApplier {
  apply(input: ChangeSetApplyRequest): Promise<ChangeSetApplyOutcome>;
  inspect(operationId: string): Promise<ChangeSetApplyInspection>;
}

export type DeploymentControllerResult =
  { status: "succeeded" } | { status: "failed"; reason: string } | { status: "unknown" };

/** Executes a previously persisted, authorized deployment operation. */
export interface DeploymentController {
  deploy(input: {
    operationId: string;
    changeSetHash: string;
    releaseId: string;
    permitId: string;
  }): Promise<DeploymentControllerResult>;
}

/** Independently reports the release actually running in the requested environment. */
export interface LiveReleaseObserver {
  observe(): Promise<{ releaseId: string | null; observedAt: string }>;
}

/**
 * ACS authorization adapter; it must bind the permit to this exact Change Set
 * and release. Issuance must be idempotent by operationId because a crash can
 * occur after issuance but before the PENDING operation record commits.
 */
export interface DeploymentAuthorization {
  authorize(input: {
    operationId: string;
    missionId: string;
    changeSetId: string;
    changeSetHash: string;
    releaseId: string;
    requestedBy: string;
  }): Promise<{ requestedBy: string; permitId: string }>;
}

export interface ProductionObserver {
  observe(input: { missionId: string; kind: string; expected: string }): Promise<{ observed: string }>;
}

export function admissionLaneFor(lane: OperationLane): AdmissionLane {
  return lane === "dc" ? "dc" : "jc";
}

export function admissionToolFor(lane: OperationLane): string {
  if (lane === "dc") return "list_directory";
  if (lane === "hermes") return "acs_read";
  if (lane === "coding_agent") return "read_file";
  return "jc_status";
}
