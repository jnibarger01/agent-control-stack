import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ControlStackError,
  applyControlPlaneMigrations,
  auditEventHash,
  controlPlaneMigrations,
  createId,
  createEvent,
  redactValue,
  stableHash,
  verifyAuditChain,
  type AuditChainEvent,
  type AuditChainVerification,
  type AuditEvent
} from "@agent-control-stack/shared";
import { transitionWorkItem } from "./state-machine.js";
import {
  cancelRequestSchema,
  createWorkItem,
  listWorkItemsSchema,
  rejectRequestSchema,
  submitWorkResultSchema,
  workItemCreatedEvent,
  workItemSchema,
  workItemStatusEvent,
  type ClaimedWorkItem,
  type Requester,
  type WorkItem,
  type WorkItemRisk,
  type WorkItemStatus
} from "./work-item.js";

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
  created_at: string;
  updated_at: string;
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
    migrations: HealthCheck;
    auditChain: HealthCheck;
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
  approvalToken?: string;
  requestHash?: string;
}

export interface ApprovalGrant {
  workItemId: string;
  actionHash: string;
  requestHash: string;
  approvalToken: string;
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
  actorId?: string;
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
  now?: Date;
}

export interface RegistryActor extends Omit<ActorRegistration, "now"> {
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
  actorId?: string;
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
  approvalToken?: string;
}

export interface ClaimOptions {
  leaseMs?: number;
  allowDirectStartForTests?: true;
}

export interface PrivilegedTransitionOptions {
  via: "policy_gate" | "domain_service";
}

export interface SqliteWorkItemStoreOptions {
  leaseMs?: number;
  onEvent?: (event: StoredAuditEvent) => void;
}

export interface WorkItemStore {
  withTransaction<T>(operation: () => T): T;
  create(input: unknown): WorkItem;
  get(id: string): WorkItem | undefined;
  list(input?: unknown): WorkItem[];
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
  replaceAgentCapabilities(agentId: string, capabilities: RegistryCapabilityInput[], actorId: string): RegistryCapability[];
  listAgentCapabilities(agentId: string): RegistryCapability[];
  recordAgentHeartbeat(agentId: string, input: RegistryHeartbeatInput): { agent: RegistryAgentDetail; heartbeat: RegistryHeartbeat };
  registerTunnelSession(input: TunnelSessionRegistration): RegisteredTunnelSession;
  heartbeatTunnelSession(input: TunnelSessionRef): RegisteredTunnelSession;
  revokeTunnelSession(input: TunnelSessionRef): RegisteredTunnelSession;
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
}

export class SqliteWorkItemStore implements WorkItemStore {
  private readonly db: DatabaseSync;
  private readonly leaseMs: number;
  private readonly onEvent: (event: StoredAuditEvent) => void;
  private transactionDepth = 0;
  private pendingEvents: StoredAuditEvent[] = [];

