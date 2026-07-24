import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ControlStackError,
  applyControlPlaneMigrations,
  auditEventHash,
  createId,
  createEvent,
  inspectControlPlaneDatabase,
  redactValue,
  stableHash,
  verifyAuditChain,
  type AuditChainEvent,
  type AuditChainVerification,
  type AuditEvent
} from "@agent-control-stack/shared";
import { assertCanTransitionExecutionAttempt, transitionWorkItem } from "./state-machine.js";
import {
  cancelRequestSchema,
  createWorkItem,
  listWorkItemsSchema,
  rejectRequestSchema,
  workItemCreatedEvent,
  workItemSchema,
  workItemStatusEvent,
  type ClaimedWorkItem,
  type Requester,
  type ResultOutcome,
  type WorkItem,
  type WorkItemRisk,
  type WorkItemStatus
} from "./work-item.js";
import {
  DEFAULT_HEARTBEAT_TTL_MS,
  isHeartbeatExpired,
  validateHeartbeatTtl,
  type LivenessReconciliationOptions
} from "./liveness.js";
import {
  EXECUTION_ATTEMPT_CLAIM_SCHEMA_VERSION,
  WORKER_PROTOCOL_VERSION,
  admitExecutionPlanInputSchema,
  claimExecutionAttemptInputSchema,
  createExecutionPlanInputSchema,
  executionAttemptClaimSchema,
  executionAttemptRecordSchema,
  executionAttemptInputHash,
  executionPlanAdmissionHash,
  executionPlanAdmissionSchema,
  executionPlanApprovalBindingHash,
  executionPlanApprovalSchema,
  executionPlanHash,
  executionPlanRecordSchema,
  executionPlanSubjectInputHash,
  recordExecutionPlanApprovalInputSchema,
  reacquireExecutionAttemptLeaseInputSchema,
  renewExecutionAttemptLeaseInputSchema,
  retryExecutionAttemptInputSchema,
  startExecutionAttemptInputSchema,
  transitionExecutionAttemptInputSchema,
  verifyExecutionAttemptClaimInputSchema,
  type AdmitExecutionPlanInput,
  type ClaimExecutionAttemptInput,
  type CreateExecutionPlanInput,
  type ExecutionAttemptClaim,
  type ExecutionAttemptRecord,
  type ExecutionPlanAdmission,
  type ExecutionPlanApproval,
  type ExecutionPlanRecord,
  type RecordExecutionPlanApprovalInput,
  type ReacquireExecutionAttemptLeaseInput,
  type RenewExecutionAttemptLeaseInput,
  type RetryExecutionAttemptInput,
  type StartExecutionAttemptInput,
  type TransitionExecutionAttemptInput,
  type VerifyExecutionAttemptClaimInput
} from "./execution-plan.js";

interface WorkItemRow {
  id: string;
  title: string;
  requester: Requester;
  requester_subject: string | null;
  status: WorkItemStatus;
  intent: string;
  target_json: string;
  requested_actions_json: string;
  risk: WorkItemRisk;
  result_json: string | null;
  worker_id: string | null;
  started_at: string | null;
  lease_expires_at: string | null;
  lease_token_hash: string | null;
  source_work_item_id: string | null;
  lineage_type: "retry" | "clone" | null;
  retry_reason: string | null;
  retry_sequence: number;
  root_work_item_id: string | null;
  created_at: string;
  updated_at: string;
}

interface ExecutionResultRow {
  result_id: string;
  work_item_id: string;
  lease_id: string;
  worker_id: string;
  idempotency_key: string;
  action_hash: string;
  outcome: ResultOutcome;
  started_at: string;
  finished_at: string;
  exit_code: number | null;
  summary: string;
  stdout: string | null;
  stderr: string | null;
  structured_output_json: string;
  artifacts_json: string;
  error: string | null;
  resource_usage_json: string | null;
  simulation_metadata_json: string;
  payload_hash: string;
  created_at: string;
}

interface ExecutionPlanRow {
  plan_id: string;
  work_item_id: string;
  plan_number: number;
  schema_version: "acs.execution-plan.v1";
  definition_json: string;
  plan_hash: string;
  subject_input_hash: string;
  created_by_actor_id: string;
  created_at: string;
}

interface ExecutionPlanHeadRow {
  work_item_id: string;
  plan_id: string;
  plan_hash: string;
  plan_number: number;
  updated_at: string;
}

interface ExecutionPlanAdmissionRow {
  admission_id: string;
  work_item_id: string;
  plan_id: string;
  plan_hash: string;
  admission_hash: string;
  policy_version: string;
  policy_decision_hash: string;
  decision: "allow" | "require_approval";
  required_approval_action_hashes_json: string;
  admitted_by_actor_id: string;
  admitted_at: string;
}

interface ExecutionPlanApprovalRow {
  approval_id: string;
  work_item_id: string;
  plan_id: string;
  plan_hash: string;
  admission_id: string;
  admission_hash: string;
  policy_version: string;
  action_hash: string;
  approval_binding_hash: string;
  approved_by_actor_id: string;
  reason: string;
  status: "granted" | "consumed" | "expired" | "revoked";
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
}

interface ExecutionAttemptRow {
  attempt_id: string;
  work_item_id: string;
  attempt_number: number;
  protocol_version: "acs.worker.v2";
  plan_id: string;
  plan_hash: string;
  admission_id: string;
  admission_hash: string;
  input_hash: string;
  worker_id: string;
  fencing_epoch: number;
  status: "leased" | "unknown" | "quarantined";
  created_at: string;
  claimed_at: string;
  started_at: string | null;
}

interface AttemptLeaseRow {
  lease_id: string;
  attempt_id: string;
  work_item_id: string;
  worker_id: string;
  protocol_version: "acs.worker.v2";
  plan_id: string;
  plan_hash: string;
  admission_id: string;
  admission_hash: string;
  input_hash: string;
  token_hash: string;
  fencing_epoch: number;
  issued_at: string;
  expires_at: string;
  status: "active" | "consumed" | "expired" | "revoked";
  closed_at: string | null;
}

export type StoredAuditEvent = AuditChainEvent;
export const DEFAULT_EVENT_LIMIT = 100;
export const MAX_EVENT_LIMIT = 500;

export interface ReadEventsOptions {
  limit?: number;
  afterSequence?: number;
  workItemId?: string;
  agentId?: string;
}

export type HealthCheck = { ok: true } | { ok: false; code: string };

export interface StoreHealth {
  ok: boolean;
  checks: {
    read: HealthCheck;
    write: HealthCheck;
    integrity: HealthCheck;
    foreignKeys: HealthCheck;
    migrations: HealthCheck;
    auditChain: HealthCheck;
    liveness: HealthCheck;
  };
}

interface EventRow {
  sequence: number;
  id: string;
  name: string;
  time_unix_nano: string;
  attributes: string;
  body: string;
  previous_hash: string;
  event_hash: string;
}

interface ConnectorRow {
  id: string;
  display_name: string;
  public_key_pem: string;
  allowed_scopes_json: string;
  status: "active" | "revoked";
  created_at: string;
  updated_at: string;
}

export const acpRoles = [
  "IMPLEMENTATION_AGENT",
  "REVIEW_PLANNING_AGENT",
  "RESEARCH_BROAD_SCAN_AGENT",
  "LOCAL_CODING_AGENT",
  "ORCHESTRATION_LAYER",
  "DESKTOP_LOCAL_AGENT_BRIDGE"
] as const;
export const registryStatuses = ["UNKNOWN", "AVAILABLE", "BUSY", "DEGRADED", "OFFLINE", "ERROR"] as const;
export const actorTypes = ["HUMAN", "SYSTEM", "AGENT", "SERVICE"] as const;

export type AcpRole = (typeof acpRoles)[number];
export type RegistryStatus = (typeof registryStatuses)[number];
export type ActorType = (typeof actorTypes)[number];

interface ActorRow {
  id: string;
  actor_type: ActorType;
  display_name: string;
  external_ref: string | null;
  created_at: string;
}

interface AgentRow {
  id: string;
  name: string;
  kind: string;
  acp_role: AcpRole;
  provider: string | null;
  model: string | null;
  endpoint: string | null;
  status: RegistryStatus;
  last_heartbeat_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  created_by_actor_id: string;
  updated_by_actor_id: string;
}

interface CapabilityRow {
  id: string;
  agent_id: string;
  name: string;
  description: string | null;
  input_schema: string | null;
  created_at: string;
  updated_at: string;
  created_by_actor_id: string;
  updated_by_actor_id: string;
}

interface HeartbeatRow {
  id: number;
  agent_id: string;
  status: RegistryStatus;
  current_task: string | null;
  last_error: string | null;
  observed_at: string;
  actor_id: string;
}

interface TunnelSessionRow {
  connector_id: string;
  tunnel_id: string;
  session_id: string;
  status: "active" | "revoked";
  issued_at: string;
  expires_at: string;
  last_heartbeat_at: string | null;
  created_at: string;
  updated_at: string;
}

interface TunnelSessionJoinRow extends TunnelSessionRow {
  public_key_pem: string;
  allowed_scopes_json: string;
  connector_status: "active" | "revoked";
}

export interface PolicyDecisionRecord {
  workItemId: string;
  actionHash: string;
  decision: "allow" | "deny" | "require_approval";
  reason: string;
  matchedRules: string[];
  context: Record<string, unknown>;
  requiredApprover?: "user";
  maxRuntimeMs?: number;
  allowedPaths?: string[];
}

export interface ApprovalRecord {
  workItemId: string;
  actionHash: string;
  approvedBy: string;
  reason?: string;
  createdAt?: string;
  expiresAt?: string;
  expiresInMs?: number;
  requestHash?: string;
}

export interface ApprovalGrant {
  workItemId: string;
  actionHash: string;
  requestHash: string;
  expiresAt: string;
  status: "granted";
  event: StoredAuditEvent;
}

export interface ConnectorRequestRecord {
  workItemId?: string;
  actor: string;
  source: string;
  route: string;
  toolName: string;
  requestId?: string;
  authMethod?: string;
  authSubject?: string;
  authIssuer?: string;
  authConnectorId?: string;
  authTunnelId?: string;
  authSessionId?: string;
  authScopes?: string[];
}

export const acpTimelineEventTypes = [
  "initialized",
  "message",
  "plan",
  "tool_call_proposed",
  "diff",
  "error",
  "stop",
  "client_method_rejected",
  "disconnected"
] as const;

export type AcpTimelineEventType = (typeof acpTimelineEventTypes)[number];

export interface AgentTimelineEventRecord {
  agentId: string;
  actorId: string;
  eventType: AcpTimelineEventType;
  method?: string;
  messageId?: string;
  sessionId?: string;
  workItemId?: string;
  body?: Record<string, unknown>;
}

export interface ConnectorRegistration {
  id: string;
  displayName?: string;
  publicKeyPem: string;
  allowedScopes: string[];
  actorId: string;
  now?: Date;
}

export interface ConnectorKeyRotation {
  id: string;
  publicKeyPem: string;
  reason: string;
  actorId: string;
  now?: Date;
}

export interface RegisteredConnector {
  id: string;
  displayName: string;
  publicKeyPem: string;
  allowedScopes: string[];
  status: "active" | "revoked";
  createdAt: string;
  updatedAt: string;
}

export interface ActorRegistration {
  id: string;
  actorType: ActorType;
  displayName: string;
  externalRef?: string;
  registeredByActorId?: string;
  now?: Date;
}

export interface RegistryActor extends Omit<ActorRegistration, "now" | "registeredByActorId"> {
  createdAt: string;
}

export interface RegistryAgentInput {
  id: string;
  name: string;
  kind: string;
  acpRole: AcpRole;
  provider?: string;
  model?: string;
  endpoint?: string;
  status?: RegistryStatus;
  lastError?: string;
  actorId: string;
  now?: Date;
}

export interface RegistryAgentUpdate {
  name?: string;
  kind?: string;
  acpRole?: AcpRole;
  provider?: string | null;
  model?: string | null;
  endpoint?: string | null;
  status?: RegistryStatus;
  lastError?: string | null;
  actorId: string;
  now?: Date;
}

