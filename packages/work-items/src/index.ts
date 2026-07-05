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
  created_at: string;
  updated_at: string;
}

export interface WorkItemStore {
  create(input: unknown): WorkItem;
  get(id: string): WorkItem | undefined;
  list(input?: unknown): WorkItem[];
  transition(id: string, status: WorkItemStatus): WorkItem;
  approveWorkItem(id: string): WorkItem;
  cancelWorkItem(id: string): WorkItem;
  startWorkItem(id: string): WorkItem;
  submitWorkResult(input: unknown): WorkItem;
}

export class SqliteWorkItemStore implements WorkItemStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
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
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  create(input: unknown): WorkItem {
    const workItem = createWorkItem(input);
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
    return workItem;
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

  transition(id: string, status: WorkItemStatus): WorkItem {
    const current = this.getRequired(id);
    const updated = transitionWorkItem(current, status);
    const result = this.db
      .prepare(`UPDATE work_items SET status = ?, updated_at = ? WHERE id = ? AND status = ?`)
      .run(updated.status, updated.updatedAt, id, current.status);
    if (result.changes !== 1) {
      throw new ControlStackError("work_item_conflict", `work item changed while transitioning: ${id}`);
    }
    return updated;
  }

  approveWorkItem(id: string): WorkItem {
    return this.transition(id, "approved");
  }

  cancelWorkItem(id: string): WorkItem {
    return this.transition(id, "cancelled");
  }

  startWorkItem(id: string): WorkItem {
    return this.transition(id, "running");
  }

  submitWorkResult(input: unknown): WorkItem {
    const parsed = submitWorkResultSchema.parse(input);
    const current = this.getRequired(parsed.id);
    const updated = transitionWorkItem(current, parsed.status);
    const result = this.db
      .prepare(`UPDATE work_items SET status = ?, updated_at = ?, result_json = ? WHERE id = ? AND status = ?`)
      .run(updated.status, updated.updatedAt, JSON.stringify(parsed.result), parsed.id, current.status);
    if (result.changes !== 1) {
      throw new ControlStackError("work_item_conflict", `work item changed while submitting result: ${parsed.id}`);
    }
    return updated;
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
}

export function createWorkItem(input: unknown, now = new Date().toISOString()): WorkItem {
  const parsed = createWorkItemSchema.parse(input);
  return workItemSchema.parse({
    id: createId("wrk"),
    ...parsed,
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

export function createWorkItemTools(store: WorkItemStore, emit: (event: AuditEvent) => void = () => undefined) {
  return {
    create_work_item(input: unknown): WorkItem {
      const workItem = store.create(input);
      emit(workItemCreatedEvent(workItem));
      return workItem;
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
      const workItem = store.approveWorkItem(parsed.id);
      emit(workItemStatusEvent(workItem));
      return workItem;
    },
    cancel_work_item(input: unknown): WorkItem {
      const parsed = z.object({ id: z.string().min(1) }).merge(cancelRequestSchema).parse(input);
      const workItem = store.cancelWorkItem(parsed.id);
      emit(workItemStatusEvent(workItem));
      return workItem;
    },
    submit_work_result(input: unknown): WorkItem {
      const workItem = store.submitWorkResult(input);
      emit(workItemStatusEvent(workItem));
      return workItem;
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

function workItemAttributes(workItem: WorkItem): Record<string, string> {
  return {
    "work_item.id": workItem.id,
    "work_item.status": workItem.status,
    "work_item.risk": workItem.risk,
    "work_item.requester": workItem.requester
  };
}
