import { ControlStackError } from "@agent-control-stack/shared";

export const MISSION_STATUSES = [
  "PLANNED",
  "RUNNING",
  "WAITING_FOR_RESULT",
  "WAITING_FOR_RECONCILIATION",
  "VALIDATING",
  "READY_FOR_CHANGE_SET",
  "WAITING_FOR_APPROVAL",
  "APPROVED",
  "APPLYING",
  "VERIFYING_PRODUCTION",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "BLOCKED"
] as const;

export type MissionStatus = (typeof MISSION_STATUSES)[number];

export const OPERATION_STATUSES = [
  "PENDING",
  "READY",
  "ROUTED",
  "ADMITTED",
  "CLAIMED",
  "DISPATCHED",
  "UNKNOWN",
  "VERIFYING",
  "SUCCEEDED",
  "FAILED",
  "BLOCKED",
  "CANCELLED"
] as const;

export type OperationStatus = (typeof OPERATION_STATUSES)[number];

export const OPERATION_LANES = ["jc", "dc", "hermes", "coding_agent"] as const;
export type OperationLane = (typeof OPERATION_LANES)[number];

export const MUTATION_CLASSES = ["none", "git", "external"] as const;
export type MutationClass = (typeof MUTATION_CLASSES)[number];

export const RETRY_POLICIES = ["safe_retry", "fail_closed"] as const;
export type RetryPolicy = (typeof RETRY_POLICIES)[number];

/**
 * Legal mission edges. Same-state calls are idempotent no-ops.
 * APPROVED -> WAITING_FOR_APPROVAL is only the change-set invalidation edge:
 * a new proposed mutation drops the previous approval binding.
 */