export interface RegistryCapabilityInput {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface RegistryCapability {
  id: string;
  agentId: string;
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  createdByActorId: string;
  updatedByActorId: string;
}

export interface RegistryHeartbeatInput {
  status: RegistryStatus;
  currentTask?: string;
  lastError?: string;
  actorId: string;
  now?: Date;
}

export interface RegistryHeartbeat {
  id: number;
  agentId: string;
  status: RegistryStatus;
  currentTask?: string;
  lastError?: string;
  observedAt: string;
  actorId: string;
}

export interface RegistryAgent {
  id: string;
  name: string;
  kind: string;
  acpRole: AcpRole;
  provider?: string;
  model?: string;
  endpoint?: string;
  status: RegistryStatus;
  lastHeartbeatAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  createdByActorId: string;
  updatedByActorId: string;
}

export interface RegistryAgentDetail extends RegistryAgent {
  capabilities: RegistryCapability[];
  latestHeartbeat?: RegistryHeartbeat;
}

export interface TunnelSessionRegistration {
  connectorId: string;
  tunnelId: string;
  sessionId: string;
  issuedAt?: string;
  expiresAt: string;
  actorId: string;
  now?: Date;
}

export interface TunnelSessionRef {
  connectorId: string;
  tunnelId: string;
  sessionId: string;
  actorId?: string;
  now?: Date;
}

export interface RegisteredTunnelSession {
  connectorId: string;
  tunnelId: string;
  sessionId: string;
  status: "active" | "revoked";
  issuedAt: string;
  expiresAt: string;
  lastHeartbeatAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TunnelSessionAuthorizationRecord extends RegisteredTunnelSession {
  publicKeyPem: string;
  scopes: string[];
  connectorStatus: "active" | "revoked";
}

export interface ConsumeApprovalOptions {
  now?: Date;
  requestHash?: string;
}

export interface ClaimOptions {
  leaseMs?: number;
  allowDirectStartForTests?: true;
}

export interface StoredExecutionResult {
  resultId: string;
  workItemId: string;
  leaseId: string;
  workerId: string;
  idempotencyKey: string;
  actionHash: string;
  outcome: ResultOutcome;
  startedAt: string;
  finishedAt: string;
  exitCode?: number | null;
  summary: string;
  stdout?: string;
  stderr?: string;
  structuredOutput: Record<string, unknown>;
  artifacts: Array<Record<string, unknown>>;
  error?: string;
  resourceUsage?: Record<string, unknown>;
  simulationMetadata: Record<string, unknown>;
  payloadHash: string;
  createdAt: string;
}

export interface PrivilegedTransitionOptions {
  via: "policy_gate" | "domain_service";
}

export interface SqliteWorkItemStoreOptions {
  leaseMs?: number;
  heartbeatTtlMs?: number;
  onEvent?: (event: StoredAuditEvent) => void;
}

export interface WorkItemStore {
  withTransaction<T>(operation: () => T): T;
  create(input: unknown): WorkItem;
  get(id: string): WorkItem | undefined;
  list(input?: unknown): WorkItem[];
  createExecutionPlan(input: CreateExecutionPlanInput): ExecutionPlanRecord;
  getExecutionPlan(planId: string): ExecutionPlanRecord | undefined;
  getCurrentExecutionPlan(workItemId: string): ExecutionPlanRecord | undefined;
  listExecutionPlans(workItemId: string): ExecutionPlanRecord[];
  admitExecutionPlan(input: AdmitExecutionPlanInput, options: PrivilegedTransitionOptions): ExecutionPlanAdmission;
  getExecutionPlanAdmission(admissionId: string): ExecutionPlanAdmission | undefined;
  getCurrentExecutionPlanAdmission(workItemId: string): ExecutionPlanAdmission | undefined;
  recordExecutionPlanApproval(
    input: RecordExecutionPlanApprovalInput,
    options: PrivilegedTransitionOptions
  ): ExecutionPlanApproval;
  getExecutionPlanApproval(approvalId: string): ExecutionPlanApproval | undefined;
  getExecutionAttempt(attemptId: string): ExecutionAttemptRecord | undefined;
  listExecutionAttempts(workItemId: string): ExecutionAttemptRecord[];
  claimExecutionAttempt(input: ClaimExecutionAttemptInput): ExecutionAttemptClaim;
  retryExecutionAttempt(input: RetryExecutionAttemptInput): ExecutionAttemptClaim;
  renewExecutionAttemptLease(input: RenewExecutionAttemptLeaseInput): ExecutionAttemptClaim;
  reacquireExecutionAttemptLease(input: ReacquireExecutionAttemptLeaseInput): ExecutionAttemptClaim;
  startExecutionAttempt(input: StartExecutionAttemptInput): ExecutionAttemptRecord;
  transitionExecutionAttempt(
    input: TransitionExecutionAttemptInput,
    options?: PrivilegedTransitionOptions
  ): ExecutionAttemptRecord;
  verifyExecutionAttemptClaim(input: VerifyExecutionAttemptClaimInput): ExecutionAttemptClaim;
  readEvents(options?: ReadEventsOptions): StoredAuditEvent[];
  health(): StoreHealth;
  verifyAuditChain(): AuditChainVerification;
  transition(id: string, status: WorkItemStatus, options?: PrivilegedTransitionOptions): WorkItem;
  approveWorkItem(id: string, options?: PrivilegedTransitionOptions): WorkItem;
  blockWorkItem(id: string): WorkItem;
  unblockWorkItem(id: string, options?: PrivilegedTransitionOptions): WorkItem;
  cancelWorkItem(id: string, input?: unknown, options?: PrivilegedTransitionOptions): WorkItem;
  rejectWorkItem(id: string, input?: unknown, options?: PrivilegedTransitionOptions): WorkItem;
  registerConnector(input: ConnectorRegistration): RegisteredConnector;
  rotateConnectorKey(input: ConnectorKeyRotation): RegisteredConnector;
  registerActor(input: ActorRegistration): RegistryActor;
  listActors(): RegistryActor[];
  resolveActorId(candidates: string[]): string | undefined;
  createRegistryAgent(input: RegistryAgentInput): RegistryAgentDetail;
  updateRegistryAgent(id: string, input: RegistryAgentUpdate): RegistryAgentDetail;
  listRegistryAgents(): RegistryAgentDetail[];
  getRegistryAgent(id: string): RegistryAgentDetail | undefined;
  replaceAgentCapabilities(
    agentId: string,
    capabilities: RegistryCapabilityInput[],
    actorId: string
  ): RegistryCapability[];
  listAgentCapabilities(agentId: string): RegistryCapability[];
  recordAgentHeartbeat(
    agentId: string,
    input: RegistryHeartbeatInput
  ): { agent: RegistryAgentDetail; heartbeat: RegistryHeartbeat };
  reconcileStaleAgents(options?: LivenessReconciliationOptions): RegistryAgentDetail[];
  registerTunnelSession(input: TunnelSessionRegistration): RegisteredTunnelSession;
  heartbeatTunnelSession(input: TunnelSessionRef): RegisteredTunnelSession;
  revokeTunnelSession(input: TunnelSessionRef): RegisteredTunnelSession;
  reconcileStaleTunnelSessions(options?: LivenessReconciliationOptions): RegisteredTunnelSession[];
  getTunnelSession(input: TunnelSessionRef): TunnelSessionAuthorizationRecord | undefined;
  recordConnectorRequest(input: ConnectorRequestRecord): StoredAuditEvent;
  recordAgentTimelineEvent(input: AgentTimelineEventRecord): StoredAuditEvent;
  recordPolicyDecision(input: PolicyDecisionRecord): StoredAuditEvent;
  recordApproval(input: ApprovalRecord): ApprovalGrant;
  hasApproval(workItemId: string, actionHash: string): boolean;
  consumeApproval(workItemId: string, actionHash: string, options?: Date | ConsumeApprovalOptions): StoredAuditEvent;
  startWorkItem(id: string, workerId?: string, options?: ClaimOptions): ClaimedWorkItem;
  claimNextApprovedWorkItem(workerId: string, options?: ClaimOptions): ClaimedWorkItem | undefined;
  failExpiredLeases(now?: Date): WorkItem[];
  submitWorkResult(input: unknown): WorkItem;
  recordDerivedWorkResult(input: unknown): WorkItem;
  getExecutionResult(resultId: string): StoredExecutionResult | undefined;
  getExecutionResultForIdempotency(workerId: string, idempotencyKey: string): StoredExecutionResult | undefined;
  retryWorkItem(id: string, input: RetryWorkItemInput): WorkItem;
  cloneWorkItem(id: string, input: CloneWorkItemInput): WorkItem;
}

export interface RetryWorkItemInput {
  reason: string;
  actor: string;
}

export interface CloneWorkItemInput {
  actor: string;
  title?: string;
  intent?: string;
  target?: Record<string, unknown>;
  requestedActions?: Array<{ kind: string; description: string; params?: Record<string, unknown> }>;
  risk?: WorkItemRisk;
}

export class SqliteWorkItemStore implements WorkItemStore {
  private readonly db: DatabaseSync;
  private readonly leaseMs: number;
  private readonly heartbeatTtlMs: number;
  private readonly onEvent: (event: StoredAuditEvent) => void;
  private transactionDepth = 0;
  private pendingEvents: StoredAuditEvent[] = [];
  private auditChainValid = true;

