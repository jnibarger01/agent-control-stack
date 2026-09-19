import type {
  AttemptLease,
  ConnectorSummary,
  ExecutionAttempt,
  RegistryAgentDetail,
  StoredAuditEvent,
  WorkItem
} from "@agent-control-stack/work-items";

/** Contract types come from the ACS packages; nothing is redeclared here. */
export type { ConnectorSummary, ExecutionAttempt, RegistryAgentDetail, StoredAuditEvent, WorkItem };
export type WorkItemStatus = WorkItem["status"];
export type WorkItemRisk = WorkItem["risk"];

/** Dashboard-safe lease projection: the token hash never crosses the wire. */
export type SafeLease = Omit<AttemptLease, "tokenHash">;

export interface WorkItemDetailResponse {
  workItem: WorkItem;
  events: StoredAuditEvent[];
  executionAttempts: ExecutionAttempt[];
  attemptLeases: SafeLease[];
}

export type RegistryAgentView = RegistryAgentDetail & {
  effectiveStatus: RegistryAgentDetail["status"];
  heartbeatAgeMs: number | null;
  isStale: boolean;
};

export interface RegistryCapability {
  name: string;
  description?: string;
  [key: string]: unknown;
}

export interface AgentDetailResponse {
  agent: RegistryAgentView;
  adapterStatus?: unknown;
  events: StoredAuditEvent[];
}

/** Audit-derived actor projection from GET /agents (registry + connector/tunnel/worker events). */
export interface ProjectedActor {
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

export interface HealthCheck {
  ok: boolean;
  code?: string;
  [key: string]: unknown;
}

export interface HealthResponse {
  ok: boolean;
  checks: Record<string, HealthCheck>;
}

export interface LivezResponse {
  ok: boolean;
  status: string;
}

export interface PolicyExplainResult {
  actionHash: string;
  decision: "allow" | "deny" | "require_approval";
  reason: string;
  matchedRules: string[];
  requiredApprover?: "user";
  maxRuntimeMs?: number;
  allowedPaths?: string[];
  context: Record<string, unknown>;
}

export interface PolicyExplainInput {
  workItemId: string;
  actor: string;
  operation: string;
  requester: string;
  risk: WorkItemRisk;
  action: { kind: string; description: string; params?: Record<string, unknown> };
  cwd?: string;
  paths?: string[];
  command?: string[];
  network?: boolean;
  write?: boolean;
  destructive?: boolean;
}

export interface ApprovalResult {
  decision: { decision: "allow" | "deny" | "require_approval"; reason: string; matchedRules: string[] };
  workItem: WorkItem;
  approvals: Array<{ approvalId?: string; actionHash: string }>;
}

export interface UnblockResult {
  decision: { decision: "allow" | "deny" | "require_approval"; reason: string; matchedRules: string[] };
  workItem: WorkItem;
}

export interface ConnectorRegistrationBody {
  id: string;
  displayName?: string;
  publicKeyPem: string;
  allowedScopes: string[];
}

export interface TunnelSessionBody {
  tunnelId: string;
  sessionId: string;
  expiresAt: string;
  issuedAt?: string;
}

/** Sanitized identity of the signed-in caller from GET /session. Never a token or scope list. */
export interface SessionInfo {
  actor: string;
  actorId: string | null;
  roles: string[];
}
