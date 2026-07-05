import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ControlStackError, createEvent, createId, type AuditEvent } from "@agent-control-stack/shared";
import { z } from "zod";

export const requesterSchema = z.enum(["user", "agent", "system"]);
export const workItemRiskSchema = z.enum(["low", "medium", "high", "critical"]);
export const workItemStatusSchema = z.enum([
  "draft",
  "pending_policy",
  "needs_approval",
  "approved",
  "running",
  "succeeded",
  "failed",
  "blocked",
  "cancelled"
]);

export const targetSchema = z
  .object({
    repo: z.string().min(1).optional(),
    cwd: z.string().min(1).optional(),
    files: z.array(z.string().min(1)).optional(),
    services: z.array(z.string().min(1)).optional()
  })
  .default({});

export const actionRequestSchema = z.object({
  kind: z.string().min(1),
  description: z.string().min(1),
  params: z.record(z.string(), z.unknown()).default({})
});

export const createWorkItemSchema = z.object({
  title: z.string().min(1),
  requester: requesterSchema,
  status: z.enum(["draft", "pending_policy"]).default("pending_policy"),
  intent: z.string().min(1),
  target: targetSchema,
  requestedActions: z.array(actionRequestSchema).default([]),
  risk: workItemRiskSchema.default("medium")
});

export const workItemSchema = createWorkItemSchema.extend({
  id: z.string().min(1),
  status: workItemStatusSchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1)
});

export const approvalRequestSchema = z.object({
  approvedBy: z.string().min(1),
  reason: z.string().min(1).optional()
});

export const cancelRequestSchema = z.object({
  reason: z.string().min(1).optional()
});

export const submitWorkResultSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["succeeded", "failed", "blocked"]),
  result: z.record(z.string(), z.unknown()).default({})
});

export const listWorkItemsSchema = z.object({
  status: workItemStatusSchema.optional()
});

export type Requester = z.infer<typeof requesterSchema>;
export type WorkItemRisk = z.infer<typeof workItemRiskSchema>;
export type WorkItemStatus = z.infer<typeof workItemStatusSchema>;
export type ActionRequest = z.infer<typeof actionRequestSchema>;
export type CreateWorkItemInput = z.infer<typeof createWorkItemSchema>;
export type WorkItem = z.infer<typeof workItemSchema>;
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;
export type CancelRequest = z.infer<typeof cancelRequestSchema>;
export type SubmitWorkResultInput = z.infer<typeof submitWorkResultSchema>;

export const WorkItemEvent = {
  Created: "work_item.created",
  PendingPolicy: "work_item.pending_policy",
  NeedsApproval: "work_item.needs_approval",
  Approved: "work_item.approved",
  Running: "work_item.running",
  Succeeded: "work_item.succeeded",
  Failed: "work_item.failed",
  Blocked: "work_item.blocked",
  Cancelled: "work_item.cancelled"
} as const;

const statusEvents: Record<WorkItemStatus, (typeof WorkItemEvent)[keyof typeof WorkItemEvent]> = {
  draft: WorkItemEvent.Created,
  pending_policy: WorkItemEvent.PendingPolicy,
  needs_approval: WorkItemEvent.NeedsApproval,
  approved: WorkItemEvent.Approved,
  running: WorkItemEvent.Running,
  succeeded: WorkItemEvent.Succeeded,
  failed: WorkItemEvent.Failed,
  blocked: WorkItemEvent.Blocked,
  cancelled: WorkItemEvent.Cancelled
};