  constructor(dbPath: string, options: SqliteWorkItemStoreOptions = {}) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.leaseMs = options.leaseMs ?? 5 * 60 * 1000;
    this.heartbeatTtlMs = validateHeartbeatTtl(options.heartbeatTtlMs ?? DEFAULT_HEARTBEAT_TTL_MS);
    this.onEvent = options.onEvent ?? (() => undefined);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
    `);
    try {
      applyControlPlaneMigrations(this.db);
      this.backfillAuditChain();
      this.auditChainValid = this.verifyAuditChain().ok;
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  create(input: unknown): WorkItem {
    const workItem = createWorkItem(input);
    return this.write(() => {
      this.db
        .prepare(
          `INSERT INTO work_items
           (id, title, requester, requester_subject, status, intent, target_json, requested_actions_json, risk, result_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
        )
        .run(
          workItem.id,
          workItem.title,
          workItem.requester,
          workItem.requesterSubject ?? null,
          workItem.status,
          workItem.intent,
          JSON.stringify(workItem.target),
          JSON.stringify(workItem.requestedActions),
          workItem.risk,
          workItem.createdAt,
          workItem.updatedAt
        );
      return { value: workItem, events: [this.appendAuditEvent(workItemCreatedEvent(workItem))] };
    });
  }

  get(id: string): WorkItem | undefined {
    const row = this.db.prepare(`SELECT * FROM work_items WHERE id = ?`).get(id) as unknown as WorkItemRow | undefined;
    return row ? rowToWorkItem(row) : undefined;
  }

  list(input: unknown = {}): WorkItem[] {
    const filter = listWorkItemsSchema.parse(input);
    const rows = filter.status
      ? (this.db
          .prepare(`SELECT * FROM work_items WHERE status = ? ORDER BY created_at DESC`)
          .all(filter.status) as unknown as WorkItemRow[])
      : (this.db.prepare(`SELECT * FROM work_items ORDER BY created_at DESC`).all() as unknown as WorkItemRow[]);
    return rows.map(rowToWorkItem);
  }

  createExecutionPlan(input: CreateExecutionPlanInput): ExecutionPlanRecord {
    const parsed = createExecutionPlanInputSchema.parse(input);
    const planHash = executionPlanHash(parsed.definition);
    const now = (parsed.now ?? new Date()).toISOString();

    return this.write(() => {
      const workItem = this.getRequired(parsed.workItemId);
      if (parsed.definition.workItemId !== workItem.id) {
        throw new ControlStackError(
          "execution_plan_work_item_mismatch",
          "execution plan work item does not match the target work item"
        );
      }
      const subjectInputHash = executionPlanSubjectInputHash(workItem);
      if (parsed.definition.subjectInputHash !== subjectInputHash) {
        throw new ControlStackError(
          "execution_plan_input_mismatch",
          "execution plan is not bound to the current work item inputs"
        );
      }

      const current = this.db
        .prepare(`SELECT * FROM execution_plan_heads WHERE work_item_id = ?`)
        .get(workItem.id) as unknown as ExecutionPlanHeadRow | undefined;
      if (current?.plan_hash === planHash) {
        const existing = this.getExecutionPlan(current.plan_id);
        if (!existing) {
          throw new ControlStackError("execution_plan_state_invalid", "current execution plan cannot be resolved");
        }
        return { value: existing, events: [] };
      }
      if (current && parsed.expectedCurrentPlanHash !== current.plan_hash) {
        throw new ControlStackError(
          "execution_plan_conflict",
          "current execution plan changed or an expected plan hash was not supplied"
        );
      }
      if (!current && parsed.expectedCurrentPlanHash !== undefined) {
        throw new ControlStackError(
          "execution_plan_conflict",
          "expected execution plan hash was supplied before an initial plan existed"
        );
      }
      const activeAttempt = this.db
        .prepare(
          `SELECT attempt_id FROM execution_attempts
           WHERE work_item_id = ? AND status = 'leased'
           LIMIT 1`
        )
        .get(workItem.id) as { attempt_id: string } | undefined;
      if (activeAttempt) {
        throw new ControlStackError("execution_plan_in_use", "execution plan cannot change while an attempt is active");
      }

      const planNumber = (current?.plan_number ?? 0) + 1;
      const planId = createId("plan");
      this.db
        .prepare(
          `INSERT INTO execution_plans
           (plan_id, work_item_id, plan_number, schema_version, definition_json, plan_hash,
            subject_input_hash, created_by_actor_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          planId,
          workItem.id,
          planNumber,
          parsed.definition.schemaVersion,
          JSON.stringify(parsed.definition),
          planHash,
          subjectInputHash,
          parsed.createdByActorId,
          now
        );

      if (current) {
        const changed = this.db
          .prepare(
            `UPDATE execution_plan_heads
             SET plan_id = ?, plan_hash = ?, plan_number = ?, updated_at = ?
             WHERE work_item_id = ? AND plan_hash = ? AND plan_number = ?`
          )
          .run(planId, planHash, planNumber, now, workItem.id, current.plan_hash, current.plan_number);
        if (changed.changes !== 1) {
          throw new ControlStackError("execution_plan_conflict", "current execution plan changed concurrently");
        }
      } else {
        this.db
          .prepare(
            `INSERT INTO execution_plan_heads
             (work_item_id, plan_id, plan_hash, plan_number, updated_at)
             VALUES (?, ?, ?, ?, ?)`
          )
          .run(workItem.id, planId, planHash, planNumber, now);
      }

      const record = executionPlanRecordSchema.parse({
        planId,
        workItemId: workItem.id,
        planNumber,
        definition: parsed.definition,
        planHash,
        subjectInputHash,
        createdByActorId: parsed.createdByActorId,
        createdAt: now
      });
      const event = this.appendAuditEvent(
        createEvent(
          "execution_plan.created",
          {
            planId,
            workItemId: workItem.id,
            planNumber,
            planHash,
            subjectInputHash,
            replacedPlanHash: current?.plan_hash,
            createdByActorId: parsed.createdByActorId
          },
          {
            "work_item.id": workItem.id,
            "plan.id": planId,
            "plan.hash": planHash,
            "plan.number": String(planNumber),
            "actor.id": parsed.createdByActorId
          }
        )
      );
      return { value: record, events: [event] };
    });
  }

  getExecutionPlan(planId: string): ExecutionPlanRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM execution_plans WHERE plan_id = ?`).get(planId) as unknown as
      ExecutionPlanRow | undefined;
    return row ? rowToExecutionPlan(row) : undefined;
  }

  getCurrentExecutionPlan(workItemId: string): ExecutionPlanRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT plans.*
         FROM execution_plan_heads AS heads
         JOIN execution_plans AS plans
           ON plans.plan_id = heads.plan_id
          AND plans.work_item_id = heads.work_item_id
          AND plans.plan_hash = heads.plan_hash
          AND plans.plan_number = heads.plan_number
         WHERE heads.work_item_id = ?`
      )
      .get(workItemId) as unknown as ExecutionPlanRow | undefined;
    if (!row) return undefined;
    const record = rowToExecutionPlan(row);
    const workItem = this.getRequired(workItemId);
    if (record.subjectInputHash !== executionPlanSubjectInputHash(workItem)) {
      throw new ControlStackError(
        "execution_plan_integrity_failed",
        "current execution plan subject no longer matches the work item"
      );
    }
    return record;
  }

  listExecutionPlans(workItemId: string): ExecutionPlanRecord[] {
    return (
      this.db
        .prepare(`SELECT * FROM execution_plans WHERE work_item_id = ? ORDER BY plan_number ASC`)
        .all(workItemId) as unknown as ExecutionPlanRow[]
    ).map(rowToExecutionPlan);
  }

  admitExecutionPlan(input: AdmitExecutionPlanInput, options: PrivilegedTransitionOptions): ExecutionPlanAdmission {
    requirePrivilegedTransition(options, "policy_gate");
    if (options.via !== "policy_gate") {
      throw new ControlStackError("policy_gate_required", "execution plan admission requires the policy gate");
    }
    const parsed = admitExecutionPlanInputSchema.parse(input);
    const requiredApprovalActionHashes = [...parsed.requiredApprovalActionHashes].sort();

    return this.write(() => {
      const current = this.getCurrentExecutionPlan(parsed.workItemId);
      if (!current || current.planHash !== parsed.planHash) {
        throw new ControlStackError("execution_plan_not_current", "only the current execution plan can be admitted");
      }
      const existing = this.db
        .prepare(
          `SELECT * FROM execution_plan_admissions
           WHERE plan_id = ? AND policy_version = ? AND policy_decision_hash = ?`
        )
        .get(current.planId, parsed.policyVersion, parsed.policyDecisionHash) as unknown as
        ExecutionPlanAdmissionRow | undefined;
      if (existing) {
        const admission = rowToExecutionPlanAdmission(existing);
        const head = this.getCurrentExecutionPlanAdmission(current.workItemId);
        if (head?.admissionId !== admission.admissionId) {
          throw new ControlStackError(
            "execution_plan_admission_stale",
            "a superseded admission cannot become current again"
          );
        }
        return { value: admission, events: [] };
      }

      const admissionId = createId("admission");
      const admittedAt = (parsed.now ?? new Date()).toISOString();
      const admissionHash = executionPlanAdmissionHash({
        workItemId: current.workItemId,
        planId: current.planId,
        planHash: current.planHash,
        policyVersion: parsed.policyVersion,
        policyDecisionHash: parsed.policyDecisionHash,
        decision: parsed.decision,
        requiredApprovalActionHashes
      });
      this.db
        .prepare(
          `INSERT INTO execution_plan_admissions
           (admission_id, work_item_id, plan_id, plan_hash, admission_hash, policy_version,
            policy_decision_hash, decision, required_approval_action_hashes_json,
            admitted_by_actor_id, admitted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          admissionId,
          current.workItemId,
          current.planId,
          current.planHash,
          admissionHash,
          parsed.policyVersion,
          parsed.policyDecisionHash,
          parsed.decision,
          JSON.stringify(requiredApprovalActionHashes),
          parsed.admittedByActorId,
          admittedAt
        );
      this.db
        .prepare(
          `INSERT INTO execution_plan_admission_heads
           (work_item_id, admission_id, admission_hash, plan_id, plan_hash, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(work_item_id) DO UPDATE SET
             admission_id = excluded.admission_id,
             admission_hash = excluded.admission_hash,
             plan_id = excluded.plan_id,
             plan_hash = excluded.plan_hash,
             updated_at = excluded.updated_at`
        )
        .run(current.workItemId, admissionId, admissionHash, current.planId, current.planHash, admittedAt);
      const admission = executionPlanAdmissionSchema.parse({
        admissionId,
        workItemId: current.workItemId,
        planId: current.planId,
        planHash: current.planHash,
        admissionHash,
        policyVersion: parsed.policyVersion,
        policyDecisionHash: parsed.policyDecisionHash,
        decision: parsed.decision,
        requiredApprovalActionHashes,
        admittedByActorId: parsed.admittedByActorId,
        admittedAt
      });
      const event = this.appendAuditEvent(
        createEvent("execution_plan.admitted", admission, {
          "work_item.id": current.workItemId,
          "plan.id": current.planId,
          "plan.hash": current.planHash,
          "admission.id": admissionId,
          "admission.hash": admissionHash,
          "policy.version": parsed.policyVersion,
          "policy.decision_hash": parsed.policyDecisionHash,
          "actor.id": parsed.admittedByActorId
        })
      );
      return { value: admission, events: [event] };
    });
  }

  getExecutionPlanAdmission(admissionId: string): ExecutionPlanAdmission | undefined {
    const row = this.db
      .prepare(`SELECT * FROM execution_plan_admissions WHERE admission_id = ?`)
      .get(admissionId) as unknown as ExecutionPlanAdmissionRow | undefined;
    return row ? rowToExecutionPlanAdmission(row) : undefined;
  }

  getCurrentExecutionPlanAdmission(workItemId: string): ExecutionPlanAdmission | undefined {
    const row = this.db
      .prepare(
        `SELECT admissions.*
         FROM execution_plan_admission_heads AS heads
         JOIN execution_plan_admissions AS admissions
           ON admissions.admission_id = heads.admission_id
          AND admissions.work_item_id = heads.work_item_id
          AND admissions.admission_hash = heads.admission_hash
          AND admissions.plan_id = heads.plan_id
          AND admissions.plan_hash = heads.plan_hash
         JOIN execution_plan_heads AS plan_heads
           ON plan_heads.work_item_id = heads.work_item_id
          AND plan_heads.plan_id = heads.plan_id
          AND plan_heads.plan_hash = heads.plan_hash
         WHERE heads.work_item_id = ?`
      )
      .get(workItemId) as unknown as ExecutionPlanAdmissionRow | undefined;
    return row ? rowToExecutionPlanAdmission(row) : undefined;
  }

  recordExecutionPlanApproval(
    input: RecordExecutionPlanApprovalInput,
    options: PrivilegedTransitionOptions
  ): ExecutionPlanApproval {
    requirePrivilegedTransition(options, "policy_gate");
    if (options.via !== "policy_gate") {
      throw new ControlStackError("policy_gate_required", "execution plan approval requires the policy gate");
    }
    const parsed = recordExecutionPlanApprovalInputSchema.parse(input);

    return this.write(() => {
      const plan = this.getCurrentExecutionPlan(parsed.workItemId);
      const admission = this.getCurrentExecutionPlanAdmission(parsed.workItemId);
      if (!plan || plan.planHash !== parsed.planHash) {
        throw new ControlStackError("execution_plan_not_current", "approval does not match the current plan");
      }
      if (
        !admission ||
        admission.admissionHash !== parsed.admissionHash ||
        admission.planId !== plan.planId ||
        admission.policyVersion !== parsed.policyVersion
      ) {
        throw new ControlStackError(
          "execution_plan_approval_binding_mismatch",
          "approval does not match the current admission and policy version"
        );
      }
      if (
        admission.decision !== "require_approval" ||
        !admission.requiredApprovalActionHashes.includes(parsed.actionHash)
      ) {
        throw new ControlStackError(
          "execution_plan_approval_not_requested",
          "approval action was not required by the current admission"
        );
      }
      const createdAt = (parsed.now ?? new Date()).toISOString();
      if (Date.parse(parsed.expiresAt) <= Date.parse(createdAt)) {
        throw new ControlStackError("execution_plan_approval_expired", "approval expiry must be in the future");
      }
      const existing = this.db
        .prepare(`SELECT * FROM execution_plan_approvals WHERE admission_id = ? AND action_hash = ?`)
        .get(admission.admissionId, parsed.actionHash) as unknown as ExecutionPlanApprovalRow | undefined;
      if (existing) {
        const approval = rowToExecutionPlanApproval(existing);
        if (approval.status !== "granted") {
          throw new ControlStackError(
            "execution_plan_approval_already_used",
            "execution plan approval cannot be regranted"
          );
        }
        return { value: approval, events: [] };
      }

      const approvalId = createId("approval");
      const approvalBindingHash = executionPlanApprovalBindingHash({
        workItemId: plan.workItemId,
        planId: plan.planId,
        planHash: plan.planHash,
        admissionId: admission.admissionId,
        admissionHash: admission.admissionHash,
        policyVersion: admission.policyVersion,
        actionHash: parsed.actionHash
      });
      this.db
        .prepare(
          `INSERT INTO execution_plan_approvals
           (approval_id, work_item_id, plan_id, plan_hash, admission_id, admission_hash,
            policy_version, action_hash, approval_binding_hash, approved_by_actor_id, reason,
            status, created_at, expires_at, consumed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'granted', ?, ?, NULL)`
        )
        .run(
          approvalId,
          plan.workItemId,
          plan.planId,
          plan.planHash,
          admission.admissionId,
          admission.admissionHash,
          admission.policyVersion,
          parsed.actionHash,
          approvalBindingHash,
          parsed.approvedByActorId,
          parsed.reason,
          createdAt,
          parsed.expiresAt
        );
      const approval = executionPlanApprovalSchema.parse({
        approvalId,
        workItemId: plan.workItemId,
        planId: plan.planId,
        planHash: plan.planHash,
        admissionId: admission.admissionId,
        admissionHash: admission.admissionHash,
        policyVersion: admission.policyVersion,
        actionHash: parsed.actionHash,
        approvalBindingHash,
        approvedByActorId: parsed.approvedByActorId,
        reason: parsed.reason,
        status: "granted",
        createdAt,
        expiresAt: parsed.expiresAt
      });
      const event = this.appendAuditEvent(
        createEvent("execution_plan.approval_granted", approval, {
          "work_item.id": plan.workItemId,
          "plan.id": plan.planId,
          "plan.hash": plan.planHash,
          "admission.id": admission.admissionId,
          "admission.hash": admission.admissionHash,
          "approval.id": approvalId,
          "action.hash": parsed.actionHash,
          "policy.version": admission.policyVersion,
          "actor.id": parsed.approvedByActorId
        })
      );
      return { value: approval, events: [event] };
    });
  }

  getExecutionPlanApproval(approvalId: string): ExecutionPlanApproval | undefined {
    const row = this.db
      .prepare(`SELECT * FROM execution_plan_approvals WHERE approval_id = ?`)
      .get(approvalId) as unknown as ExecutionPlanApprovalRow | undefined;
    return row ? rowToExecutionPlanApproval(row) : undefined;
  }

  getExecutionAttempt(attemptId: string): ExecutionAttemptRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM execution_attempts WHERE attempt_id = ?`).get(attemptId) as unknown as
      ExecutionAttemptRow | undefined;
    return row ? this.readExecutionAttempt(row) : undefined;
  }

  listExecutionAttempts(workItemId: string): ExecutionAttemptRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM execution_attempts WHERE work_item_id = ? ORDER BY attempt_number ASC`)
      .all(workItemId) as unknown as ExecutionAttemptRow[];
    return rows.map((row) => this.readExecutionAttempt(row));
  }

  retryExecutionAttempt(input: RetryExecutionAttemptInput): ExecutionAttemptClaim {
    const parsed = retryExecutionAttemptInputSchema.parse(input);
    const latestRow = this.db
      .prepare(`SELECT * FROM execution_attempts WHERE work_item_id = ? ORDER BY attempt_number DESC LIMIT 1`)
      .get(parsed.workItemId) as unknown as ExecutionAttemptRow | undefined;
    const latest = latestRow ? this.getExecutionAttempt(latestRow.attempt_id) : undefined;
    if (!latest || latest.attemptId !== parsed.attemptId) {
      throw new ControlStackError("execution_attempt_retry_not_latest", "only the latest attempt may be retried");
    }
    if (latest.status === "leased") {
      throw new ControlStackError("execution_attempt_retry_not_eligible", "leased attempts cannot be retried");
    }
    const { attemptId: _attemptId, ...claimInput } = parsed;
    return this.claimExecutionAttemptInternal(claimInput, true);
  }

  renewExecutionAttemptLease(input: RenewExecutionAttemptLeaseInput): ExecutionAttemptClaim {
    assertWorkerProtocol((input as { protocolVersion?: unknown }).protocolVersion);
    const parsed = renewExecutionAttemptLeaseInputSchema.parse(input);
    return this.write(() => {
      const now = parsed.now ?? new Date();
      const current = this.assertExecutionAttemptLeaseClaim(parsed, now, ["leased"]);
      const leaseMs = parsed.leaseMs ?? this.leaseMs;
      const expiresAt = new Date(now.getTime() + leaseMs).toISOString();
      const result = this.db
        .prepare(
          `UPDATE attempt_leases SET expires_at = ?
           WHERE lease_id = ? AND attempt_id = ? AND worker_id = ? AND fencing_epoch = ?
             AND status = 'active' AND expires_at > ?`
        )
        .run(expiresAt, parsed.leaseId, parsed.attemptId, parsed.workerId, parsed.fencingEpoch, now.toISOString());
      if (result.changes !== 1) {
        throw new ControlStackError("execution_attempt_lease_conflict", "attempt lease changed or expired");
      }
      const event = this.appendAuditEvent(
        createEvent(
          "attempt_lease.renewed",
          {
            attemptId: current.attempt_id,
            workItemId: current.work_item_id,
            leaseId: parsed.leaseId,
            workerId: current.worker_id,
            fencingEpoch: current.fencing_epoch,
            renewedAt: now.toISOString(),
            expiresAt
          },
          {
            "work_item.id": current.work_item_id,
            "attempt.id": current.attempt_id,
            "lease.id": parsed.leaseId,
            "worker.id": current.worker_id,
            "lease.epoch": String(current.fencing_epoch)
          }
        )
      );
      const { leaseMs: _leaseMs, now: _now, ...claimFields } = parsed;
      return { value: executionAttemptClaimSchema.parse({ ...claimFields, expiresAt }), events: [event] };
    });
  }

  reacquireExecutionAttemptLease(input: ReacquireExecutionAttemptLeaseInput): ExecutionAttemptClaim {
    assertWorkerProtocol((input as { protocolVersion?: unknown }).protocolVersion);
    const parsed = reacquireExecutionAttemptLeaseInputSchema.parse(input);
    return this.write(() => {
      const now = parsed.now ?? new Date();
      const attempt = this.db
        .prepare(`SELECT * FROM execution_attempts WHERE attempt_id = ?`)
        .get(parsed.attemptId) as unknown as ExecutionAttemptRow | undefined;
      const oldLease = this.db
        .prepare(`SELECT * FROM attempt_leases WHERE attempt_id = ? AND status = 'active'`)
        .get(parsed.attemptId) as unknown as AttemptLeaseRow | undefined;
      if (
        !attempt ||
        !oldLease ||
        attempt.worker_id !== oldLease.worker_id ||
        attempt.status !== "leased" ||
        Date.parse(oldLease.expires_at) > now.getTime()
      ) {
        throw new ControlStackError(
          "execution_attempt_reacquire_denied",
          "only an expired leased attempt may be reacquired"
        );
      }
      const epoch = attempt.fencing_epoch + 1;
      const issuedAt = now.toISOString();
      const expiresAt = new Date(now.getTime() + (parsed.leaseMs ?? this.leaseMs)).toISOString();
      this.db
        .prepare(`UPDATE attempt_leases SET status = 'expired', closed_at = ? WHERE lease_id = ? AND status = 'active'`)
        .run(issuedAt, oldLease.lease_id);
      this.db
        .prepare(
          `UPDATE execution_attempts SET fencing_epoch = ?, worker_id = ? WHERE attempt_id = ? AND fencing_epoch = ?`
        )
        .run(epoch, parsed.workerId, attempt.attempt_id, attempt.fencing_epoch);
      const leaseId = createId("alease");
      const leaseToken = createLeaseToken();
      const tokenHash = hashAttemptLeaseToken({
        attemptId: attempt.attempt_id,
        leaseId,
        workerId: parsed.workerId,
        fencingEpoch: epoch,
        leaseToken
      });
      this.db
        .prepare(
          `INSERT INTO attempt_leases
        (lease_id, attempt_id, work_item_id, worker_id, protocol_version, plan_id, plan_hash, admission_id, admission_hash, input_hash, token_hash, fencing_epoch, issued_at, expires_at, status, closed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL)`
        )
        .run(
          leaseId,
          attempt.attempt_id,
          attempt.work_item_id,
          parsed.workerId,
          attempt.protocol_version,
          attempt.plan_id,
          attempt.plan_hash,
          attempt.admission_id,
          attempt.admission_hash,
          attempt.input_hash,
          tokenHash,
          epoch,
          issuedAt,
          expiresAt
        );
      const event = this.appendAuditEvent(
        createEvent(
          "attempt_lease.reacquired",
          {
            attemptId: attempt.attempt_id,
            workItemId: attempt.work_item_id,
            leaseId,
            workerId: parsed.workerId,
            fencingEpoch: epoch,
            issuedAt,
            expiresAt
          },
          {
            "work_item.id": attempt.work_item_id,
            "attempt.id": attempt.attempt_id,
            "lease.id": leaseId,
            "worker.id": parsed.workerId,
            "lease.epoch": String(epoch)
          }
        )
      );
      return {
        value: executionAttemptClaimSchema.parse({
          schemaVersion: EXECUTION_ATTEMPT_CLAIM_SCHEMA_VERSION,
          protocolVersion: attempt.protocol_version,
          attemptId: attempt.attempt_id,
          attemptNumber: attempt.attempt_number,
          workItemId: attempt.work_item_id,
          planId: attempt.plan_id,
          planHash: attempt.plan_hash,
          admissionId: attempt.admission_id,
          admissionHash: attempt.admission_hash,
          inputHash: attempt.input_hash,
          workerId: parsed.workerId,
          leaseId,
          leaseToken,
          fencingEpoch: epoch,
          issuedAt,
          expiresAt
        }),
        events: [event]
      };
    });
  }

  startExecutionAttempt(input: StartExecutionAttemptInput): ExecutionAttemptRecord {
    assertWorkerProtocol((input as { protocolVersion?: unknown }).protocolVersion);
    const parsed = startExecutionAttemptInputSchema.parse(input);
    return this.write(() => {
      const now = parsed.now ?? new Date();
      const current = this.assertExecutionAttemptLeaseClaim(parsed, now, ["leased"]);
      if (current.started_at)
        throw new ControlStackError("execution_attempt_already_started", "attempt was already started");
      const result = this.db
        .prepare(
          `UPDATE execution_attempts SET started_at = ? WHERE attempt_id = ? AND fencing_epoch = ? AND started_at IS NULL`
        )
        .run(now.toISOString(), parsed.attemptId, parsed.fencingEpoch);
      if (result.changes !== 1)
        throw new ControlStackError("execution_attempt_conflict", "attempt changed while starting");
      const updated = this.getExecutionAttempt(parsed.attemptId);
      if (!updated) throw new ControlStackError("execution_attempt_integrity_failed", "started attempt cannot be read");
      const event = this.appendAuditEvent(
        createEvent(
          "execution_attempt.started",
          {
            attemptId: updated.attemptId,
            workItemId: updated.workItemId,
            workerId: updated.workerId,
            fencingEpoch: updated.fencingEpoch,
            startedAt: now.toISOString()
          },
          {
            "work_item.id": updated.workItemId,
            "attempt.id": updated.attemptId,
            "worker.id": updated.workerId,
            "lease.epoch": String(updated.fencingEpoch)
          }
        )
      );
      return { value: updated, events: [event] };
    });
  }

  private assertExecutionAttemptLeaseClaim(
    parsed: VerifyExecutionAttemptClaimInput,
    now: Date,
    allowedStatuses: readonly ExecutionAttemptRow["status"][]
  ): ExecutionAttemptRow {
    const attempt = this.db
      .prepare(`SELECT * FROM execution_attempts WHERE attempt_id = ?`)
      .get(parsed.attemptId) as unknown as ExecutionAttemptRow | undefined;
    const lease = this.db.prepare(`SELECT * FROM attempt_leases WHERE lease_id = ?`).get(parsed.leaseId) as unknown as
      AttemptLeaseRow | undefined;
    if (!attempt || !lease || !allowedStatuses.includes(attempt.status) || lease.status !== "active")
      throw new ControlStackError("execution_attempt_lease_stale", "attempt lease is missing or no longer active");
    if (
      attempt.work_item_id !== parsed.workItemId ||
      attempt.plan_id !== parsed.planId ||
      attempt.plan_hash !== parsed.planHash ||
      attempt.admission_id !== parsed.admissionId ||
      attempt.admission_hash !== parsed.admissionHash ||
      attempt.input_hash !== parsed.inputHash ||
      attempt.worker_id !== parsed.workerId ||
      attempt.fencing_epoch !== parsed.fencingEpoch ||
      lease.attempt_id !== parsed.attemptId ||
      lease.worker_id !== parsed.workerId ||
      lease.fencing_epoch !== parsed.fencingEpoch
    )
      throw new ControlStackError(
        "execution_attempt_fencing_mismatch",
        "attempt lease authority is stale or mismatched"
      );
    if (
      lease.token_hash !==
      hashAttemptLeaseToken({
        attemptId: attempt.attempt_id,
        leaseId: lease.lease_id,
        workerId: attempt.worker_id,
        fencingEpoch: attempt.fencing_epoch,
        leaseToken: parsed.leaseToken
      })
    )
      throw new ControlStackError("execution_attempt_fencing_mismatch", "attempt lease token is stale or invalid");
    if (Date.parse(lease.expires_at) <= now.getTime())
      throw new ControlStackError("execution_attempt_lease_expired", "attempt lease has expired");
    const plan = this.getCurrentExecutionPlan(attempt.work_item_id);
    const admission = this.getCurrentExecutionPlanAdmission(attempt.work_item_id);
    const workItem = this.getRequired(attempt.work_item_id);
    if (
      !plan ||
      !admission ||
      plan.planId !== attempt.plan_id ||
      plan.planHash !== attempt.plan_hash ||
      admission.admissionId !== attempt.admission_id ||
      admission.admissionHash !== attempt.admission_hash
    )
      throw new ControlStackError("execution_attempt_integrity_failed", "attempt authority is no longer current");
    const approvalBindingHashes =
      admission.decision === "require_approval"
        ? (
            this.db
              .prepare(
                `SELECT * FROM execution_plan_approvals
                 WHERE admission_id = ? AND admission_hash = ?
                 ORDER BY action_hash ASC`
              )
              .all(admission.admissionId, admission.admissionHash) as unknown as ExecutionPlanApprovalRow[]
          ).map((row) => rowToExecutionPlanApproval(row).approvalBindingHash)
        : [];
    const expectedInputHash = executionAttemptInputHash({
      workItemId: workItem.id,
      planId: plan.planId,
      planHash: plan.planHash,
      admissionId: admission.admissionId,
      admissionHash: admission.admissionHash,
      subjectInputHash: executionPlanSubjectInputHash(workItem),
      policyVersion: admission.policyVersion,
      policyDecisionHash: admission.policyDecisionHash,
      approvalBindingHashes
    });
    if (expectedInputHash !== attempt.input_hash)
      throw new ControlStackError("execution_attempt_integrity_failed", "attempt input integrity check failed");
    return attempt;
  }

  transitionExecutionAttempt(
    input: TransitionExecutionAttemptInput,
    options?: PrivilegedTransitionOptions
  ): ExecutionAttemptRecord {
    requirePrivilegedTransition(options, "execution attempt");
    const parsed = transitionExecutionAttemptInputSchema.parse(input);
    return this.write(() => {
      const current = this.getExecutionAttempt(parsed.attemptId);
      if (!current) {
        throw new ControlStackError("execution_attempt_not_found", `execution attempt not found: ${parsed.attemptId}`);
      }
      assertCanTransitionExecutionAttempt(current.status, parsed.status);
      const now = (parsed.now ?? new Date()).toISOString();
      const result = this.db
        .prepare(`UPDATE execution_attempts SET status = ? WHERE attempt_id = ? AND status = ?`)
        .run(parsed.status, parsed.attemptId, current.status);
      if (result.changes !== 1) {
        throw new ControlStackError("execution_attempt_conflict", "execution attempt changed while transitioning");
      }
      const updated = this.getExecutionAttempt(parsed.attemptId);
      if (!updated) {
        throw new ControlStackError("execution_attempt_integrity_failed", "transitioned attempt cannot be read");
      }
      const event = this.appendAuditEvent(
        createEvent(
          "execution_attempt.transitioned",
          {
            attemptId: updated.attemptId,
            workItemId: updated.workItemId,
            attemptNumber: updated.attemptNumber,
            from: current.status,
            to: updated.status,
            actorId: parsed.actorId,
            reason: parsed.reason,
            transitionedAt: now
          },
          {
            "work_item.id": updated.workItemId,
            "attempt.id": updated.attemptId,
            "attempt.number": String(updated.attemptNumber),
            "attempt.from": current.status,
            "attempt.to": updated.status,
            "actor.id": parsed.actorId
          }
        )
      );
      return { value: updated, events: [event] };
    });
  }

  claimExecutionAttempt(input: ClaimExecutionAttemptInput): ExecutionAttemptClaim {
    return this.claimExecutionAttemptInternal(input, false);
  }

  private claimExecutionAttemptInternal(input: ClaimExecutionAttemptInput, retry: boolean): ExecutionAttemptClaim {
    assertWorkerProtocol((input as { protocolVersion?: unknown }).protocolVersion);
    const parsed = claimExecutionAttemptInputSchema.parse(input);

    return this.write(() => {
      const workItem = this.getRequired(parsed.workItemId);
      if (workItem.status !== "approved") {
        throw new ControlStackError("execution_attempt_not_approved", "work item is not approved for an attempt");
      }
      const plan = this.getCurrentExecutionPlan(workItem.id);
      const admission = this.getCurrentExecutionPlanAdmission(workItem.id);
      if (!plan || plan.planId !== parsed.planId || plan.planHash !== parsed.planHash) {
        throw new ControlStackError("execution_attempt_plan_mismatch", "attempt claim does not match the current plan");
      }
      if (
        !admission ||
        admission.admissionId !== parsed.admissionId ||
        admission.admissionHash !== parsed.admissionHash ||
        admission.planId !== plan.planId ||
        admission.planHash !== plan.planHash
      ) {
        throw new ControlStackError(
          "execution_attempt_admission_mismatch",
          "attempt claim does not match the current admission"
        );
      }
      const active = this.db
        .prepare(
          `SELECT attempt_id FROM execution_attempts
           WHERE work_item_id = ? AND status = 'leased'
           LIMIT 1`
        )
        .get(workItem.id) as { attempt_id: string } | undefined;
      if (active) {
        throw new ControlStackError("execution_attempt_claim_conflict", "work item already has an active attempt");
      }
      const previous = this.db
        .prepare(`SELECT attempt_id FROM execution_attempts WHERE work_item_id = ? LIMIT 1`)
        .get(workItem.id) as { attempt_id: string } | undefined;
      if (previous && !retry) {
        throw new ControlStackError(
          "execution_attempt_retry_required",
          "a work item with historical attempts must use the explicit retry operation"
        );
      }

      const now = parsed.now ?? new Date();
      const issuedAt = now.toISOString();
      const expiresAt = new Date(now.getTime() + (parsed.leaseMs ?? this.leaseMs)).toISOString();
      const attemptNumberRow = this.db
        .prepare(`SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next FROM execution_attempts WHERE work_item_id = ?`)
        .get(workItem.id) as { next: number };
      const attemptNumber = attemptNumberRow.next;
      const attemptId = createId("attempt");
      const leaseId = createId("alease");
      const leaseToken = createLeaseToken();
      const fencingEpoch = 1;
      const tokenHash = hashAttemptLeaseToken({
        attemptId,
        leaseId,
        workerId: parsed.workerId,
        fencingEpoch,
        leaseToken
      });
      const allApprovals =
        admission.decision === "require_approval"
          ? (
              this.db
                .prepare(
                  `SELECT * FROM execution_plan_approvals
                   WHERE admission_id = ? AND admission_hash = ?
                   ORDER BY action_hash ASC`
                )
                .all(admission.admissionId, admission.admissionHash) as unknown as ExecutionPlanApprovalRow[]
            ).map(rowToExecutionPlanApproval)
          : [];
      const approvals = allApprovals.filter((approval) => approval.status === "granted");
      const expectedInputHash = executionAttemptInputHash({
        workItemId: workItem.id,
        planId: plan.planId,
        planHash: plan.planHash,
        admissionId: admission.admissionId,
        admissionHash: admission.admissionHash,
        subjectInputHash: executionPlanSubjectInputHash(workItem),
        policyVersion: admission.policyVersion,
        policyDecisionHash: admission.policyDecisionHash,
        approvalBindingHashes: allApprovals.map((approval) => approval.approvalBindingHash)
      });
      if (parsed.inputHash !== expectedInputHash) {
        throw new ControlStackError("execution_attempt_input_mismatch", "attempt input hash is invalid or stale");
      }
      if (
        admission.decision === "require_approval" &&
        approvals.some((approval) => approval.approvedByActorId === parsed.workerId)
      ) {
        throw new ControlStackError(
          "execution_attempt_self_approval",
          "a worker cannot claim an attempt using its own approval"
        );
      }
      if (
        admission.decision === "require_approval" &&
        (approvals.length !== admission.requiredApprovalActionHashes.length ||
          approvals.some(
            (approval) =>
              approval.workItemId !== workItem.id ||
              approval.planId !== plan.planId ||
              approval.planHash !== plan.planHash ||
              approval.admissionId !== admission.admissionId ||
              approval.admissionHash !== admission.admissionHash ||
              !admission.requiredApprovalActionHashes.includes(approval.actionHash) ||
              approval.policyVersion !== admission.policyVersion ||
              Date.parse(approval.expiresAt) <= now.getTime()
          ))
      ) {
        throw new ControlStackError(
          "execution_attempt_approval_missing",
          "current plan approvals are missing, expired, or mismatched"
        );
      }

      this.db
        .prepare(
          `INSERT INTO execution_attempts
           (attempt_id, work_item_id, attempt_number, protocol_version, plan_id, plan_hash,
            admission_id, admission_hash, input_hash, worker_id, fencing_epoch, status,
            created_at, claimed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'leased', ?, ?)`
        )
        .run(
          attemptId,
          workItem.id,
          attemptNumber,
          WORKER_PROTOCOL_VERSION,
          plan.planId,
          plan.planHash,
          admission.admissionId,
          admission.admissionHash,
          expectedInputHash,
          parsed.workerId,
          fencingEpoch,
          issuedAt,
          issuedAt
        );
      this.db
        .prepare(
          `INSERT INTO attempt_leases
           (lease_id, attempt_id, work_item_id, worker_id, protocol_version, plan_id, plan_hash,
            admission_id, admission_hash, input_hash, token_hash, fencing_epoch, issued_at,
            expires_at, status, closed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL)`
        )
        .run(
          leaseId,
          attemptId,
          workItem.id,
          parsed.workerId,
          WORKER_PROTOCOL_VERSION,
          plan.planId,
          plan.planHash,
          admission.admissionId,
          admission.admissionHash,
          expectedInputHash,
          tokenHash,
          fencingEpoch,
          issuedAt,
          expiresAt
        );

      const claim = executionAttemptClaimSchema.parse({
        schemaVersion: EXECUTION_ATTEMPT_CLAIM_SCHEMA_VERSION,
        protocolVersion: WORKER_PROTOCOL_VERSION,
        attemptId,
        attemptNumber,
        workItemId: workItem.id,
        planId: plan.planId,
        planHash: plan.planHash,
        admissionId: admission.admissionId,
        admissionHash: admission.admissionHash,
        inputHash: expectedInputHash,
        workerId: parsed.workerId,
        leaseId,
        leaseToken,
        fencingEpoch,
        issuedAt,
        expiresAt
      });
      const events = approvals.map((approval) =>
        this.appendAuditEvent(
          createEvent(
            "execution_plan.approval_consumed",
            {
              approvalId: approval.approvalId,
              workItemId: workItem.id,
              planId: plan.planId,
              admissionId: admission.admissionId,
              actionHash: approval.actionHash,
              attemptId,
              leaseId,
              consumedAt: issuedAt
            },
            {
              "work_item.id": workItem.id,
              "plan.id": plan.planId,
              "admission.id": admission.admissionId,
              "approval.id": approval.approvalId,
              "action.hash": approval.actionHash,
              "attempt.id": attemptId,
              "lease.id": leaseId
            }
          )
        )
      );
      events.push(
        this.appendAuditEvent(
          createEvent(
            "execution_attempt.created",
            {
              attemptId,
              attemptNumber,
              workItemId: workItem.id,
              protocolVersion: WORKER_PROTOCOL_VERSION,
              planId: plan.planId,
              planHash: plan.planHash,
              admissionId: admission.admissionId,
              admissionHash: admission.admissionHash,
              inputHash: expectedInputHash,
              workerId: parsed.workerId,
              fencingEpoch
            },
            {
              "work_item.id": workItem.id,
              "attempt.id": attemptId,
              "attempt.number": String(attemptNumber),
              "plan.id": plan.planId,
              "plan.hash": plan.planHash,
              "admission.id": admission.admissionId,
              "admission.hash": admission.admissionHash,
              "worker.id": parsed.workerId,
              "lease.epoch": String(fencingEpoch)
            }
          )
        ),
        this.appendAuditEvent(
          createEvent(
            "attempt_lease.granted",
            {
              attemptId,
              workItemId: workItem.id,
              leaseId,
              workerId: parsed.workerId,
              protocolVersion: WORKER_PROTOCOL_VERSION,
              fencingEpoch,
              issuedAt,
              expiresAt
            },
            {
              "work_item.id": workItem.id,
              "attempt.id": attemptId,
              "lease.id": leaseId,
              "worker.id": parsed.workerId,
              "lease.epoch": String(fencingEpoch)
            }
          )
        )
      );
      return { value: claim, events };
    });
  }

  private readExecutionAttempt(row: ExecutionAttemptRow): ExecutionAttemptRecord {
    const record = rowToExecutionAttempt(row);
    const plan = this.getExecutionPlan(record.planId);
    const admission = this.getExecutionPlanAdmission(record.admissionId);
    const workItem = this.get(record.workItemId);
    if (!plan || !admission || !workItem) {
      throw new ControlStackError("execution_attempt_integrity_failed", "execution attempt authority is missing");
    }
    const approvalBindingHashes =
      admission.decision === "require_approval"
        ? (
            this.db
              .prepare(
                `SELECT * FROM execution_plan_approvals
                 WHERE admission_id = ? AND admission_hash = ?
                 ORDER BY action_hash ASC`
              )
              .all(admission.admissionId, admission.admissionHash) as unknown as ExecutionPlanApprovalRow[]
          ).map((approval) => rowToExecutionPlanApproval(approval).approvalBindingHash)
        : [];
    const expectedInputHash = executionAttemptInputHash({
      workItemId: workItem.id,
      planId: plan.planId,
      planHash: plan.planHash,
      admissionId: admission.admissionId,
      admissionHash: admission.admissionHash,
      subjectInputHash: executionPlanSubjectInputHash(workItem),
      policyVersion: admission.policyVersion,
      policyDecisionHash: admission.policyDecisionHash,
      approvalBindingHashes
    });
    if (
      record.planHash !== plan.planHash ||
      record.admissionHash !== admission.admissionHash ||
      record.inputHash !== expectedInputHash
    ) {
      throw new ControlStackError(
        "execution_attempt_integrity_failed",
        "execution attempt input integrity check failed"
      );
    }
    return record;
  }

  verifyExecutionAttemptClaim(input: VerifyExecutionAttemptClaimInput): ExecutionAttemptClaim {
    assertWorkerProtocol((input as { protocolVersion?: unknown }).protocolVersion);
    const parsed = verifyExecutionAttemptClaimInputSchema.parse(input);
    const attempt = this.db
      .prepare(`SELECT * FROM execution_attempts WHERE attempt_id = ?`)
      .get(parsed.attemptId) as unknown as ExecutionAttemptRow | undefined;
    const lease = this.db.prepare(`SELECT * FROM attempt_leases WHERE lease_id = ?`).get(parsed.leaseId) as unknown as
      AttemptLeaseRow | undefined;
    if (!attempt || !lease || attempt.status !== "leased" || lease.status !== "active") {
      throw new ControlStackError("execution_attempt_lease_stale", "attempt lease is missing or no longer active");
    }
    if (
      attempt.work_item_id !== parsed.workItemId ||
      attempt.plan_id !== parsed.planId ||
      attempt.plan_hash !== parsed.planHash ||
      attempt.admission_id !== parsed.admissionId ||
      attempt.admission_hash !== parsed.admissionHash ||
      attempt.input_hash !== parsed.inputHash ||
      attempt.worker_id !== parsed.workerId ||
      attempt.fencing_epoch !== parsed.fencingEpoch ||
      lease.attempt_id !== parsed.attemptId ||
      lease.work_item_id !== parsed.workItemId ||
      lease.plan_id !== parsed.planId ||
      lease.plan_hash !== parsed.planHash ||
      lease.admission_id !== parsed.admissionId ||
      lease.admission_hash !== parsed.admissionHash ||
      lease.input_hash !== parsed.inputHash ||
      lease.worker_id !== parsed.workerId ||
      lease.fencing_epoch !== parsed.fencingEpoch
    ) {
      throw new ControlStackError(
        "execution_attempt_fencing_mismatch",
        "attempt worker, lease, plan, admission, input, or fencing value is stale"
      );
    }
    const expectedTokenHash = hashAttemptLeaseToken({
      attemptId: attempt.attempt_id,
      leaseId: lease.lease_id,
      workerId: attempt.worker_id,
      fencingEpoch: attempt.fencing_epoch,
      leaseToken: parsed.leaseToken
    });
    if (lease.token_hash !== expectedTokenHash) {
      throw new ControlStackError("execution_attempt_fencing_mismatch", "attempt lease token is stale or invalid");
    }
    const now = parsed.now ?? new Date();
    if (Date.parse(lease.expires_at) <= now.getTime()) {
      throw new ControlStackError("execution_attempt_lease_expired", "attempt lease has expired");
    }
    const plan = this.getCurrentExecutionPlan(attempt.work_item_id);
    const admission = this.getCurrentExecutionPlanAdmission(attempt.work_item_id);
    const workItem = this.getRequired(attempt.work_item_id);
    if (
      !plan ||
      !admission ||
      plan.planId !== attempt.plan_id ||
      plan.planHash !== attempt.plan_hash ||
      admission.admissionId !== attempt.admission_id ||
      admission.admissionHash !== attempt.admission_hash
    ) {
      throw new ControlStackError("execution_attempt_integrity_failed", "attempt authority is no longer current");
    }
    const expectedInputHash = executionAttemptInputHash({
      workItemId: workItem.id,
      planId: plan.planId,
      planHash: plan.planHash,
      admissionId: admission.admissionId,
      admissionHash: admission.admissionHash,
      subjectInputHash: executionPlanSubjectInputHash(workItem),
      policyVersion: admission.policyVersion,
      policyDecisionHash: admission.policyDecisionHash,
      approvalBindingHashes: (admission.decision === "require_approval"
        ? (
            this.db
              .prepare(
                `SELECT * FROM execution_plan_approvals
                 WHERE admission_id = ? AND admission_hash = ?
                 ORDER BY action_hash ASC`
              )
              .all(admission.admissionId, admission.admissionHash) as unknown as ExecutionPlanApprovalRow[]
          ).map(rowToExecutionPlanApproval)
        : []
      ).map((approval) => approval.approvalBindingHash)
    });
    if (expectedInputHash !== attempt.input_hash) {
      throw new ControlStackError("execution_attempt_integrity_failed", "attempt input integrity check failed");
    }
    return executionAttemptClaimSchema.parse({
      schemaVersion: EXECUTION_ATTEMPT_CLAIM_SCHEMA_VERSION,
      protocolVersion: WORKER_PROTOCOL_VERSION,
      attemptId: attempt.attempt_id,
      attemptNumber: attempt.attempt_number,
      workItemId: attempt.work_item_id,
      planId: attempt.plan_id,
      planHash: attempt.plan_hash,
      admissionId: attempt.admission_id,
      admissionHash: attempt.admission_hash,
      inputHash: attempt.input_hash,
      workerId: attempt.worker_id,
      leaseId: lease.lease_id,
      leaseToken: parsed.leaseToken,
      fencingEpoch: attempt.fencing_epoch,
      issuedAt: lease.issued_at,
      expiresAt: lease.expires_at
    });
  }

  readEvents(options: ReadEventsOptions = {}): StoredAuditEvent[] {
    const limit = normalizeEventLimit(options.limit);
    const where: string[] = [];
    const params: Array<number | string> = [];

    if (options.afterSequence !== undefined) {
      if (!Number.isInteger(options.afterSequence) || options.afterSequence < 0) {
        throw new ControlStackError("invalid_event_query", "afterSequence must be a non-negative integer");
      }
      where.push("sequence > ?");
      params.push(options.afterSequence);
    }
    if (options.workItemId) {
      where.push(`json_extract(attributes, '$."work_item.id"') = ?`);
      params.push(options.workItemId);
    }
    if (options.agentId) {
      where.push(
        `(
          json_extract(attributes, '$."agent.id"') = ?
          OR json_extract(attributes, '$."worker.id"') = ?
          OR json_extract(attributes, '$."connector.id"') = ?
          OR json_extract(attributes, '$."auth.connector_id"') = ?
        )`
      );
      params.push(options.agentId, options.agentId, options.agentId, options.agentId);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    if (options.afterSequence !== undefined) {
      return (
        this.db
          .prepare(`SELECT * FROM audit_events ${whereSql} ORDER BY sequence ASC LIMIT ?`)
          .all(...params, limit) as unknown as EventRow[]
      ).map(rowToEvent);
    }
    return (
      this.db
        .prepare(
          `SELECT * FROM (SELECT * FROM audit_events ${whereSql} ORDER BY sequence DESC LIMIT ?) ORDER BY sequence ASC`
        )
        .all(...params, limit) as unknown as EventRow[]
    ).map(rowToEvent);
  }

  listActors(): RegistryActor[] {
    return (this.db.prepare(`SELECT * FROM actors ORDER BY display_name ASC`).all() as unknown as ActorRow[]).map(
      rowToActor
    );
  }

  resolveActorId(candidates: string[]): string | undefined {
    const normalized = [...new Set(candidates.map((candidate) => candidate.trim()).filter(Boolean))];
    for (const candidate of normalized) {
      const row = this.db
        .prepare(`SELECT id FROM actors WHERE id = ? OR external_ref = ? ORDER BY id ASC LIMIT 1`)
        .get(candidate, candidate) as { id: string } | undefined;
      if (row) {
        return row.id;
      }
    }
    return undefined;
  }

  listRegistryAgents(): RegistryAgentDetail[] {
    return (this.db.prepare(`SELECT * FROM agents ORDER BY name ASC`).all() as unknown as AgentRow[]).map((row) =>
      this.agentDetail(rowToAgent(row))
    );
  }

  getRegistryAgent(id: string): RegistryAgentDetail | undefined {
    const row = this.db.prepare(`SELECT * FROM agents WHERE id = ?`).get(id) as unknown as AgentRow | undefined;
    return row ? this.agentDetail(rowToAgent(row)) : undefined;
  }

  verifyAuditChain(): AuditChainVerification {
    return verifyAuditChain(this.readAllEvents());
  }

  health(): StoreHealth {
    const database = inspectControlPlaneDatabase(this.db);
    this.auditChainValid = database.checks.auditChain.ok;
    const checks = {
      read: this.readHealth(),
      write: this.writeHealth(),
      ...database.checks,
      liveness: this.livenessHealth()
    };
    return { ok: Object.values(checks).every((check) => check.ok), checks };
  }

  transition(id: string, status: WorkItemStatus, options?: PrivilegedTransitionOptions): WorkItem {
    if (status === "running") {
      throw new ControlStackError("worker_claim_required", "running work items must be claimed by a worker");
    }
    if (
      status === "approved" ||
      status === "pending_policy" ||
      status === "needs_approval" ||
      status === "cancelled" ||
      status === "rejected"
    ) {
      requirePrivilegedTransition(options, status);
    }
    return this.transitionWithEvent(id, status);
  }

  approveWorkItem(id: string, options?: PrivilegedTransitionOptions): WorkItem {
    requirePrivilegedTransition(options, "approve");
    return this.transitionWithEvent(id, "approved");
  }

  blockWorkItem(id: string): WorkItem {
    return this.transitionWithEvent(id, "blocked");
  }

  unblockWorkItem(id: string, options?: PrivilegedTransitionOptions): WorkItem {
    requirePrivilegedTransition(options, "unblock");
    return this.transitionWithEvent(id, "pending_policy");
  }

  cancelWorkItem(id: string, input: unknown = {}, options?: PrivilegedTransitionOptions): WorkItem {
    requirePrivilegedTransition(options, "cancel");
    const parsed = cancelRequestSchema.parse(input);
    const attributes: Record<string, string> = { "work_item.cancelled_by": parsed.actor };
    if (parsed.reason) {
      attributes["work_item.cancel_reason"] = parsed.reason;
    }
    return this.transitionWithEvent(id, "cancelled", {
      eventBody: { actor: parsed.actor, reason: parsed.reason },
      eventAttributes: attributes
    });
  }

  rejectWorkItem(id: string, input: unknown = {}, options?: PrivilegedTransitionOptions): WorkItem {
    requirePrivilegedTransition(options, "reject");
    const parsed = rejectRequestSchema.parse(input);
    const attributes: Record<string, string> = { "work_item.rejected_by": parsed.actor };
    if (parsed.reason) {
      attributes["work_item.reject_reason"] = parsed.reason;
    }
    return this.transitionWithEvent(id, "rejected", {
      eventBody: { actor: parsed.actor, reason: parsed.reason },
      eventAttributes: attributes
    });
  }

  registerConnector(input: ConnectorRegistration): RegisteredConnector {
    return this.write(() => {
      const now = (input.now ?? new Date()).toISOString();
      const displayName = input.displayName ?? input.id;
      const allowedScopes = uniqueNonEmpty(input.allowedScopes, "allowedScopes");
      const actorId = requiredActorId(input.actorId);
      this.getActorRequired(actorId);
      const existing = this.db.prepare(`SELECT public_key_pem FROM connector_records WHERE id = ?`).get(input.id) as
        { public_key_pem: string } | undefined;
      if (existing && existing.public_key_pem !== input.publicKeyPem) {
        throw new ControlStackError(
          "connector_key_rotation_required",
          `connector key rotation requires /connectors/${input.id}/rotate-key`
        );
      }
      this.db
        .prepare(
          `INSERT INTO connector_records
           (id, display_name, public_key_pem, allowed_scopes_json, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'active', ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             display_name = excluded.display_name,
             allowed_scopes_json = excluded.allowed_scopes_json,
             status = 'active',
             updated_at = excluded.updated_at`
        )
        .run(input.id, displayName, input.publicKeyPem, JSON.stringify(allowedScopes), now, now);
      const connector = this.getConnectorRequired(input.id);
      const attributes: Record<string, string> = {
        "connector.id": connector.id,
        "connector.status": connector.status
      };
      attributes["actor.id"] = actorId;
      const event = this.appendAuditEvent(
        createEvent(
          "connector.registered",
          {
            connectorId: connector.id,
            displayName: connector.displayName,
            allowedScopes: connector.allowedScopes,
            publicKeyFingerprint: publicKeyFingerprint(connector.publicKeyPem),
            status: connector.status,
            actorId
          },
          attributes
        )
      );
      return { value: connector, events: [event] };
    });
  }

  rotateConnectorKey(input: ConnectorKeyRotation): RegisteredConnector {
    return this.write(() => {
      const now = (input.now ?? new Date()).toISOString();
      this.getActorRequired(input.actorId);
      const before = this.getConnectorRequired(input.id);
      const beforeFingerprint = publicKeyFingerprint(before.publicKeyPem);
      const afterFingerprint = publicKeyFingerprint(input.publicKeyPem);
      if (beforeFingerprint === afterFingerprint) {
        throw new ControlStackError("connector_key_unchanged", `connector key is unchanged: ${input.id}`);
      }
      this.db
        .prepare(`UPDATE connector_records SET public_key_pem = ?, updated_at = ? WHERE id = ?`)
        .run(input.publicKeyPem, now, input.id);
      const connector = this.getConnectorRequired(input.id);
      const event = this.appendAuditEvent(
        createEvent(
          "connector.key_rotated",
          {
            connectorId: connector.id,
            reason: input.reason,
            actorId: input.actorId,
            beforePublicKeyFingerprint: beforeFingerprint,
            publicKeyFingerprint: afterFingerprint
          },
          {
            "connector.id": connector.id,
            "actor.id": input.actorId
          }
        )
      );
      return { value: connector, events: [event] };
    });
  }

  registerActor(input: ActorRegistration): RegistryActor {
    return this.write(() => {
      const now = (input.now ?? new Date()).toISOString();
      assertOneOf(input.actorType, actorTypes, "actorType");
      let registeredByActor: RegistryActor | undefined;
      if (input.registeredByActorId) {
        registeredByActor = this.getActorRequired(input.registeredByActorId);
      }
      this.db
        .prepare(
          `INSERT INTO actors (id, actor_type, display_name, external_ref, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             actor_type = excluded.actor_type,
             display_name = excluded.display_name,
             external_ref = excluded.external_ref`
        )
        .run(
          requiredString(input.id, "id"),
          input.actorType,
          requiredString(input.displayName, "displayName"),
          optionalString(input.externalRef),
          now
        );
      const actor = this.getActorRequired(input.id);
      const auditActor = registeredByActor ?? actor;
      const event = this.appendAuditEvent(
        createEvent(
          "actor.registered",
          {
            actorId: actor.id,
            actorType: actor.actorType,
            displayName: actor.displayName,
            externalRef: actor.externalRef,
            registeredByActorId: input.registeredByActorId
          },
          {
            "actor.id": auditActor.id,
            "actor.type": auditActor.actorType,
            "registered_actor.id": actor.id,
            "registered_actor.type": actor.actorType
          }
        )
      );
      return { value: actor, events: [event] };
    });
  }

  createRegistryAgent(input: RegistryAgentInput): RegistryAgentDetail {
    return this.write(() => {
      const now = (input.now ?? new Date()).toISOString();
      this.getActorRequired(input.actorId);
      assertOneOf(input.acpRole, acpRoles, "acpRole");
      assertOneOf(input.status ?? "UNKNOWN", registryStatuses, "status");
      if (this.getRegistryAgent(input.id)) {
        throw new ControlStackError("agent_conflict", `agent already exists: ${input.id}`);
      }
      this.db
        .prepare(
          `INSERT INTO agents
           (id, name, kind, acp_role, provider, model, endpoint, status, last_heartbeat_at, last_error, created_at, updated_at, created_by_actor_id, updated_by_actor_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`
        )
        .run(
          requiredString(input.id, "id"),
          requiredString(input.name, "name"),
          requiredString(input.kind, "kind"),
          input.acpRole,
          optionalString(input.provider),
          optionalString(input.model),
          optionalString(input.endpoint),
          input.status ?? "UNKNOWN",
          redactedOptionalString(input.lastError),
          now,
          now,
          input.actorId,
          input.actorId
        );
      const agent = this.getRegistryAgentRequired(input.id);
      const event = this.appendAuditEvent(
        createEvent("agent.created", { ...agent }, { "agent.id": agent.id, "actor.id": input.actorId })
      );
      return { value: agent, events: [event] };
    });
  }

  updateRegistryAgent(id: string, input: RegistryAgentUpdate): RegistryAgentDetail {
    return this.write(() => {
      const now = (input.now ?? new Date()).toISOString();
      this.getActorRequired(input.actorId);
      const current = this.getRegistryAgentRequired(id);
      if (input.acpRole) assertOneOf(input.acpRole, acpRoles, "acpRole");
      if (input.status) assertOneOf(input.status, registryStatuses, "status");
      this.db
        .prepare(
          `UPDATE agents
           SET name = ?, kind = ?, acp_role = ?, provider = ?, model = ?, endpoint = ?, status = ?, last_error = ?, updated_at = ?, updated_by_actor_id = ?
           WHERE id = ?`
        )
        .run(
          input.name === undefined ? current.name : requiredString(input.name, "name"),
          input.kind === undefined ? current.kind : requiredString(input.kind, "kind"),
          input.acpRole ?? current.acpRole,
          input.provider === undefined ? (current.provider ?? null) : optionalString(input.provider),
          input.model === undefined ? (current.model ?? null) : optionalString(input.model),
          input.endpoint === undefined ? (current.endpoint ?? null) : optionalString(input.endpoint),
          input.status ?? current.status,
          input.lastError === undefined ? (current.lastError ?? null) : redactedOptionalString(input.lastError),
          now,
          input.actorId,
          id
        );
      const agent = this.getRegistryAgentRequired(id);
      const event = this.appendAuditEvent(
        createEvent("agent.updated", { ...agent }, { "agent.id": agent.id, "actor.id": input.actorId })
      );
      return { value: agent, events: [event] };
    });
  }

  replaceAgentCapabilities(
    agentId: string,
    capabilities: RegistryCapabilityInput[],
    actorId: string
  ): RegistryCapability[] {
    return this.write(() => {
      const now = new Date().toISOString();
      this.getActorRequired(actorId);
      this.getRegistryAgentRequired(agentId);
      const rows = capabilities.map((capability) => ({
        id: createId("cap"),
        name: requiredString(capability.name, "name"),
        description: optionalString(capability.description),
        inputSchema: normalizeInputSchema(capability.inputSchema)
      }));
      this.db.prepare(`DELETE FROM capabilities WHERE agent_id = ?`).run(agentId);
      for (const capability of rows) {
        this.db
          .prepare(
            `INSERT INTO capabilities
             (id, agent_id, name, description, input_schema, created_at, updated_at, created_by_actor_id, updated_by_actor_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            capability.id,
            agentId,
            capability.name,
            capability.description,
            capability.inputSchema,
            now,
            now,
            actorId,
            actorId
          );
      }
      this.db
        .prepare(`UPDATE agents SET updated_at = ?, updated_by_actor_id = ? WHERE id = ?`)
        .run(now, actorId, agentId);
      const replaced = this.listAgentCapabilities(agentId);
      const event = this.appendAuditEvent(
        createEvent(
          "agent.capabilities_replaced",
          { agentId, capabilities: replaced },
          { "agent.id": agentId, "actor.id": actorId }
        )
      );
      return { value: replaced, events: [event] };
    });
  }

  listAgentCapabilities(agentId: string): RegistryCapability[] {
    this.getRegistryAgentBaseRequired(agentId);
    return this.capabilitiesForAgent(agentId);
  }

  recordAgentHeartbeat(
    agentId: string,
    input: RegistryHeartbeatInput
  ): { agent: RegistryAgentDetail; heartbeat: RegistryHeartbeat } {
    return this.write(() => {
      const observedAt = (input.now ?? new Date()).toISOString();
      this.getActorRequired(input.actorId);
      this.getRegistryAgentRequired(agentId);
      assertOneOf(input.status, registryStatuses, "status");
      const lastError = redactedOptionalString(input.lastError);
      const result = this.db
        .prepare(
          `INSERT INTO heartbeats (agent_id, status, current_task, last_error, observed_at, actor_id)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(agentId, input.status, optionalString(input.currentTask), lastError, observedAt, input.actorId);
      this.db
        .prepare(
          `UPDATE agents
           SET status = ?, last_heartbeat_at = ?,
               last_error = CASE WHEN ? IS NULL THEN last_error ELSE ? END,
               updated_at = ?, updated_by_actor_id = ?
           WHERE id = ?`
        )
        .run(input.status, observedAt, lastError, lastError, observedAt, input.actorId, agentId);
      const heartbeat = rowToHeartbeat(
        this.db.prepare(`SELECT * FROM heartbeats WHERE id = ?`).get(result.lastInsertRowid) as unknown as HeartbeatRow
      );
      const agent = this.getRegistryAgentRequired(agentId);
      const event = this.appendAuditEvent(
        createEvent(
          "agent.heartbeat",
          { agentId, heartbeat, status: agent.status, lastHeartbeatAt: agent.lastHeartbeatAt },
          { "agent.id": agentId, "agent.status": agent.status, "actor.id": input.actorId }
        )
      );
      return { value: { agent, heartbeat }, events: [event] };
    });
  }

  reconcileStaleAgents(options: LivenessReconciliationOptions = {}): RegistryAgentDetail[] {
    return this.write(() => {
      const now = options.now ?? new Date();
      const nowIso = now.toISOString();
      const actorId = options.actorId ?? "actor_system_bootstrap";
      this.getActorRequired(actorId);
      const rows = this.db
        .prepare(
          `SELECT * FROM agents
           WHERE status IN ('AVAILABLE', 'BUSY', 'DEGRADED')
           ORDER BY id ASC`
        )
        .all() as unknown as AgentRow[];
      const reconciled: RegistryAgentDetail[] = [];
      const events: StoredAuditEvent[] = [];

      for (const row of rows) {
        if (!isHeartbeatExpired(row.last_heartbeat_at, row.updated_at, now, this.heartbeatTtlMs)) {
          continue;
        }
        const result = this.db
          .prepare(
            `UPDATE agents
             SET status = 'OFFLINE',
                 last_error = CASE WHEN last_error IS NULL THEN 'heartbeat expired' ELSE last_error END,
                 updated_at = ?, updated_by_actor_id = ?
             WHERE id = ? AND status = ? AND last_heartbeat_at IS ? AND updated_at = ?`
          )
          .run(nowIso, actorId, row.id, row.status, row.last_heartbeat_at, row.updated_at);
        if (result.changes !== 1) {
          continue;
        }
        const agent = this.getRegistryAgentRequired(row.id);
        reconciled.push(agent);
        events.push(
          this.appendAuditEvent(
            createEvent(
              "agent.reconciled",
              {
                agentId: row.id,
                previousStatus: row.status,
                status: agent.status,
                lastHeartbeatAt: row.last_heartbeat_at,
                reason: "heartbeat_expired",
                heartbeatTtlMs: this.heartbeatTtlMs,
                actorId
              },
              {
                "agent.id": row.id,
                "agent.status": agent.status,
                "actor.id": actorId,
                "liveness.reason": "heartbeat_expired"
              }
            )
          )
        );
      }

      return { value: reconciled, events };
    });
  }

  registerTunnelSession(input: TunnelSessionRegistration): RegisteredTunnelSession {
    return this.write(() => {
      const connector = this.getConnectorRequired(input.connectorId);
      if (connector.status !== "active") {
        throw new ControlStackError("connector_revoked", `connector is not active: ${input.connectorId}`);
      }
      const actorId = requiredActorId(input.actorId);
      this.getActorRequired(actorId);
      const now = (input.now ?? new Date()).toISOString();
      const issuedAt = input.issuedAt ?? now;
      assertFutureIso(input.expiresAt, now, "expiresAt");
      this.db
        .prepare(
          `INSERT INTO tunnel_sessions
           (connector_id, tunnel_id, session_id, status, issued_at, expires_at, last_heartbeat_at, created_at, updated_at)
           VALUES (?, ?, ?, 'active', ?, ?, NULL, ?, ?)
           ON CONFLICT(connector_id, tunnel_id, session_id) DO UPDATE SET
             status = 'active',
             issued_at = excluded.issued_at,
             expires_at = excluded.expires_at,
             last_heartbeat_at = NULL,
             updated_at = excluded.updated_at`
        )
        .run(input.connectorId, input.tunnelId, input.sessionId, issuedAt, input.expiresAt, now, now);
      const session = this.getTunnelSessionRequired(input);
      const attributes: Record<string, string> = {
        "connector.id": session.connectorId,
        "tunnel.id": session.tunnelId,
        "tunnel.session_id": session.sessionId,
        "tunnel.session_status": session.status
      };
      attributes["actor.id"] = actorId;
      const event = this.appendAuditEvent(
        createEvent("tunnel_session.registered", { ...session, actorId }, attributes)
      );
      return { value: session, events: [event] };
    });
  }

  heartbeatTunnelSession(input: TunnelSessionRef): RegisteredTunnelSession {
    return this.write(() => {
      const actorId = requiredActorId(input.actorId);
      this.getActorRequired(actorId);
      const now = (input.now ?? new Date()).toISOString();
      const result = this.db
        .prepare(
          `UPDATE tunnel_sessions
           SET last_heartbeat_at = ?, updated_at = ?
           WHERE connector_id = ? AND tunnel_id = ? AND session_id = ? AND status = 'active' AND expires_at > ?`
        )
        .run(now, now, input.connectorId, input.tunnelId, input.sessionId, now);
      if (result.changes !== 1) {
        throw new ControlStackError("tunnel_session_not_active", `tunnel session is not active: ${input.sessionId}`);
      }
      const session = this.getTunnelSessionRequired(input);
      const attributes: Record<string, string> = {
        "connector.id": session.connectorId,
        "tunnel.id": session.tunnelId,
        "tunnel.session_id": session.sessionId
      };
      attributes["actor.id"] = actorId;
      const event = this.appendAuditEvent(createEvent("tunnel_session.heartbeat", { ...session, actorId }, attributes));
      return { value: session, events: [event] };
    });
  }

  reconcileStaleTunnelSessions(options: LivenessReconciliationOptions = {}): RegisteredTunnelSession[] {
    return this.write(() => {
      const now = options.now ?? new Date();
      const nowIso = now.toISOString();
      const actorId = options.actorId ?? "actor_system_bootstrap";
      this.getActorRequired(actorId);
      const rows = this.db
        .prepare(`SELECT * FROM tunnel_sessions WHERE status = 'active' ORDER BY connector_id, tunnel_id, session_id`)
        .all() as unknown as TunnelSessionRow[];
      const reconciled: RegisteredTunnelSession[] = [];
      const events: StoredAuditEvent[] = [];

      for (const row of rows) {
        const sessionExpired =
          !Number.isFinite(Date.parse(row.expires_at)) || Date.parse(row.expires_at) <= now.getTime();
        const heartbeatExpired = isHeartbeatExpired(row.last_heartbeat_at, row.issued_at, now, this.heartbeatTtlMs);
        if (!sessionExpired && !heartbeatExpired) {
          continue;
        }
        const result = this.db
          .prepare(
            `UPDATE tunnel_sessions
             SET status = 'revoked', updated_at = ?
             WHERE connector_id = ? AND tunnel_id = ? AND session_id = ?
               AND status = 'active' AND expires_at = ? AND last_heartbeat_at IS ?`
          )
          .run(nowIso, row.connector_id, row.tunnel_id, row.session_id, row.expires_at, row.last_heartbeat_at);
        if (result.changes !== 1) {
          continue;
        }
        const session = this.getTunnelSessionRequired({
          connectorId: row.connector_id,
          tunnelId: row.tunnel_id,
          sessionId: row.session_id
        });
        const reason = sessionExpired ? "session_expired" : "heartbeat_expired";
        reconciled.push(session);
        events.push(
          this.appendAuditEvent(
            createEvent(
              "tunnel_session.reconciled",
              { ...session, previousStatus: "active", reason, heartbeatTtlMs: this.heartbeatTtlMs, actorId },
              {
                "connector.id": session.connectorId,
                "tunnel.id": session.tunnelId,
                "tunnel.session_id": session.sessionId,
                "tunnel.session_status": session.status,
                "actor.id": actorId,
                "liveness.reason": reason
              }
            )
          )
        );
      }

      return { value: reconciled, events };
    });
  }

  revokeTunnelSession(input: TunnelSessionRef): RegisteredTunnelSession {
    return this.write(() => {
      const actorId = requiredActorId(input.actorId);
      this.getActorRequired(actorId);
      const now = (input.now ?? new Date()).toISOString();
      const result = this.db
        .prepare(
          `UPDATE tunnel_sessions
           SET status = 'revoked', updated_at = ?
           WHERE connector_id = ? AND tunnel_id = ? AND session_id = ?`
        )
        .run(now, input.connectorId, input.tunnelId, input.sessionId);
      if (result.changes !== 1) {
        throw new ControlStackError("tunnel_session_not_found", `tunnel session not found: ${input.sessionId}`);
      }
      const session = this.getTunnelSessionRequired(input);
      const attributes: Record<string, string> = {
        "connector.id": session.connectorId,
        "tunnel.id": session.tunnelId,
        "tunnel.session_id": session.sessionId,
        "tunnel.session_status": session.status
      };
      attributes["actor.id"] = actorId;
      const event = this.appendAuditEvent(createEvent("tunnel_session.revoked", { ...session, actorId }, attributes));
      return { value: session, events: [event] };
    });
  }

  getTunnelSession(input: TunnelSessionRef): TunnelSessionAuthorizationRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT s.*, c.public_key_pem, c.allowed_scopes_json, c.status AS connector_status
         FROM tunnel_sessions s
         JOIN connector_records c ON c.id = s.connector_id
         WHERE s.connector_id = ? AND s.tunnel_id = ? AND s.session_id = ?`
      )
      .get(input.connectorId, input.tunnelId, input.sessionId) as unknown as TunnelSessionJoinRow | undefined;
    return row ? rowToTunnelSessionAuthorization(row) : undefined;
  }

  recordConnectorRequest(input: ConnectorRequestRecord): StoredAuditEvent {
    return this.write(() => {
      const attributes: Record<string, string> = {
        "connector.actor": input.actor,
        "connector.source": input.source,
        "connector.route": input.route,
        "connector.tool": input.toolName
      };
      if (input.workItemId) attributes["work_item.id"] = input.workItemId;
      if (input.requestId) attributes["connector.request_id"] = input.requestId;
      if (input.authMethod) attributes["auth.method"] = input.authMethod;
      if (input.authSubject) attributes["auth.subject"] = input.authSubject;
      if (input.authIssuer) attributes["auth.issuer"] = input.authIssuer;
      if (input.authConnectorId) attributes["auth.connector_id"] = input.authConnectorId;
      if (input.authTunnelId) attributes["auth.tunnel_id"] = input.authTunnelId;
      if (input.authSessionId) attributes["auth.session_id"] = input.authSessionId;
      const event = this.appendAuditEvent(createEvent("connector.requested", { ...input }, attributes));
      return { value: event, events: [event] };
    });
  }

  recordAgentTimelineEvent(input: AgentTimelineEventRecord): StoredAuditEvent {
    return this.write(() => {
      this.getActorRequired(input.actorId);
      assertOneOf(input.eventType, acpTimelineEventTypes, "eventType");
      const attributes: Record<string, string> = {
        "agent.id": requiredString(input.agentId, "agentId"),
        "actor.id": input.actorId,
        "acp.event_type": input.eventType
      };
      if (input.method) attributes["acp.method"] = input.method;
      if (input.messageId) attributes["acp.message_id"] = input.messageId;
      if (input.sessionId) attributes["acp.session_id"] = input.sessionId;
      if (input.workItemId) attributes["work_item.id"] = input.workItemId;
      const event = this.appendAuditEvent(
        createEvent(
          `acp.${input.eventType}`,
          {
            agentId: input.agentId,
            eventType: input.eventType,
            method: input.method,
            messageId: input.messageId,
            sessionId: input.sessionId,
            workItemId: input.workItemId,
            ...(input.body ?? {})
          },
          attributes
        )
      );
      return { value: event, events: [event] };
    });
  }

  recordPolicyDecision(input: PolicyDecisionRecord): StoredAuditEvent {
    return this.write(() => {
      const event = this.appendAuditEvent(
        createEvent(
          "policy.decided",
          { ...input },
          {
            "work_item.id": input.workItemId,
            "action.hash": input.actionHash,
            "policy.decision": input.decision
          }
        )
      );
      return { value: event, events: [event] };
    });
  }

  recordApproval(input: ApprovalRecord): ApprovalGrant {
    return this.write(() => {
      const existing = this.db
        .prepare(`SELECT status FROM approval_records WHERE work_item_id = ? AND action_hash = ?`)
        .get(input.workItemId, input.actionHash) as { status: string } | undefined;
      if (existing?.status === "consumed") {
        throw new ControlStackError(
          "approval_already_consumed",
          `approval was already consumed for action hash: ${input.actionHash}`
        );
      }
      const createdAt = input.createdAt ?? new Date().toISOString();
      const expiresAt =
        input.expiresAt ?? new Date(Date.parse(createdAt) + (input.expiresInMs ?? 10 * 60 * 1000)).toISOString();
      const reason = input.reason ?? "approved";
      const requestHash = input.requestHash ?? approvalRequestHash(input.workItemId, input.actionHash);
      this.db
        .prepare(
          `INSERT INTO approval_records
           (work_item_id, action_hash, request_hash, approval_token_hash, approved_by, reason, status, created_at, expires_at, consumed_at)
           VALUES (?, ?, ?, ?, ?, ?, 'granted', ?, ?, NULL)
           ON CONFLICT(work_item_id, action_hash) DO UPDATE SET
             request_hash = excluded.request_hash,
             approval_token_hash = excluded.approval_token_hash,
             approved_by = excluded.approved_by,
             reason = excluded.reason,
             status = 'granted',
             created_at = excluded.created_at,
             expires_at = excluded.expires_at,
             consumed_at = NULL`
        )
        .run(input.workItemId, input.actionHash, requestHash, "", input.approvedBy, reason, createdAt, expiresAt);
      const event = this.appendAuditEvent(
        createEvent(
          "approval.granted",
          {
            workItemId: input.workItemId,
            actionHash: input.actionHash,
            approvedBy: input.approvedBy,
            reason,
            createdAt,
            expiresAt,
            requestHash,
            status: "granted"
          },
          {
            "work_item.id": input.workItemId,
            "action.hash": input.actionHash,
            "approval.request_hash": requestHash,
            "approval.approved_by": input.approvedBy
          }
        )
      );
      return {
        value: {
          workItemId: input.workItemId,
          actionHash: input.actionHash,
          requestHash,
          expiresAt,
          status: "granted",
          event
        },
        events: [event]
      };
    });
  }

  hasApproval(workItemId: string, actionHash: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM approval_records
         WHERE work_item_id = ? AND action_hash = ? AND status = 'granted' AND expires_at > ?`
      )
      .get(workItemId, actionHash, new Date().toISOString());
    return Boolean(row);
  }

  consumeApproval(
    workItemId: string,
    actionHash: string,
    options: Date | ConsumeApprovalOptions = {}
  ): StoredAuditEvent {
    return this.write(() => {
      const parsed = options instanceof Date ? { now: options } : options;
      const now = parsed.now ?? new Date();
      const consumedAt = now.toISOString();
      const row = this.db
        .prepare(
          `SELECT request_hash, status, expires_at FROM approval_records
           WHERE work_item_id = ? AND action_hash = ?`
        )
        .get(workItemId, actionHash) as unknown as
        { request_hash: string; status: string; expires_at: string } | undefined;

      if (!row) {
        throw new ControlStackError("approval_missing", `approval missing for action hash: ${actionHash}`);
      }
      if (parsed.requestHash && row.request_hash !== parsed.requestHash) {
        throw new ControlStackError("approval_request_mismatch", `approval request hash does not match: ${actionHash}`);
      }
      if (row.status !== "granted") {
        throw new ControlStackError("approval_not_granted", `approval is not granted for action hash: ${actionHash}`);
      }
      if (row.expires_at <= consumedAt) {
        throw new ControlStackError("approval_expired", `approval expired for action hash: ${actionHash}`);
      }

      const result = this.db
        .prepare(
          `UPDATE approval_records
           SET status = 'consumed', consumed_at = ?
           WHERE work_item_id = ? AND action_hash = ? AND status = 'granted'`
        )
        .run(consumedAt, workItemId, actionHash);
      if (result.changes !== 1) {
        throw new ControlStackError("approval_conflict", `approval changed while consuming: ${actionHash}`);
      }

      const event = this.appendAuditEvent(
        createEvent(
          "approval.consumed",
          { workItemId, actionHash, requestHash: row.request_hash, consumedAt, status: "consumed" },
          {
            "work_item.id": workItemId,
            "action.hash": actionHash,
            "approval.request_hash": row.request_hash
          }
        )
      );
      return { value: event, events: [event] };
    });
  }

  startWorkItem(_id: string, _workerId = "local-worker", _options: ClaimOptions = {}): ClaimedWorkItem {
    return rejectLegacyWorkerProtocol();
  }

  claimNextApprovedWorkItem(_workerId: string, _options: ClaimOptions = {}): ClaimedWorkItem | undefined {
    return rejectLegacyWorkerProtocol();
  }

  failExpiredLeases(_now = new Date()): WorkItem[] {
    return rejectLegacyWorkerProtocol();
  }

  submitWorkResult(_input: unknown): WorkItem {
    return rejectLegacyWorkerProtocol();
  }

  recordDerivedWorkResult(_input: unknown): WorkItem {
    return rejectLegacyWorkerProtocol();
  }

  getExecutionResult(resultId: string): StoredExecutionResult | undefined {
    if (!resultId) return undefined;
    const row = this.db.prepare(`SELECT * FROM execution_results WHERE result_id = ?`).get(resultId) as unknown as
      ExecutionResultRow | undefined;
    return row ? rowToExecutionResult(row) : undefined;
  }

  getExecutionResultForIdempotency(workerId: string, idempotencyKey: string): StoredExecutionResult | undefined {
    const row = this.db
      .prepare(`SELECT * FROM execution_results WHERE worker_id = ? AND idempotency_key = ?`)
      .get(workerId, idempotencyKey) as unknown as ExecutionResultRow | undefined;
    return row ? rowToExecutionResult(row) : undefined;
  }

  retryWorkItem(id: string, input: RetryWorkItemInput): WorkItem {
    const reason = input.reason.trim();
    if (!reason || reason.length > 2_000) {
      throw new ControlStackError("invalid_retry_request", "retry reason must be between 1 and 2,000 characters");
    }
    return this.createLinkedWorkItem(id, "retry", input.actor, { retryReason: reason });
  }

  cloneWorkItem(id: string, input: CloneWorkItemInput): WorkItem {
    return this.createLinkedWorkItem(id, "clone", input.actor, {
      title: input.title,
      intent: input.intent,
      target: input.target,
      requestedActions: input.requestedActions,
      risk: input.risk
    });
  }

  private createLinkedWorkItem(
    sourceId: string,
    lineageType: "retry" | "clone",
    actor: string,
    overrides: {
      retryReason?: string;
      title?: string;
      intent?: string;
      target?: Record<string, unknown>;
      requestedActions?: Array<{ kind: string; description: string; params?: Record<string, unknown> }>;
      risk?: WorkItemRisk;
    }
  ): WorkItem {
    return this.write(() => {
      const source = this.getRequired(sourceId);
      if (!isTerminalStatus(source.status)) {
        throw new ControlStackError(
          "lineage_source_not_terminal",
          "retry and clone require a terminal source work item"
        );
      }
      if (lineageType === "retry" && !overrides.retryReason) {
        throw new ControlStackError("invalid_retry_request", "retry reason is required");
      }
      const created = createWorkItem({
        title: overrides.title ?? source.title,
        requester: source.requester,
        ...(source.requesterSubject ? { requesterSubject: source.requesterSubject } : {}),
        status: "pending_policy",
        intent: overrides.intent ?? source.intent,
        target: overrides.target ?? source.target,
        requestedActions: overrides.requestedActions ?? source.requestedActions,
        risk: overrides.risk ?? source.risk
      });
      const retrySequence = (source.retrySequence ?? 0) + (lineageType === "retry" ? 1 : 0);
      const linked = workItemSchema.parse({
        ...created,
        sourceWorkItemId: source.id,
        lineageType,
        ...(overrides.retryReason ? { retryReason: overrides.retryReason } : {}),
        retrySequence,
        rootWorkItemId: source.rootWorkItemId ?? source.id
      });
      this.db
        .prepare(
          `INSERT INTO work_items
           (id, title, requester, requester_subject, status, intent, target_json, requested_actions_json, risk, result_json,
            worker_id, started_at, lease_expires_at, lease_token_hash, source_work_item_id, lineage_type, retry_reason,
            retry_sequence, root_work_item_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          linked.id,
          linked.title,
          linked.requester,
          linked.requesterSubject ?? null,
          linked.status,
          linked.intent,
          JSON.stringify(linked.target),
          JSON.stringify(linked.requestedActions),
          linked.risk,
          linked.sourceWorkItemId ?? source.id,
          linked.lineageType ?? lineageType,
          linked.retryReason ?? null,
          linked.retrySequence ?? 0,
          linked.rootWorkItemId ?? source.rootWorkItemId ?? source.id,
          linked.createdAt,
          linked.updatedAt
        );
      const eventName = lineageType === "retry" ? "work_item.retried" : "work_item.cloned";
      const event = this.appendAuditEvent(
        createEvent(
          eventName,
          {
            workItemId: linked.id,
            sourceWorkItemId: source.id,
            lineageType,
            retryReason: linked.retryReason,
            retrySequence: linked.retrySequence,
            rootWorkItemId: linked.rootWorkItemId,
            actor
          },
          {
            "work_item.id": linked.id,
            "work_item.source_id": source.id,
            "work_item.lineage_type": lineageType,
            "actor.id": actor
          }
        )
      );
      const createdEvent = this.appendAuditEvent(workItemCreatedEvent(linked));
      return { value: linked, events: [createdEvent, event] };
    });
  }

  close(): void {
    this.db.close();
  }

  private getRequired(id: string): WorkItem {
    const workItem = this.get(id);
    if (!workItem) {
      throw new ControlStackError("work_item_not_found", `work item not found: ${id}`);
    }
    return workItem;
  }

  private getRowRequired(id: string): WorkItemRow {
    const row = this.db.prepare(`SELECT * FROM work_items WHERE id = ?`).get(id) as unknown as WorkItemRow | undefined;
    if (!row) {
      throw new ControlStackError("work_item_not_found", `work item not found: ${id}`);
    }
    return row;
  }

  private getConnectorRequired(id: string): RegisteredConnector {
    const row = this.db.prepare(`SELECT * FROM connector_records WHERE id = ?`).get(id) as unknown as
      ConnectorRow | undefined;
    if (!row) {
      throw new ControlStackError("connector_not_found", `connector not found: ${id}`);
    }
    return rowToConnector(row);
  }

  private getActorRequired(id: string): RegistryActor {
    const row = this.db.prepare(`SELECT * FROM actors WHERE id = ?`).get(id) as unknown as ActorRow | undefined;
    if (!row) {
      throw new ControlStackError("actor_not_found", `actor not found: ${id}`);
    }
    return rowToActor(row);
  }

  private getRegistryAgentBaseRequired(id: string): RegistryAgent {
    const row = this.db.prepare(`SELECT * FROM agents WHERE id = ?`).get(id) as unknown as AgentRow | undefined;
    if (!row) {
      throw new ControlStackError("agent_not_found", `agent not found: ${id}`);
    }
    return rowToAgent(row);
  }

  private getRegistryAgentRequired(id: string): RegistryAgentDetail {
    return this.agentDetail(this.getRegistryAgentBaseRequired(id));
  }

  private agentDetail(agent: RegistryAgent): RegistryAgentDetail {
    const heartbeat = this.db
      .prepare(`SELECT * FROM heartbeats WHERE agent_id = ? ORDER BY observed_at DESC, id DESC LIMIT 1`)
      .get(agent.id) as unknown as HeartbeatRow | undefined;
    return {
      ...agent,
      capabilities: this.capabilitiesForAgent(agent.id),
      ...(heartbeat ? { latestHeartbeat: rowToHeartbeat(heartbeat) } : {})
    };
  }

  private capabilitiesForAgent(agentId: string): RegistryCapability[] {
    return (
      this.db
        .prepare(`SELECT * FROM capabilities WHERE agent_id = ? ORDER BY name ASC`)
        .all(agentId) as unknown as CapabilityRow[]
    ).map(rowToCapability);
  }

  private getTunnelSessionRequired(input: TunnelSessionRef): RegisteredTunnelSession {
    const row = this.db
      .prepare(
        `SELECT * FROM tunnel_sessions
         WHERE connector_id = ? AND tunnel_id = ? AND session_id = ?`
      )
      .get(input.connectorId, input.tunnelId, input.sessionId) as unknown as TunnelSessionRow | undefined;
    if (!row) {
      throw new ControlStackError("tunnel_session_not_found", `tunnel session not found: ${input.sessionId}`);
    }
    return rowToTunnelSession(row);
  }

  private transitionWithEvent(
    id: string,
    status: WorkItemStatus,
    options: {
      eventBody?: Record<string, unknown>;
      eventAttributes?: Record<string, string>;
    } = {}
  ): WorkItem {
    return this.write(() => {
      const current = this.getRequired(id);
      const updated = transitionWorkItem(current, status);
      const result = this.db
        .prepare(
          `UPDATE work_items
           SET status = ?, updated_at = ?,
               lease_expires_at = CASE WHEN status = 'running' THEN NULL ELSE lease_expires_at END,
               lease_token_hash = CASE WHEN status = 'running' THEN NULL ELSE lease_token_hash END
           WHERE id = ? AND status = ?`
        )
        .run(updated.status, updated.updatedAt, id, current.status);
      if (result.changes !== 1) {
        throw new ControlStackError("work_item_conflict", `work item changed while transitioning: ${id}`);
      }
      if (current.status === "running" && status !== "running") {
        this.db
          .prepare(`UPDATE leases SET status = 'revoked', closed_at = ? WHERE work_item_id = ? AND status = 'active'`)
          .run(updated.updatedAt, id);
      }
      return {
        value: updated,
        events: [this.appendAuditEvent(workItemStatusEvent(updated, options.eventBody, options.eventAttributes))]
      };
    });
  }

  private appendAuditEvent(event: AuditEvent): StoredAuditEvent {
    const previousHash = this.latestAuditHash();
    this.db
      .prepare(
        `INSERT INTO audit_events (id, name, time_unix_nano, attributes, body, previous_hash, event_hash)
         VALUES (?, ?, ?, ?, ?, ?, '')`
      )
      .run(
        event.id,
        event.name,
        event.timeUnixNano,
        JSON.stringify(event.attributes),
        JSON.stringify(event.body),
        previousHash
      );
    const inserted = this.findEventById(event.id);
    this.db
      .prepare(`UPDATE audit_events SET event_hash = ? WHERE sequence = ?`)
      .run(auditEventHash(inserted), inserted.sequence);
    return this.findEventById(event.id);
  }

  private findEventById(id: string): StoredAuditEvent {
    const row = this.db.prepare(`SELECT * FROM audit_events WHERE id = ?`).get(id) as unknown as EventRow | undefined;
    if (!row) {
      throw new ControlStackError("audit_event_not_found", `audit event not found: ${id}`);
    }
    return rowToEvent(row);
  }

  private readAllEvents(): StoredAuditEvent[] {
    return (this.db.prepare(`SELECT * FROM audit_events ORDER BY sequence ASC`).all() as unknown as EventRow[]).map(
      rowToEvent
    );
  }

  private readHealth(): HealthCheck {
    try {
      this.db.prepare(`SELECT 1 AS ok`).get();
      return okHealth();
    } catch {
      return failHealth("db_read_failed");
    }
  }

  private livenessHealth(): HealthCheck {
    try {
      const now = new Date();
      const activeSessions = this.db
        .prepare(`SELECT expires_at, issued_at, last_heartbeat_at FROM tunnel_sessions WHERE status = 'active'`)
        .all() as Array<{ expires_at: string; issued_at: string; last_heartbeat_at: string | null }>;
      if (
        activeSessions.some(
          (session) =>
            !Number.isFinite(Date.parse(session.expires_at)) ||
            Date.parse(session.expires_at) <= now.getTime() ||
            isHeartbeatExpired(session.last_heartbeat_at, session.issued_at, now, this.heartbeatTtlMs)
        )
      ) {
        return failHealth("stale_liveness");
      }
      const activeAgents = this.db
        .prepare(
          `SELECT last_heartbeat_at, updated_at FROM agents
           WHERE status IN ('AVAILABLE', 'BUSY', 'DEGRADED')`
        )
        .all() as Array<{ last_heartbeat_at: string | null; updated_at: string }>;
      return activeAgents.some((agent) =>
        isHeartbeatExpired(agent.last_heartbeat_at, agent.updated_at, now, this.heartbeatTtlMs)
      )
        ? failHealth("stale_liveness")
        : okHealth();
    } catch {
      return failHealth("liveness_probe_failed");
    }
  }

  private writeHealth(): HealthCheck {
    try {
      this.db.exec("PRAGMA busy_timeout = 50");
      this.db.exec("SAVEPOINT acs_health_write");
      try {
        this.db
          .prepare(
            `UPDATE schema_migrations
             SET applied_at = applied_at
             WHERE version = (SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1)`
          )
          .run();
        this.db.exec("ROLLBACK TO acs_health_write");
        this.db.exec("RELEASE acs_health_write");
        return okHealth();
      } catch (error) {
        try {
          this.db.exec("ROLLBACK TO acs_health_write");
          this.db.exec("RELEASE acs_health_write");
        } catch {
          // best effort; a failed write probe may already have ended the savepoint.
        }
        throw error;
      }
    } catch {
      return failHealth("db_write_failed");
    } finally {
      try {
        this.db.exec("PRAGMA busy_timeout = 5000");
      } catch {
        // health checks should report the probe failure, not cleanup details.
      }
    }
  }

  withTransaction<T>(operation: () => T): T {
    return this.write(() => ({ value: operation(), events: [] }));
  }

  private write<T>(operation: () => { value: T; events: StoredAuditEvent[] }): T {
    if (!this.auditChainValid) {
      throw new ControlStackError("audit_chain_invalid", "audit chain is invalid; writes are disabled");
    }
    if (this.transactionDepth > 0) {
      // Participate in the enclosing transaction; events are notified only if it commits.
      const nested = operation();
      this.pendingEvents.push(...nested.events);
      return nested.value;
    }

    this.db.exec("BEGIN IMMEDIATE");
    this.transactionDepth = 1;
    let result: { value: T; events: StoredAuditEvent[] };
    try {
      result = operation();
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // best effort; the transaction may already have been closed by SQLite.
      }
      this.pendingEvents = [];
      throw error;
    } finally {
      this.transactionDepth = 0;
    }

    const events = [...this.pendingEvents, ...result.events];
    this.pendingEvents = [];
    for (const event of events) {
      try {
        this.onEvent(event);
      } catch {
        // Post-commit notifications are best-effort; state and audit already committed.
      }
    }

    return result.value;
  }

  private latestAuditHash(): string {
    const row = this.db.prepare(`SELECT event_hash FROM audit_events ORDER BY sequence DESC LIMIT 1`).get() as
      { event_hash: string } | undefined;
    return row?.event_hash ?? "";
  }

  private backfillAuditChain(): void {
    const rows = this.db.prepare(`SELECT * FROM audit_events ORDER BY sequence ASC`).all() as unknown as EventRow[];
    let previousHash = "";
    for (const row of rows) {
      const eventHash = row.event_hash || auditEventHash(rowToEvent({ ...row, previous_hash: previousHash }));
      if (!row.event_hash) {
        this.db
          .prepare(`UPDATE audit_events SET previous_hash = ?, event_hash = ? WHERE sequence = ?`)
          .run(previousHash, eventHash, row.sequence);
      }
      previousHash = eventHash;
    }
  }
}

function rowToWorkItem(row: WorkItemRow): WorkItem {
  return workItemSchema.parse({
    id: row.id,
    title: row.title,
    requester: row.requester,
    ...(row.requester_subject ? { requesterSubject: row.requester_subject } : {}),
    status: row.status,
    intent: row.intent,
    target: JSON.parse(row.target_json),
    requestedActions: JSON.parse(row.requested_actions_json),
    risk: row.risk,
    ...(row.result_json ? { result: JSON.parse(row.result_json) as Record<string, unknown> } : {}),
    ...(row.source_work_item_id ? { sourceWorkItemId: row.source_work_item_id } : {}),
    ...(row.lineage_type ? { lineageType: row.lineage_type } : {}),
    ...(row.retry_reason ? { retryReason: row.retry_reason } : {}),
    ...(row.retry_sequence ? { retrySequence: row.retry_sequence } : {}),
    ...(row.root_work_item_id ? { rootWorkItemId: row.root_work_item_id } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

function rowToEvent(row: EventRow): StoredAuditEvent {
  return {
    sequence: row.sequence,
    id: row.id,
    name: row.name,
    timeUnixNano: row.time_unix_nano,
    attributes: JSON.parse(row.attributes) as StoredAuditEvent["attributes"],
    body: JSON.parse(row.body) as StoredAuditEvent["body"],
    previousHash: row.previous_hash,
    eventHash: row.event_hash
  };
}

function rowToExecutionResult(row: ExecutionResultRow): StoredExecutionResult {
  return {
    resultId: row.result_id,
    workItemId: row.work_item_id,
    leaseId: row.lease_id,
    workerId: row.worker_id,
    idempotencyKey: row.idempotency_key,
    actionHash: row.action_hash,
    outcome: row.outcome,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    ...(row.exit_code === null ? {} : { exitCode: row.exit_code }),
    summary: row.summary,
    ...(row.stdout === null ? {} : { stdout: row.stdout }),
    ...(row.stderr === null ? {} : { stderr: row.stderr }),
    structuredOutput: JSON.parse(row.structured_output_json) as Record<string, unknown>,
    artifacts: JSON.parse(row.artifacts_json) as Array<Record<string, unknown>>,
    ...(row.error === null ? {} : { error: row.error }),
    ...(row.resource_usage_json === null
      ? {}
      : { resourceUsage: JSON.parse(row.resource_usage_json) as Record<string, unknown> }),
    simulationMetadata: JSON.parse(row.simulation_metadata_json) as Record<string, unknown>,
    payloadHash: row.payload_hash,
    createdAt: row.created_at
  };
}

function rowToExecutionPlan(row: ExecutionPlanRow): ExecutionPlanRecord {
  let definition: unknown;
  try {
    definition = JSON.parse(row.definition_json);
  } catch {
    throw new ControlStackError("execution_plan_integrity_failed", "execution plan definition is not valid JSON");
  }
  const parsed = executionPlanRecordSchema.safeParse({
    planId: row.plan_id,
    workItemId: row.work_item_id,
    planNumber: row.plan_number,
    definition,
    planHash: row.plan_hash,
    subjectInputHash: row.subject_input_hash,
    createdByActorId: row.created_by_actor_id,
    createdAt: row.created_at
  });
  if (
    !parsed.success ||
    parsed.data.definition.schemaVersion !== row.schema_version ||
    executionPlanHash(parsed.data.definition) !== row.plan_hash ||
    parsed.data.definition.subjectInputHash !== row.subject_input_hash ||
    parsed.data.definition.workItemId !== row.work_item_id
  ) {
    throw new ControlStackError("execution_plan_integrity_failed", "execution plan integrity check failed");
  }
  return parsed.data;
}

function rowToExecutionPlanAdmission(row: ExecutionPlanAdmissionRow): ExecutionPlanAdmission {
  let requiredApprovalActionHashes: unknown;
  try {
    requiredApprovalActionHashes = JSON.parse(row.required_approval_action_hashes_json);
  } catch {
    throw new ControlStackError("execution_plan_integrity_failed", "execution plan admission is not valid JSON");
  }
  const parsed = executionPlanAdmissionSchema.safeParse({
    admissionId: row.admission_id,
    workItemId: row.work_item_id,
    planId: row.plan_id,
    planHash: row.plan_hash,
    admissionHash: row.admission_hash,
    policyVersion: row.policy_version,
    policyDecisionHash: row.policy_decision_hash,
    decision: row.decision,
    requiredApprovalActionHashes,
    admittedByActorId: row.admitted_by_actor_id,
    admittedAt: row.admitted_at
  });
  if (
    !parsed.success ||
    executionPlanAdmissionHash({
      workItemId: parsed.data.workItemId,
      planId: parsed.data.planId,
      planHash: parsed.data.planHash,
      policyVersion: parsed.data.policyVersion,
      policyDecisionHash: parsed.data.policyDecisionHash,
      decision: parsed.data.decision,
      requiredApprovalActionHashes: parsed.data.requiredApprovalActionHashes
    }) !== parsed.data.admissionHash
  ) {
    throw new ControlStackError("execution_plan_integrity_failed", "execution plan admission integrity check failed");
  }
  return parsed.data;
}

function rowToExecutionPlanApproval(row: ExecutionPlanApprovalRow): ExecutionPlanApproval {
  const parsed = executionPlanApprovalSchema.safeParse({
    approvalId: row.approval_id,
    workItemId: row.work_item_id,
    planId: row.plan_id,
    planHash: row.plan_hash,
    admissionId: row.admission_id,
    admissionHash: row.admission_hash,
    policyVersion: row.policy_version,
    actionHash: row.action_hash,
    approvalBindingHash: row.approval_binding_hash,
    approvedByActorId: row.approved_by_actor_id,
    reason: row.reason,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ...(row.consumed_at ? { consumedAt: row.consumed_at } : {})
  });
  if (
    !parsed.success ||
    executionPlanApprovalBindingHash({
      workItemId: parsed.data.workItemId,
      planId: parsed.data.planId,
      planHash: parsed.data.planHash,
      admissionId: parsed.data.admissionId,
      admissionHash: parsed.data.admissionHash,
      policyVersion: parsed.data.policyVersion,
      actionHash: parsed.data.actionHash
    }) !== parsed.data.approvalBindingHash
  ) {
    throw new ControlStackError("execution_plan_integrity_failed", "execution plan approval integrity check failed");
  }
  return parsed.data;
}

function rowToExecutionAttempt(row: ExecutionAttemptRow): ExecutionAttemptRecord {
  const parsed = executionAttemptRecordSchema.safeParse({
    attemptId: row.attempt_id,
    workItemId: row.work_item_id,
    attemptNumber: row.attempt_number,
    protocolVersion: row.protocol_version,
    planId: row.plan_id,
    planHash: row.plan_hash,
    admissionId: row.admission_id,
    admissionHash: row.admission_hash,
    inputHash: row.input_hash,
    workerId: row.worker_id,
    fencingEpoch: row.fencing_epoch,
    status: row.status,
    createdAt: row.created_at,
    claimedAt: row.claimed_at,
    ...(row.started_at ? { startedAt: row.started_at } : {})
  });
  if (!parsed.success) {
    throw new ControlStackError("execution_attempt_integrity_failed", "execution attempt integrity check failed");
  }
  return parsed.data;
}

function normalizeEventLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_EVENT_LIMIT;
  }
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new ControlStackError("invalid_event_query", "limit must be a positive integer");
  }
  return Math.min(limit, MAX_EVENT_LIMIT);
}

function isTerminalStatus(status: WorkItemStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled" || status === "rejected";
}

function okHealth(): HealthCheck {
  return { ok: true };
}

function failHealth(code: string): HealthCheck {
  return { ok: false, code };
}

function rowToConnector(row: ConnectorRow): RegisteredConnector {
  return {
    id: row.id,
    displayName: row.display_name,
    publicKeyPem: row.public_key_pem,
    allowedScopes: JSON.parse(row.allowed_scopes_json) as string[],
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rowToActor(row: ActorRow): RegistryActor {
  return {
    id: row.id,
    actorType: row.actor_type,
    displayName: row.display_name,
    ...(row.external_ref ? { externalRef: row.external_ref } : {}),
    createdAt: row.created_at
  };
}

function rowToAgent(row: AgentRow): RegistryAgent {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    acpRole: row.acp_role,
    ...(row.provider ? { provider: row.provider } : {}),
    ...(row.model ? { model: row.model } : {}),
    ...(row.endpoint ? { endpoint: row.endpoint } : {}),
    status: row.status,
    ...(row.last_heartbeat_at ? { lastHeartbeatAt: row.last_heartbeat_at } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdByActorId: row.created_by_actor_id,
    updatedByActorId: row.updated_by_actor_id
  };
}

function rowToCapability(row: CapabilityRow): RegistryCapability {
  return {
    id: row.id,
    agentId: row.agent_id,
    name: row.name,
    ...(row.description ? { description: row.description } : {}),
    ...(row.input_schema ? { inputSchema: JSON.parse(row.input_schema) as Record<string, unknown> } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdByActorId: row.created_by_actor_id,
    updatedByActorId: row.updated_by_actor_id
  };
}

function rowToHeartbeat(row: HeartbeatRow): RegistryHeartbeat {
  return {
    id: row.id,
    agentId: row.agent_id,
    status: row.status,
    ...(row.current_task ? { currentTask: row.current_task } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    observedAt: row.observed_at,
    actorId: row.actor_id
  };
}

function rowToTunnelSession(row: TunnelSessionRow): RegisteredTunnelSession {
  return {
    connectorId: row.connector_id,
    tunnelId: row.tunnel_id,
    sessionId: row.session_id,
    status: row.status,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    ...(row.last_heartbeat_at ? { lastHeartbeatAt: row.last_heartbeat_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rowToTunnelSessionAuthorization(row: TunnelSessionJoinRow): TunnelSessionAuthorizationRecord {
  return {
    ...rowToTunnelSession(row),
    publicKeyPem: row.public_key_pem,
    scopes: JSON.parse(row.allowed_scopes_json) as string[],
    connectorStatus: row.connector_status
  };
}

function createLeaseToken(): string {
  return randomBytes(32).toString("base64url");
}

function assertWorkerProtocol(value: unknown): asserts value is typeof WORKER_PROTOCOL_VERSION {
  if (value !== WORKER_PROTOCOL_VERSION) {
    throw new ControlStackError(
      "worker_protocol_unsupported",
      `worker protocol ${WORKER_PROTOCOL_VERSION} is required`
    );
  }
}

function rejectLegacyWorkerProtocol(): never {
  throw new ControlStackError(
    "worker_protocol_unsupported",
    `legacy worker writes are disabled; worker protocol ${WORKER_PROTOCOL_VERSION} is required`
  );
}

function hashAttemptLeaseToken(input: {
  attemptId: string;
  leaseId: string;
  workerId: string;
  fencingEpoch: number;
  leaseToken: string;
}): string {
  return stableHash({ domain: "acs.attempt-lease-token.v1", ...input });
}

export function approvalRequestHash(workItemId: string, actionHash: string): string {
  return stableHash({ actionHash, workItemId });
}

function uniqueNonEmpty(values: string[], field: string): string[] {
  const unique = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  if (!unique.length) {
    throw new ControlStackError("invalid_connector_registration", `${field} must not be empty`);
  }
  return unique;
}

function requiredString(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ControlStackError("invalid_agent_registration", `${field} must not be empty`);
  }
  return trimmed;
}

function requiredActorId(value: string | undefined): string {
  const actorId = value?.trim();
  if (!actorId) {
    throw new ControlStackError("actor_required", "actorId is required");
  }
  return actorId;
}

function optionalString(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function redactedOptionalString(value: string | null | undefined): string | null {
  const normalized = optionalString(value);
  if (normalized === null) return null;
  const redacted = redactValue(normalized);
  return typeof redacted === "string" ? redacted : "[redacted]";
}

function normalizeInputSchema(value: Record<string, unknown> | undefined): string | null {
  if (value === undefined) return null;
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new ControlStackError("invalid_agent_registration", "inputSchema must be a JSON object");
  }
  const serialized = JSON.stringify(value);
  if (!serialized) {
    throw new ControlStackError("invalid_agent_registration", "inputSchema must be JSON serializable");
  }
  JSON.parse(serialized);
  return serialized;
}

function assertOneOf<T extends string>(value: string, allowed: readonly T[], field: string): asserts value is T {
  if (!allowed.includes(value as T)) {
    throw new ControlStackError("invalid_agent_registration", `${field} is not supported`);
  }
}

function requirePrivilegedTransition(options: PrivilegedTransitionOptions | undefined, transition: string): void {
  if (!options) {
    throw new ControlStackError(
      "policy_gate_required",
      `${transition} transition requires a policy or domain service path`
    );
  }
}

function assertFutureIso(value: string, now: string, field: string): void {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp <= Date.parse(now)) {
    throw new ControlStackError("invalid_tunnel_session", `${field} must be a future ISO timestamp`);
  }
}

function publicKeyFingerprint(publicKeyPem: string): string {
  return createHash("sha256").update(publicKeyPem).digest("base64url");
}