  constructor(dbPath: string, options: SqliteWorkItemStoreOptions = {}) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.leaseMs = options.leaseMs ?? 5 * 60 * 1000;
    this.onEvent = options.onEvent ?? (() => undefined);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
    `);
    applyControlPlaneMigrations(this.db);
    this.backfillAuditChain();
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
      return (this.db
        .prepare(`SELECT * FROM audit_events ${whereSql} ORDER BY sequence ASC LIMIT ?`)
        .all(...params, limit) as unknown as EventRow[]).map(rowToEvent);
    }
    return (this.db
      .prepare(`SELECT * FROM (SELECT * FROM audit_events ${whereSql} ORDER BY sequence DESC LIMIT ?) ORDER BY sequence ASC`)
      .all(...params, limit) as unknown as EventRow[]).map(rowToEvent);
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
    const checks = {
      read: this.readHealth(),
      write: this.writeHealth(),
      migrations: this.migrationHealth(),
      auditChain: this.auditChainHealth()
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
      if (input.actorId) {
        this.getActorRequired(input.actorId);
      }
      const existing = this.db
        .prepare(`SELECT public_key_pem FROM connector_records WHERE id = ?`)
        .get(input.id) as { public_key_pem: string } | undefined;
      if (existing && existing.public_key_pem !== input.publicKeyPem) {
        throw new ControlStackError("connector_key_rotation_required", `connector key rotation requires /connectors/${input.id}/rotate-key`);
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
      if (input.actorId) attributes["actor.id"] = input.actorId;
      const event = this.appendAuditEvent(
        createEvent(
          "connector.registered",
          {
            connectorId: connector.id,
            displayName: connector.displayName,
            allowedScopes: connector.allowedScopes,
            publicKeyFingerprint: publicKeyFingerprint(connector.publicKeyPem),
            status: connector.status,
            actorId: input.actorId
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
      const event = this.appendAuditEvent(
        createEvent(
          "actor.registered",
          {
            actorId: actor.id,
            actorType: actor.actorType,
            displayName: actor.displayName,
            externalRef: actor.externalRef
          },
          {
            "actor.id": actor.id,
            "actor.type": actor.actorType
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
          input.provider === undefined ? current.provider ?? null : optionalString(input.provider),
          input.model === undefined ? current.model ?? null : optionalString(input.model),
          input.endpoint === undefined ? current.endpoint ?? null : optionalString(input.endpoint),
          input.status ?? current.status,
          input.lastError === undefined ? current.lastError ?? null : redactedOptionalString(input.lastError),
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

  replaceAgentCapabilities(agentId: string, capabilities: RegistryCapabilityInput[], actorId: string): RegistryCapability[] {
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

  recordAgentHeartbeat(agentId: string, input: RegistryHeartbeatInput): { agent: RegistryAgentDetail; heartbeat: RegistryHeartbeat } {
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

  registerTunnelSession(input: TunnelSessionRegistration): RegisteredTunnelSession {
    return this.write(() => {
      const connector = this.getConnectorRequired(input.connectorId);
      if (connector.status !== "active") {
        throw new ControlStackError("connector_revoked", `connector is not active: ${input.connectorId}`);
      }
      if (input.actorId) {
        this.getActorRequired(input.actorId);
      }
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
      if (input.actorId) attributes["actor.id"] = input.actorId;
      const event = this.appendAuditEvent(
        createEvent(
          "tunnel_session.registered",
          { ...session, actorId: input.actorId },
          attributes
        )
      );
      return { value: session, events: [event] };
    });
  }

  heartbeatTunnelSession(input: TunnelSessionRef): RegisteredTunnelSession {
    return this.write(() => {
      if (input.actorId) {
        this.getActorRequired(input.actorId);
      }
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
      if (input.actorId) attributes["actor.id"] = input.actorId;
      const event = this.appendAuditEvent(
        createEvent(
          "tunnel_session.heartbeat",
          { ...session, actorId: input.actorId },
          attributes
        )
      );
      return { value: session, events: [event] };
    });
  }

  revokeTunnelSession(input: TunnelSessionRef): RegisteredTunnelSession {
    return this.write(() => {
      if (input.actorId) {
        this.getActorRequired(input.actorId);
      }
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
      if (input.actorId) attributes["actor.id"] = input.actorId;
      const event = this.appendAuditEvent(
        createEvent(
          "tunnel_session.revoked",
          { ...session, actorId: input.actorId },
          attributes
        )
      );
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
      const event = this.appendAuditEvent(
        createEvent("connector.requested", { ...input }, attributes)
      );
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
        createEvent("policy.decided", { ...input }, {
          "work_item.id": input.workItemId,
          "action.hash": input.actionHash,
          "policy.decision": input.decision
        })
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
      const approvalToken = input.approvalToken ?? createApprovalToken();
      const tokenHash = hashApprovalToken(input.workItemId, input.actionHash, approvalToken);
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
        .run(input.workItemId, input.actionHash, requestHash, tokenHash, input.approvedBy, reason, createdAt, expiresAt);
      const { approvalToken: _approvalToken, ...auditInput } = input;
      const event = this.appendAuditEvent(
        createEvent(
          "approval.granted",
          { ...auditInput, reason, createdAt, expiresAt, requestHash, status: "granted" },
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
          approvalToken,
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
          `SELECT request_hash, approval_token_hash, status, expires_at FROM approval_records
           WHERE work_item_id = ? AND action_hash = ?`
        )
        .get(workItemId, actionHash) as unknown as
        | { request_hash: string; approval_token_hash: string; status: string; expires_at: string }
        | undefined;

      if (!row) {
        throw new ControlStackError("approval_missing", `approval missing for action hash: ${actionHash}`);
      }
      if (parsed.requestHash && row.request_hash !== parsed.requestHash) {
        throw new ControlStackError("approval_request_mismatch", `approval request hash does not match: ${actionHash}`);
      }
      if (
        parsed.approvalToken &&
        row.approval_token_hash !== hashApprovalToken(workItemId, actionHash, parsed.approvalToken)
      ) {
        throw new ControlStackError("approval_token_mismatch", `approval token does not match: ${actionHash}`);
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

  startWorkItem(id: string, workerId = "local-worker", options: ClaimOptions = {}): ClaimedWorkItem {
    if (options.allowDirectStartForTests !== true) {
      throw new ControlStackError("worker_claim_required", "direct startWorkItem is test-only; use claimNextApprovedWorkItem");
    }
    const leaseToken = createLeaseToken();
    const leaseMs = options.leaseMs ?? this.leaseMs;
    const workItem = this.transitionWithEvent(id, "running", {
      leaseMs,
      leaseToken,
      workerId,
      eventBody: { workerId },
      eventAttributes: { "worker.id": workerId }
    });
    return { ...workItem, workerId, leaseToken, leaseExpiresAt: leaseExpiresAt(workItem.updatedAt, leaseMs) };
  }

  claimNextApprovedWorkItem(workerId: string, options: ClaimOptions = {}): ClaimedWorkItem | undefined {
    return this.write(() => {
      const row = this.db
        .prepare(`SELECT * FROM work_items WHERE status = 'approved' ORDER BY created_at ASC LIMIT 1`)
        .get() as unknown as WorkItemRow | undefined;
      if (!row) {
        return { value: undefined, events: [] };
      }

      const current = rowToWorkItem(row);
      const updated = transitionWorkItem(current, "running");
      const startedAt = updated.updatedAt;
      const leaseExpiresAt = new Date(Date.parse(startedAt) + (options.leaseMs ?? this.leaseMs)).toISOString();
      const leaseToken = createLeaseToken();
      const leaseHash = hashLeaseToken(updated.id, workerId, leaseToken);
      const result = this.db
        .prepare(
          `UPDATE work_items
           SET status = ?, updated_at = ?, worker_id = ?, started_at = ?, lease_expires_at = ?, lease_token_hash = ?
           WHERE id = ? AND status = 'approved'`
        )
        .run(updated.status, updated.updatedAt, workerId, startedAt, leaseExpiresAt, leaseHash, updated.id);
      if (result.changes !== 1) {
        throw new ControlStackError("work_item_conflict", `work item changed while claiming: ${updated.id}`);
      }

      return {
        value: { ...updated, workerId, leaseToken, leaseExpiresAt },
        events: [
          this.appendAuditEvent(
            workItemStatusEvent(updated, { workerId, leaseExpiresAt }, { "worker.id": workerId })
          )
        ]
      };
    });
  }

  failExpiredLeases(now = new Date()): WorkItem[] {
    return this.write(() => {
      const nowIso = now.toISOString();
      const rows = this.db
        .prepare(
          `SELECT * FROM work_items
           WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?
           ORDER BY started_at ASC`
        )
        .all(nowIso) as unknown as WorkItemRow[];
      const failed: WorkItem[] = [];
      const events: StoredAuditEvent[] = [];

      for (const row of rows) {
        const current = rowToWorkItem(row);
        const updated = transitionWorkItem(current, "failed", nowIso);
        const leaseFailureResult = { error: "worker lease expired" };
        const result = this.db
          .prepare(
            `UPDATE work_items
             SET status = ?, updated_at = ?, result_json = ?, lease_expires_at = NULL, lease_token_hash = NULL
             WHERE id = ? AND status = 'running' AND lease_expires_at = ?`
          )
          .run(
            updated.status,
            updated.updatedAt,
            JSON.stringify(leaseFailureResult),
            updated.id,
            row.lease_expires_at
          );
        if (result.changes === 1) {
          const failedItem = { ...updated, result: leaseFailureResult };
          failed.push(failedItem);
          events.push(this.appendAuditEvent(workItemStatusEvent(failedItem, { result: leaseFailureResult })));
        }
      }

      return { value: failed, events };
    });
  }

  submitWorkResult(input: unknown): WorkItem {
    const parsed = submitWorkResultSchema.parse(input);
    return this.write(() => {
      const row = this.getRowRequired(parsed.id);
      if (row.status !== "running") {
        throw new ControlStackError("work_item_not_running", `work item is not running: ${parsed.id}`);
      }
      if (!row.worker_id || !row.lease_expires_at || !isStoredLeaseHash(row.lease_token_hash)) {
        throw new ControlStackError("worker_lease_missing", `worker lease is missing for work item: ${parsed.id}`);
      }
      if (row.worker_id !== parsed.workerId) {
        throw new ControlStackError("worker_lease_mismatch", `worker lease does not match work item: ${parsed.id}`);
      }
      const expectedLeaseHash = hashLeaseToken(parsed.id, parsed.workerId, parsed.leaseToken);
      if (row.lease_token_hash !== expectedLeaseHash) {
        throw new ControlStackError("worker_lease_mismatch", `worker lease does not match work item: ${parsed.id}`);
      }
      const leaseExpiresAt = Date.parse(row.lease_expires_at);
      if (!Number.isFinite(leaseExpiresAt) || leaseExpiresAt <= Date.now()) {
        throw new ControlStackError("worker_lease_expired", `worker lease expired for work item: ${parsed.id}`);
      }

      const current = rowToWorkItem(row);
      const redactedResult = redactValue(parsed.result) as Record<string, unknown>;
      const updated = { ...transitionWorkItem(current, parsed.status), result: redactedResult };
      const result = this.db
        .prepare(
          `UPDATE work_items
           SET status = ?, updated_at = ?, result_json = ?, lease_expires_at = NULL, lease_token_hash = NULL
           WHERE id = ? AND status = 'running' AND worker_id = ? AND lease_token_hash = ?`
        )
        .run(
          updated.status,
          updated.updatedAt,
          JSON.stringify(redactedResult),
          parsed.id,
          parsed.workerId,
          expectedLeaseHash
        );
      if (result.changes !== 1) {
        throw new ControlStackError("work_item_conflict", `work item changed while submitting result: ${parsed.id}`);
      }
      return { value: updated, events: [this.appendAuditEvent(workItemStatusEvent(updated, { result: redactedResult }))] };
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
      | ConnectorRow
      | undefined;
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
    return (this.db.prepare(`SELECT * FROM capabilities WHERE agent_id = ? ORDER BY name ASC`).all(agentId) as unknown as CapabilityRow[]).map(
      rowToCapability
    );
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
      workerId?: string;
      leaseMs?: number;
      leaseToken?: string;
      eventBody?: Record<string, unknown>;
      eventAttributes?: Record<string, string>;
    } = {}
  ): WorkItem {
    return this.write(() => {
      const current = this.getRequired(id);
      const updated = transitionWorkItem(current, status);
      const result =
        status === "running"
          ? this.db
              .prepare(
                `UPDATE work_items
                 SET status = ?, updated_at = ?, worker_id = ?, started_at = ?, lease_expires_at = ?, lease_token_hash = ?
                 WHERE id = ? AND status = ?`
              )
              .run(
                updated.status,
                updated.updatedAt,
                options.workerId ?? "local-worker",
                updated.updatedAt,
                new Date(Date.parse(updated.updatedAt) + (options.leaseMs ?? this.leaseMs)).toISOString(),
                hashLeaseToken(id, options.workerId ?? "local-worker", options.leaseToken ?? ""),
                id,
                current.status
              )
          : this.db
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

  private migrationHealth(): HealthCheck {
    try {
      const expected = controlPlaneMigrations();
      const rows = this.db
        .prepare(`SELECT version, name, filename FROM schema_migrations ORDER BY version ASC`)
        .all() as Array<{ version: number; name: string; filename: string }>;
      const byVersion = new Map(rows.map((row) => [row.version, row]));
      for (const migration of expected) {
        const row = byVersion.get(migration.version);
        if (!row) {
          return failHealth("migration_missing");
        }
        if (row.name !== migration.name || row.filename !== migration.filename) {
          return failHealth("migration_mismatch");
        }
      }
      return okHealth();
    } catch {
      return failHealth("migration_probe_failed");
    }
  }

  private auditChainHealth(): HealthCheck {
    try {
      const verification = this.verifyAuditChain();
      if (verification.ok) {
        return okHealth();
      }
      return failHealth(`audit_chain_${verification.failure.reason}`);
    } catch {
      return failHealth("audit_chain_probe_failed");
    }
  }

  withTransaction<T>(operation: () => T): T {
    return this.write(() => ({ value: operation(), events: [] }));
  }

  private write<T>(operation: () => { value: T; events: StoredAuditEvent[] }): T {
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
    const row = this.db
      .prepare(`SELECT event_hash FROM audit_events ORDER BY sequence DESC LIMIT 1`)
      .get() as { event_hash: string } | undefined;
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

function normalizeEventLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_EVENT_LIMIT;
  }
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new ControlStackError("invalid_event_query", "limit must be a positive integer");
  }
  return Math.min(limit, MAX_EVENT_LIMIT);
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

function createApprovalToken(): string {
  return randomBytes(32).toString("base64url");
}

function hashLeaseToken(workItemId: string, workerId: string, leaseToken: string): string {
  return stableHash({ leaseToken, workItemId, workerId });
}

function isStoredLeaseHash(value: string | null): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function leaseExpiresAt(startedAt: string, leaseMs: number): string {
  return new Date(Date.parse(startedAt) + leaseMs).toISOString();
}

function hashApprovalToken(workItemId: string, actionHash: string, approvalToken: string): string {
  return stableHash({ actionHash, approvalToken, workItemId });
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