const allowedTransitions: Record<WorkItemStatus, readonly WorkItemStatus[]> = {
  draft: ["pending_policy", "cancelled"],
  pending_policy: ["needs_approval", "approved", "blocked", "cancelled"],
  needs_approval: ["approved", "blocked", "cancelled"],
  approved: ["running", "cancelled"],
  running: ["succeeded", "failed", "blocked", "cancelled"],
  succeeded: [],
  failed: [],
  blocked: ["pending_policy", "cancelled"],
  cancelled: []
};

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
  cancelWorkItem(id: string): WorkItem;
  startWorkItem(id: string, workerId?: string, options?: ClaimOptions): WorkItem;
  claimNextApprovedWorkItem(workerId: string, options?: ClaimOptions): WorkItem | undefined;
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
      CREATE TABLE IF NOT EXISTS audit_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        time_unix_nano TEXT NOT NULL,
        attributes TEXT NOT NULL,
        body TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS work_items (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        requester TEXT NOT NULL,
        status TEXT NOT NULL,
        intent TEXT NOT NULL,
        target_json TEXT NOT NULL,
        requested_actions_json TEXT NOT NULL,
        risk TEXT NOT NULL,
        result_json TEXT,
        worker_id TEXT,
        started_at TEXT,
        lease_expires_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    this.ensureWorkItemColumn("worker_id", "worker_id TEXT");
    this.ensureWorkItemColumn("started_at", "started_at TEXT");
    this.ensureWorkItemColumn("lease_expires_at", "lease_expires_at TEXT");
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

  cancelWorkItem(id: string): WorkItem {
    return this.transition(id, "cancelled");
  }

  startWorkItem(id: string, workerId = "local-worker", options: ClaimOptions = {}): WorkItem {
    return this.transitionWithEvent(id, "running", {
      leaseMs: options.leaseMs,
      workerId
    });
  }

  claimNextApprovedWorkItem(workerId: string, options: ClaimOptions = {}): WorkItem | undefined {
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
      const result = this.db
        .prepare(
          `UPDATE work_items
           SET status = ?, updated_at = ?, worker_id = ?, started_at = ?, lease_expires_at = ?
           WHERE id = ? AND status = 'approved'`
        )
        .run(updated.status, updated.updatedAt, workerId, startedAt, leaseExpiresAt, updated.id);
      if (result.changes !== 1) {
        throw new ControlStackError("work_item_conflict", `work item changed while claiming: ${updated.id}`);
      }

      return { value: updated, events: [this.appendAuditEvent(workItemStatusEvent(updated))] };
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
             SET status = ?, updated_at = ?, result_json = ?, lease_expires_at = NULL
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
      const current = this.getRequired(parsed.id);
      const updated = transitionWorkItem(current, parsed.status);
      const result = this.db
        .prepare(
          `UPDATE work_items
           SET status = ?, updated_at = ?, result_json = ?, lease_expires_at = NULL
           WHERE id = ? AND status = ?`
        )
        .run(updated.status, updated.updatedAt, JSON.stringify(parsed.result), parsed.id, current.status);
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

  private transitionWithEvent(
    id: string,
    status: WorkItemStatus,
    options: { workerId?: string; leaseMs?: number } = {}
  ): WorkItem {
    return this.write(() => {
      const current = this.getRequired(id);
      const updated = transitionWorkItem(current, status);
      const result =
        status === "running"
          ? this.db
              .prepare(
                `UPDATE work_items
                 SET status = ?, updated_at = ?, worker_id = ?, started_at = ?, lease_expires_at = ?
                 WHERE id = ? AND status = ?`
              )
              .run(
                updated.status,
                updated.updatedAt,
                options.workerId ?? "local-worker",
                updated.updatedAt,
                new Date(Date.parse(updated.updatedAt) + (options.leaseMs ?? this.leaseMs)).toISOString(),
                id,
                current.status
              )
          : this.db
              .prepare(`UPDATE work_items SET status = ?, updated_at = ? WHERE id = ? AND status = ?`)
              .run(updated.status, updated.updatedAt, id, current.status);
      if (result.changes !== 1) {
        throw new ControlStackError("work_item_conflict", `work item changed while transitioning: ${id}`);
      }
      return { value: updated, events: [this.appendAuditEvent(workItemStatusEvent(updated))] };
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
    try {
      const result = operation();
      this.db.exec("COMMIT");
      for (const event of result.events) {
        this.onEvent(event);
      }
      return result.value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private ensureWorkItemColumn(name: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(work_items)`).all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === name)) {
      this.db.exec(`ALTER TABLE work_items ADD COLUMN ${definition}`);
    }
  }
}

export function createWorkItem(input: unknown, now = new Date().toISOString()): WorkItem {
  const parsed = createWorkItemSchema.parse(input);
  const status =
    parsed.status === "pending_policy" && (parsed.risk === "high" || parsed.risk === "critical")
      ? "needs_approval"
      : parsed.status;
  return workItemSchema.parse({
    id: createId("wrk"),
    ...parsed,
    status,
    createdAt: now,
    updatedAt: now
  });
}

export function transitionWorkItem(workItem: WorkItem, status: WorkItemStatus, now = new Date().toISOString()): WorkItem {
  assertCanTransition(workItem.status, status);
  return { ...workItem, status, updatedAt: now };
}

export function assertCanTransition(from: WorkItemStatus, to: WorkItemStatus): void {
  if (!allowedTransitions[from].includes(to)) {
    throw new ControlStackError("invalid_work_item_transition", `cannot transition work item from ${from} to ${to}`);
  }
}

export function assertExecutableWorkItem(workItem: WorkItem): void {
  if (workItem.status !== "running") {
    throw new ControlStackError("work_item_not_executable", `work item ${workItem.id} is ${workItem.status}`);
  }
}

export function nextApprovedWorkItem(store: WorkItemStore): WorkItem | undefined {
  return store.list({ status: "approved" }).at(-1);
}

export function workItemCreatedEvent(workItem: WorkItem): AuditEvent {
  return createEvent(WorkItemEvent.Created, workItem, workItemAttributes(workItem));
}

export function workItemStatusEvent(workItem: WorkItem): AuditEvent {
  return createEvent(statusEvents[workItem.status], workItem, workItemAttributes(workItem));
}

export function projectWorkItems(events: AuditEvent[]): WorkItem[] {
  const workItems = new Map<string, WorkItem>();

  for (const event of events) {
    const parsed = workItemSchema.safeParse(event.body);
    if (parsed.success) {
      workItems.set(parsed.data.id, parsed.data);
    }
  }

  return [...workItems.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

export function createWorkItemTools(store: WorkItemStore) {
  return {
    create_work_item(input: unknown): WorkItem {
      return store.create(input);
    },
    get_work_item(input: unknown): WorkItem | undefined {
      const parsed = z.object({ id: z.string().min(1) }).parse(input);
      return store.get(parsed.id);
    },
    list_work_items(input: unknown = {}): WorkItem[] {
      return store.list(input);
    },
    approve_work_item(input: unknown): WorkItem {
      const parsed = z.object({ id: z.string().min(1) }).merge(approvalRequestSchema).parse(input);
      return store.approveWorkItem(parsed.id);
    },
    cancel_work_item(input: unknown): WorkItem {
      const parsed = z.object({ id: z.string().min(1) }).merge(cancelRequestSchema).parse(input);
      return store.cancelWorkItem(parsed.id);
    },
    submit_work_result(input: unknown): WorkItem {
      return store.submitWorkResult(input);
    }
  };
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

function workItemAttributes(workItem: WorkItem): Record<string, string> {
  return {
    "work_item.id": workItem.id,
    "work_item.status": workItem.status,
    "work_item.risk": workItem.risk,
    "work_item.requester": workItem.requester
  };
}
