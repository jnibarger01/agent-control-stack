import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ControlStackError,
  controlPlaneMigrationSql,
  createEvent,
  stableHash,
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

export interface StoredAuditEvent extends AuditEvent {
  sequence: number;
}

interface EventRow {
  sequence: number;
  id: string;
  name: string;
  time_unix_nano: string;
  attributes: string;
  body: string;
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
  transition(id: string, status: WorkItemStatus): WorkItem;
  approveWorkItem(id: string): WorkItem;
  blockWorkItem(id: string): WorkItem;
  unblockWorkItem(id: string): WorkItem;
  cancelWorkItem(id: string, input?: unknown): WorkItem;
  recordPolicyDecision(input: PolicyDecisionRecord): StoredAuditEvent;
  recordApproval(input: ApprovalRecord): StoredAuditEvent;
  hasApproval(workItemId: string, actionHash: string): boolean;
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

  transition(id: string, status: WorkItemStatus): WorkItem {
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

  recordApproval(input: ApprovalRecord): StoredAuditEvent {
    return this.write(() => {
      const createdAt = input.createdAt ?? new Date().toISOString();
      const reason = input.reason ?? "approved";
      this.db
        .prepare(
          `INSERT INTO approval_records (work_item_id, action_hash, approved_by, reason, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(work_item_id, action_hash) DO UPDATE SET
             approved_by = excluded.approved_by,
             reason = excluded.reason,
             created_at = excluded.created_at`
        )
        .run(input.workItemId, input.actionHash, input.approvedBy, reason, createdAt);
      const event = this.appendAuditEvent(
        createEvent(
          "approval.granted",
          { ...input, reason, createdAt },
          {
            "work_item.id": input.workItemId,
            "action.hash": input.actionHash,
            "approval.approved_by": input.approvedBy
          }
        )
      );
      return { value: event, events: [event] };
    });
  }

  hasApproval(workItemId: string, actionHash: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM approval_records WHERE work_item_id = ? AND action_hash = ?`)
      .get(workItemId, actionHash);
    return Boolean(row);
  }

  startWorkItem(id: string, workerId = "local-worker", options: ClaimOptions = {}): ClaimedWorkItem {
    const leaseToken = createLeaseToken();
    const workItem = this.transitionWithEvent(id, "running", {
      leaseMs: options.leaseMs,
      leaseToken,
      workerId
    });
    return { ...workItem, leaseToken };
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

      return { value: { ...updated, leaseToken }, events: [this.appendAuditEvent(workItemStatusEvent(updated))] };
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
        const result = this.db
          .prepare(
            `UPDATE work_items
             SET status = ?, updated_at = ?, result_json = ?, lease_expires_at = NULL, lease_token_hash = NULL
             WHERE id = ? AND status = 'running' AND lease_expires_at = ?`
          )
          .run(
            updated.status,
            updated.updatedAt,
            JSON.stringify({ error: "worker lease expired" }),
            updated.id,
            row.lease_expires_at
          );
        if (result.changes === 1) {
          failed.push(updated);
          events.push(this.appendAuditEvent(workItemStatusEvent(updated)));
        }
      }

      return { value: failed, events };
    });
  }

  submitWorkResult(input: unknown): WorkItem {
    const parsed = submitWorkResultSchema.parse(input);
    return this.write(() => {
      const row = this.getRowRequired(parsed.id);
      const current = rowToWorkItem(row);
      const updated = transitionWorkItem(current, parsed.status);
      const expectedLeaseHash = hashLeaseToken(parsed.id, parsed.workerId, parsed.leaseToken);

      if (row.worker_id !== parsed.workerId || row.lease_token_hash !== expectedLeaseHash) {
        throw new ControlStackError("worker_lease_mismatch", `worker lease does not match work item: ${parsed.id}`);
      }
      if (row.lease_expires_at && Date.parse(row.lease_expires_at) < Date.now()) {
        throw new ControlStackError("worker_lease_expired", `worker lease expired for work item: ${parsed.id}`);
      }

      const result = this.db
        .prepare(
          `UPDATE work_items
           SET status = ?, updated_at = ?, result_json = ?, lease_expires_at = NULL, lease_token_hash = NULL
           WHERE id = ? AND status = 'running' AND worker_id = ? AND lease_token_hash = ?`
        )
        .run(
          updated.status,
          updated.updatedAt,
          JSON.stringify(parsed.result),
          parsed.id,
          parsed.workerId,
          expectedLeaseHash
        );
      if (result.changes !== 1) {
        throw new ControlStackError("work_item_conflict", `work item changed while submitting result: ${parsed.id}`);
      }
      return { value: updated, events: [this.appendAuditEvent(workItemStatusEvent(updated))] };
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
    this.db
      .prepare(
        `INSERT INTO audit_events (id, name, time_unix_nano, attributes, body)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(event.id, event.name, event.timeUnixNano, JSON.stringify(event.attributes), JSON.stringify(event.body));
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
    body: JSON.parse(row.body) as StoredAuditEvent["body"]
  };
}

function createLeaseToken(): string {
  return randomBytes(32).toString("base64url");
}

function hashLeaseToken(workItemId: string, workerId: string, leaseToken: string): string {
  return stableHash({ leaseToken, workItemId, workerId });
}
