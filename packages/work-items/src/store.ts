import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ControlStackError,
  auditEventHash,
  controlPlaneMigrationSql,
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

export interface ConnectorRegistration {
  id: string;
  displayName?: string;
  publicKeyPem: string;
  allowedScopes: string[];
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

export interface TunnelSessionRegistration {
  connectorId: string;
  tunnelId: string;
  sessionId: string;
  issuedAt?: string;
  expiresAt: string;
  now?: Date;
}

export interface TunnelSessionRef {
  connectorId: string;
  tunnelId: string;
  sessionId: string;
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
}

export interface SqliteWorkItemStoreOptions {
  leaseMs?: number;
  onEvent?: (event: StoredAuditEvent) => void;
}

export interface WorkItemStore {
  create(input: unknown): WorkItem;
  get(id: string): WorkItem | undefined;
  list(input?: unknown): WorkItem[];
  readEvents(): StoredAuditEvent[];
  verifyAuditChain(): AuditChainVerification;
  transition(id: string, status: WorkItemStatus): WorkItem;
  approveWorkItem(id: string): WorkItem;
  blockWorkItem(id: string): WorkItem;
  unblockWorkItem(id: string): WorkItem;
  cancelWorkItem(id: string, input?: unknown): WorkItem;
  registerConnector(input: ConnectorRegistration): RegisteredConnector;
  registerTunnelSession(input: TunnelSessionRegistration): RegisteredTunnelSession;
  heartbeatTunnelSession(input: TunnelSessionRef): RegisteredTunnelSession;
  revokeTunnelSession(input: TunnelSessionRef): RegisteredTunnelSession;
  getTunnelSession(input: TunnelSessionRef): TunnelSessionAuthorizationRecord | undefined;
  recordConnectorRequest(input: ConnectorRequestRecord): StoredAuditEvent;
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

