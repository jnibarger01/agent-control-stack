import type { AdmissionLane } from "@agent-control-stack/execution-admission";
import type { OperationLane } from "./types.js";

export interface DispatchRequest {
  missionId: string;
  operationId: string;
  executionId: string;
  lane: OperationLane;
  attempt: number;
  operationType: "execute" | "validate";
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

export interface DeploymentRequest {
  missionId: string;
  target: string;
  expectedRevision: string;
  attempt: number;
}

export type DeploymentOutcome = {
  kind: "observed" | "failed" | "unknown";
  exitCode?: number;
  observedVersion?: string;
  restartStatus?: string;
  health?: "pass" | "fail";
  healthDetail?: string;
  reason?: string;
};

export interface DeploymentExecutor {
  deploy(input: DeploymentRequest): Promise<DeploymentOutcome>;
  inspect(missionId: string): Promise<DeploymentOutcome | { kind: "not_started" }>;
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
