import type { ActionCategory, RiskLevel, TaskEnvelope } from "./types.js";

export interface ModelRequest {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ModelCaller {
  complete(req: ModelRequest): Promise<string>;
}

export type WorkItemStatus = "pending_approval" | "approved" | "rejected" | "executed" | "unknown";

export interface CreateWorkItemInput {
  task_id: string;
  session_id: string;
  actor: string;
  title: string;
  category: ActionCategory;
  summary: string;
  risk: RiskLevel | "blocked";
  requires_approval: boolean;
  expected_action_hash: string;
  source: "moa_aggregator";
}

export interface ExecutableGrantRequest {
  work_item_id: string;
  actor: string;
  task_id: string;
  session_id: string;
  source: "moa_aggregator";
  expected_category: ActionCategory;
  expected_action_hash: string;
}

export interface ExecutableGrant {
  grant_id: string;
  lease_token: string;
  action_hash: string;
}

export interface ExecutionRequest {
  work_item_id: string;
  actor: string;
  grant_id: string;
  lease_token: string;
  expected_action_hash: string;
}

export interface AcsClient {
  createWorkItem(input: CreateWorkItemInput): Promise<{ work_item_id: string; status: WorkItemStatus }>;
  getExecutableGrant(input: ExecutableGrantRequest): Promise<ExecutableGrant>;
  requestExecution(input: ExecutionRequest): Promise<{ dispatched: boolean; reason?: string }>;
  policySummary(task: TaskEnvelope): Promise<string>;
}

export type MoaAuditType =
  | "moa_run_started"
  | "moa_advisor_completed"
  | "moa_advisor_failed"
  | "moa_aggregator_decision"
  | "moa_acs_action"
  | "moa_execution_blocked"
  | "moa_run_completed"
  | "moa_run_failed_closed";

export interface MoaAuditEvent {
  ts: string;
  type: MoaAuditType;
  task_id: string;
  session_id: string;
  origin: string;
  preset: string;
  actor: string;
  data: Record<string, unknown>;
}

export interface AuditSink {
  record(event: MoaAuditEvent): void | Promise<void>;
}

export interface Redactor {
  redact(text: string): string;
}

export interface IdempotencyStore {
  get(key: string): Promise<unknown | undefined>;
  put(key: string, value: unknown): Promise<void>;
}