  constructor(dbPath: string, options: SqliteWorkItemStoreOptions = {}) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.leaseMs = options.leaseMs ?? 5 * 60 * 1000;
    this.onEvent = options.onEvent ?? (() => undefined);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      ${controlPlaneMigrationSql()}
    `);
    this.ensureWorkItemColumn("worker_id", "worker_id TEXT");
    this.ensureWorkItemColumn("started_at", "started_at TEXT");
    this.ensureWorkItemColumn("lease_expires_at", "lease_expires_at TEXT");
    this.ensureWorkItemColumn("lease_token_hash", "lease_token_hash TEXT");
    this.ensureAuditColumn("previous_hash", "previous_hash TEXT NOT NULL DEFAULT ''");
    this.ensureAuditColumn("event_hash", "event_hash TEXT NOT NULL DEFAULT ''");
    this.ensureApprovalColumn("request_hash", "request_hash TEXT NOT NULL DEFAULT ''");
    this.ensureApprovalColumn("approval_token_hash", "approval_token_hash TEXT NOT NULL DEFAULT ''");
    this.ensureApprovalColumn("status", "status TEXT NOT NULL DEFAULT 'granted'");
    this.ensureApprovalColumn("expires_at", "expires_at TEXT NOT NULL DEFAULT '9999-12-31T23:59:59.999Z'");
    this.ensureApprovalColumn("consumed_at", "consumed_at TEXT");
    this.backfillAuditChain();
  }

  create(input: unknown): WorkItem {
    const workItem = createWorkItem(input);
    return this.write(() => {
      this.db
        .prepare(
          `INSERT INTO work_items
           (id, title, requester, status, intent, target_json, requested_actions_json, risk, result_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`
        )
        .run(
          workItem.id,
          workItem.title,
          workItem.requester,
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

  readEvents(): StoredAuditEvent[] {
    return (this.db.prepare(`SELECT * FROM audit_events ORDER BY sequence ASC`).all() as unknown as EventRow[]).map(
      rowToEvent
    );
  }

  verifyAuditChain(): AuditChainVerification {
    return verifyAuditChain(this.readEvents());
  }

  transition(id: string, status: WorkItemStatus): WorkItem {
    if (status === "running") {
      throw new ControlStackError("worker_claim_required", "running work items must be claimed by a worker");
    }
    return this.transitionWithEvent(id, status);
  }

  approveWorkItem(id: string): WorkItem {
    return this.transition(id, "approved");
  }

  blockWorkItem(id: string): WorkItem {
    return this.transition(id, "blocked");
  }

  unblockWorkItem(id: string): WorkItem {
    return this.transition(id, "pending_policy");
  }

  cancelWorkItem(id: string, input: unknown = {}): WorkItem {
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

  registerConnector(input: ConnectorRegistration): RegisteredConnector {
    return this.write(() => {
      const now = (input.now ?? new Date()).toISOString();
      const displayName = input.displayName ?? input.id;
      const allowedScopes = uniqueNonEmpty(input.allowedScopes, "allowedScopes");
      this.db
        .prepare(
          `INSERT INTO connector_records
           (id, display_name, public_key_pem, allowed_scopes_json, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'active', ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             display_name = excluded.display_name,
             public_key_pem = excluded.public_key_pem,
             allowed_scopes_json = excluded.allowed_scopes_json,
             status = 'active',
             updated_at = excluded.updated_at`
        )
        .run(input.id, displayName, input.publicKeyPem, JSON.stringify(allowedScopes), now, now);
      const connector = this.getConnectorRequired(input.id);
      const event = this.appendAuditEvent(
        createEvent(
          "connector.registered",
          {
            connectorId: connector.id,
            displayName: connector.displayName,
            allowedScopes: connector.allowedScopes,
            publicKeyFingerprint: publicKeyFingerprint(connector.publicKeyPem),
            status: connector.status
          },
          {
            "connector.id": connector.id,
            "connector.status": connector.status
          }
        )
      );
      return { value: connector, events: [event] };
    });
  }

  registerTunnelSession(input: TunnelSessionRegistration): RegisteredTunnelSession {
    return this.write(() => {
      const connector = this.getConnectorRequired(input.connectorId);
      if (connector.status !== "active") {
        throw new ControlStackError("connector_revoked", `connector is not active: ${input.connectorId}`);
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
      const event = this.appendAuditEvent(
        createEvent(
          "tunnel_session.registered",
          { ...session },
          {
            "connector.id": session.connectorId,
            "tunnel.id": session.tunnelId,
            "tunnel.session_id": session.sessionId,
            "tunnel.session_status": session.status
          }
        )
      );
      return { value: session, events: [event] };
    });
  }

  heartbeatTunnelSession(input: TunnelSessionRef): RegisteredTunnelSession {
    return this.write(() => {
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
      const event = this.appendAuditEvent(
        createEvent(
          "tunnel_session.heartbeat",
          { ...session },
          {
            "connector.id": session.connectorId,
            "tunnel.id": session.tunnelId,
            "tunnel.session_id": session.sessionId
          }
        )
      );
      return { value: session, events: [event] };
    });
  }

  revokeTunnelSession(input: TunnelSessionRef): RegisteredTunnelSession {
    return this.write(() => {
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
      const event = this.appendAuditEvent(
        createEvent(
          "tunnel_session.revoked",
          { ...session },
          {
            "connector.id": session.connectorId,
            "tunnel.id": session.tunnelId,
            "tunnel.session_id": session.sessionId,
            "tunnel.session_status": session.status
          }
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

  private write<T>(operation: () => { value: T; events: StoredAuditEvent[] }): T {
    this.db.exec("BEGIN IMMEDIATE");
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
      throw error;
    }

    for (const event of result.events) {
      try {
        this.onEvent(event);
      } catch {
        // Post-commit notifications are best-effort; state and audit already committed.
      }
    }

    return result.value;
  }

  private ensureWorkItemColumn(name: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(work_items)`).all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === name)) {
      this.db.exec(`ALTER TABLE work_items ADD COLUMN ${definition}`);
    }
  }

  private ensureApprovalColumn(name: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(approval_records)`).all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === name)) {
      this.db.exec(`ALTER TABLE approval_records ADD COLUMN ${definition}`);
    }
  }

  private ensureAuditColumn(name: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(audit_events)`).all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === name)) {
      this.db.exec(`ALTER TABLE audit_events ADD COLUMN ${definition}`);
    }
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

function assertFutureIso(value: string, now: string, field: string): void {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || timestamp <= Date.parse(now)) {
    throw new ControlStackError("invalid_tunnel_session", `${field} must be a future ISO timestamp`);
  }
}

function publicKeyFingerprint(publicKeyPem: string): string {
  return createHash("sha256").update(publicKeyPem).digest("base64url");
}
