import {
  type AttemptLease,
  type ExecutionAttempt,
  type ExecutionPlanAdmission,
  type ExecutionPlanRecord,
  type RegistryAgentDetail,
  type StoredAuditEvent,
  type WorkItem
} from "@agent-control-stack/work-items";

export interface MissionControlAgent {
  id: string;
  displayName: string;
  kind: string;
  status: "online" | "observed" | "stale" | "offline";
  health: "healthy" | "warning" | "unhealthy" | "unknown";
  currentTask?: string;
  currentWorkItemId?: string;
  lastHeartbeatAt?: string;
  lastEventAt?: string;
  lastError?: string;
  capabilities: string[];
  metadata: Record<string, string>;
}

export type MissionControlAttemptLease = Omit<AttemptLease, "tokenHash">;

export function toMissionControlAttemptLease(lease: AttemptLease): MissionControlAttemptLease {
  return {
    leaseId: lease.leaseId,
    attemptId: lease.attemptId,
    workItemId: lease.workItemId,
    admissionId: lease.admissionId,
    ...(lease.approvalId ? { approvalId: lease.approvalId } : {}),
    workerId: lease.workerId,
    planHash: lease.planHash,
    inputHash: lease.inputHash,
    fencingEpoch: lease.fencingEpoch,
    protocolVersion: lease.protocolVersion,
    policyVersion: lease.policyVersion,
    policyDecisionHash: lease.policyDecisionHash,
    issuedAt: lease.issuedAt,
    expiresAt: lease.expiresAt,
    maxExpiresAt: lease.maxExpiresAt,
    lastRenewedAt: lease.lastRenewedAt,
    status: lease.status,
    ...(lease.closedAt ? { closedAt: lease.closedAt } : {})
  };
}

export interface MissionControlViewModel {
  workItems: WorkItem[];
  events: StoredAuditEvent[];
  registeredAgents?: RegistryAgentDetail[];
  agents?: MissionControlAgent[];
  /** Legacy hash-only approval options. Prefer `approvalActionsByWorkItem`, which labels each hash. */
  approvalActionHashesByWorkItem?: Record<string, string[]>;
  /** Approval options per work item: each policy-gated action hash with the action it approves. */
  approvalActionsByWorkItem?: Record<string, ApprovalActionOption[]>;
  /** Current execution plan per work item, when one has been drafted (packages/work-items getCurrentExecutionPlan). */
  executionPlansByWorkItem?: Record<string, ExecutionPlanRecord>;
  /** Current plan's admission outcome per work item, when it has been admitted (getExecutionPlanAdmission). */
  executionPlanAdmissionsByWorkItem?: Record<string, ExecutionPlanAdmission>;
  /** Persisted execution attempts for each work item. */
  executionAttemptsByWorkItem?: Record<string, ExecutionAttempt[]>;
  /** Dashboard-safe lease projections. Raw token hashes are never accepted by this view model. */
  attemptLeasesByWorkItem?: Record<string, MissionControlAttemptLease[]>;
  /** Explicit worker backend label, when the gateway knows it. Never a secret. */
  executionBackend?: string;
  /** Exact per-status counts across the store. When present, cards use these instead of counting `workItems`. */
  statusCounts?: Record<string, number>;
  /** Recent `policy.decided` events for the Policy panel. Falls back to `events` when absent. */
  policyDecisionEvents?: StoredAuditEvent[];
  /** Action kinds the composer suggests (the policy's supported kinds). */
  composerActionKinds?: string[];
  /** How long an approval may wait before it is flagged as over SLA. Defaults to 30 minutes. */
  approvalSlaMs?: number;
  /** Present when `workItems` carries only a window of finished items. */
  finishedWorkItems?: { shown: number; total: number; limit: number };
  /** Canonical execution mode. Absent when the row is missing or corrupt. */
  executionMode?: "strict" | "admin";
  executionModeProblem?: "missing" | "corrupt";
  now?: Date;
}

/** One approvable action: the policy fingerprint plus the requested action it fingerprints. */
export interface ApprovalActionOption {
  actionHash: string;
  kind: string;
  description?: string;
}

/** Header banner text while the canonical execution mode is admin. */
export const ADMIN_MODE_BANNER_TEXT = "ACS ADMIN MODE -- human approval disabled";