const missionEdges: Record<MissionStatus, readonly MissionStatus[]> = {
  PLANNED: ["RUNNING", "FAILED", "CANCELLED", "BLOCKED"],
  RUNNING: [
    "WAITING_FOR_RESULT",
    "WAITING_FOR_RECONCILIATION",
    "VALIDATING",
    "READY_FOR_CHANGE_SET",
    "VERIFYING_PRODUCTION",
    "COMPLETED",
    "FAILED",
    "CANCELLED",
    "BLOCKED"
  ],
  WAITING_FOR_RESULT: ["RUNNING", "WAITING_FOR_RECONCILIATION", "VALIDATING", "FAILED", "CANCELLED", "BLOCKED"],
  WAITING_FOR_RECONCILIATION: ["RUNNING", "WAITING_FOR_RESULT", "FAILED", "BLOCKED", "CANCELLED"],
  VALIDATING: ["RUNNING", "READY_FOR_CHANGE_SET", "VERIFYING_PRODUCTION", "COMPLETED", "FAILED", "BLOCKED"],
  READY_FOR_CHANGE_SET: ["WAITING_FOR_APPROVAL", "FAILED", "BLOCKED"],
  WAITING_FOR_APPROVAL: ["APPROVED", "FAILED", "BLOCKED", "CANCELLED"],
  APPROVED: ["APPLYING", "WAITING_FOR_APPROVAL", "FAILED", "CANCELLED"],
  APPLYING: ["VERIFYING_PRODUCTION", "WAITING_FOR_RECONCILIATION", "COMPLETED", "FAILED", "BLOCKED"],
  VERIFYING_PRODUCTION: ["COMPLETED", "FAILED", "BLOCKED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  BLOCKED: ["RUNNING", "CANCELLED", "FAILED"]
};

export function assertMissionTransition(from: MissionStatus, to: MissionStatus): void {
  if (from === to) return;
  if (!missionEdges[from].includes(to)) {
    throw new ControlStackError("invalid_mission_transition", `cannot transition mission from ${from} to ${to}`);
  }
}

export interface VerificationRequirement {
  kind: string;
  expected: string;
}

export interface MissionTarget {
  repo?: string;
  system?: string;
  cwd?: string;
}

export interface OperationDraft {
  key: string;
  type: "execute" | "validate";
  lane: OperationLane;
  dependencies: string[];
  requiredCapabilities: string[];
  mutationClass: MutationClass;
  retryPolicy: RetryPolicy;
  maxAttempts?: number;
  verification: VerificationRequirement[];
}

export interface CreateMissionInput {
  intent: string;
  target: MissionTarget;
  baseRevision: string;
  requiresMutation: boolean;
  proposedMutation?: Record<string, unknown>;
  requiresDeployment: boolean;
  deploymentTarget?: string;
  requiresProductionVerification: boolean;
  productionVerification?: VerificationRequirement[];
  operations: OperationDraft[];
}

export interface OperationRecord {
  operationId: string;
  missionId: string;
  operationKey: string;
  operationType: "execute" | "validate";
  lane: OperationLane;
  requiredCapabilities: string[];
  dependencies: string[];
  mutationClass: MutationClass;
  retryPolicy: RetryPolicy;
  maxAttempts: number;
  verification: VerificationRequirement[];
  status: OperationStatus;
  executionId?: string;
  executionDispatched: boolean;
  attemptCount: number;
  claimWorkerId?: string;
  claimToken?: string;
  claimEpoch: number;
  claimExpiresAt?: string;
  routeDecision?: Record<string, unknown>;
  admissionPermitId?: string;
  result?: Record<string, unknown>;
  resultHash?: string;
  observations?: Record<string, string>;
  failureCode?: string;
  failureReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface MissionRecord {
  missionId: string;
  workItemId: string;
  intent: string;
  status: MissionStatus;
  planHash: string;
  plan: CreateMissionInput;
  target: MissionTarget;
  baseRevision: string;
  proposedMutation?: Record<string, unknown>;
  requiresMutation: boolean;
  requiresDeployment: boolean;
  deploymentTarget?: string;
  requiresProductionVerification: boolean;
  productionVerification: VerificationRequirement[];
  changeSetId?: string;
  evidenceSealHash?: string;
  failureCode?: string;
  failureReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChangeSetRecord {
  changeSetId: string;
  missionId: string;
  generation: number;
  changeSetHash: string;
  derivedFrom: Array<{ operationId: string; resultHash: string }>;
  target: MissionTarget;
  baseRevision: string;
  proposedMutation: Record<string, unknown>;
  validationEvidence: Array<{ operationId: string; kind: string; outcome: string; evidenceRef?: string }>;
  artifactHashes: string[];
  approvalRequired: boolean;
  status: string;
  createdAt: string;
}

export interface ApprovalBinding {
  approvalId: string;
  missionId: string;
  workItemId: string;
  changeSetId: string;
  changeSetHash: string;
  decision: "approved" | "rejected";
  approverId: string;
  requestHash?: string;
  createdAt: string;
}

export interface ApplicationRecord {
  missionId: string;
  changeSetId: string;
  changeSetHash: string;
  status: "not_started" | "started" | "succeeded" | "failed" | "unknown";
  idempotencyKey: string;
  expectedBaseRevision: string;
  observedRevision?: string;
  reason?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface DeploymentRecord {
  missionId: string;
  target: string;
  expectedRevision: string;
  status: "not_started" | "started" | "succeeded" | "failed" | "unknown";
  attemptCount: number;
  observedVersion?: string;
  restartStatus?: string;
  healthStatus?: string;
  reason?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface VerificationRecord {
  verificationId: string;
  missionId: string;
  operationId: string;
  stage: "operation" | "production";
  kind: string;
  expectedCondition: string;
  observedResult?: string;
  evidenceRef?: string;
  outcome: "passed" | "failed" | "unsupported";
  createdAt: string;
}

export interface MissionEventRecord {
  eventId: string;
  missionId: string;
  operationId?: string;
  name: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  previousHash: string;
  eventHash: string;
  createdAt: string;
}

export interface MissionSnapshot {
  mission: MissionRecord;
  operations: OperationRecord[];
  events: MissionEventRecord[];
  changeSets: ChangeSetRecord[];
  approvals: ApprovalBinding[];
  application?: ApplicationRecord;
  deployment?: DeploymentRecord;
  verifications: VerificationRecord[];
}

export interface ClaimResult {
  claimed: boolean;
  operation: OperationRecord;
}

export const TERMINAL_MISSION_STATUSES = new Set<MissionStatus>(["COMPLETED", "FAILED", "CANCELLED"]);
