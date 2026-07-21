import { createEvent, createId, type AuditEvent } from "@agent-control-stack/shared";
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
  "cancelled",
  "rejected"
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
  requesterSubject: z.string().min(1).optional(),
  status: z.enum(["draft", "pending_policy"]).default("pending_policy"),
  intent: z.string().min(1),
  target: targetSchema,
  requestedActions: z.array(actionRequestSchema).default([]),
  risk: workItemRiskSchema.default("medium")
});

export const workItemSchema = createWorkItemSchema.extend({
  id: z.string().min(1),
  status: workItemStatusSchema,
  result: z.record(z.string(), z.unknown()).optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1)
});

export const approvalRequestSchema = z.object({
  approvedBy: z.string().min(1),
  reason: z.string().min(1).optional(),
  actionHash: z.string().min(1)
});

export const cancelRequestSchema = z.object({
  actor: z.string().min(1),
  reason: z.string().min(1).optional()
});
export const rejectRequestSchema = cancelRequestSchema;

export const executionModeSchema = z.enum(["not_started", "dry_run", "controlled_action", "sandboxed_agent"]);
const timestampSchema = z.string().datetime({ offset: true });
const boundedTextSchema = z.string().max(20_000);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/i);
export const evidenceRecordSchema = z
  .object({
    evidence_id: z.string().min(1).max(256),
    evidence_type: z.enum(["command", "filesystem", "agent", "service", "config", "verification", "summary"]),
    label: z.string().min(1).max(256),
    content: boundedTextSchema.optional(),
    content_hash: hashSchema,
    size_bytes: z.number().int().nonnegative(),
    redacted: z.boolean(),
    truncated: z.boolean(),
    executor_id: z.string().min(1).max(256),
    created_at: timestampSchema,
    metadata: z.record(z.string(), z.unknown()).default({})
  })
  .strict();
const verificationResultSchema = z
  .object({
    command: z.string().min(1).max(1_000),
    ok: z.boolean(),
    exit_code: z.number().int().nullable().optional(),
    summary: boundedTextSchema.optional()
  })
  .strict();

export const workerResultSchema = z
  .object({
    execution_mode: executionModeSchema,
    agent: z.string().min(1).max(128).optional(),
    provider: z.string().min(1).max(128).optional(),
    model: z.string().min(1).max(256).optional(),
    started_at: timestampSchema.optional(),
    completed_at: timestampSchema.optional(),
    exit_code: z.number().int().nullable().optional(),
    timed_out: z.boolean().optional(),
    stdout_summary: boundedTextSchema.optional(),
    stderr_summary: boundedTextSchema.optional(),
    output: boundedTextSchema.optional(),
    output_truncated: z.boolean().optional(),
    error: boundedTextSchema.optional(),
    summary: boundedTextSchema.optional(),
    changed_paths: z.array(z.string().min(1).max(1_000)).max(200).optional(),
    verification_commands: z.array(z.string().min(1).max(1_000)).max(100).optional(),
    verification_results: z.array(verificationResultSchema).max(100).optional(),
    workspace_before_hash: hashSchema.optional(),
    workspace_after_hash: hashSchema.optional(),
    sandbox_identity: z.string().min(1).max(512).optional(),
    lease_id: z.string().min(1).max(256).optional(),
    action_hashes: z.array(hashSchema).max(100).optional(),
    executor_id: z.string().min(1).max(256).optional(),
    repository_commit: z.string().min(1).max(256).optional(),
    repository_worktree_state: boundedTextSchema.optional(),
    evidence: z.array(evidenceRecordSchema).max(100).optional(),
    evidence_source: z.enum(["worker_reported", "acs_derived"]).optional(),
    recorded_at: timestampSchema.optional()
  })
  .strict();

export const submitWorkResultSchema = z.object({
  id: z.string().min(1),
  workerId: z.string().min(1),
  leaseToken: z.string().min(1),
  status: z.enum(["succeeded", "failed", "blocked"]),
  result: z.record(z.string(), z.unknown()).default({})
}).strict();

export const listWorkItemsSchema = z.object({
  status: workItemStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  afterCreatedAt: z.string().min(1).max(128).optional(),
  afterId: z.string().min(1).max(128).optional()
}).refine(
  (value) => (value.afterCreatedAt === undefined) === (value.afterId === undefined),
  "afterCreatedAt and afterId must be provided together"
);

export type Requester = z.infer<typeof requesterSchema>;
export type WorkItemRisk = z.infer<typeof workItemRiskSchema>;
export type WorkItemStatus = z.infer<typeof workItemStatusSchema>;
export type ActionRequest = z.infer<typeof actionRequestSchema>;
export type CreateWorkItemInput = z.infer<typeof createWorkItemSchema>;
export type WorkItem = z.infer<typeof workItemSchema>;
export type ApprovalRequest = z.infer<typeof approvalRequestSchema>;
export type CancelRequest = z.infer<typeof cancelRequestSchema>;
export type RejectRequest = z.infer<typeof rejectRequestSchema>;
export type SubmitWorkResultInput = z.infer<typeof submitWorkResultSchema>;
export type WorkerResult = z.infer<typeof workerResultSchema>;
export type EvidenceRecord = z.infer<typeof evidenceRecordSchema>;
export type ClaimedWorkItem = WorkItem & {
  workerId: string;
  leaseToken: string;
  leaseExpiresAt: string;
  leaseId: string;
};

export const WorkItemEvent = {
  Created: "work_item.created",
  PendingPolicy: "work_item.pending_policy",
  NeedsApproval: "work_item.needs_approval",
  Approved: "work_item.approved",
  Running: "work_item.running",
  Succeeded: "work_item.succeeded",
  Failed: "work_item.failed",
  Blocked: "work_item.blocked",
  Cancelled: "work_item.cancelled",
  Rejected: "work_item.rejected"
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
  cancelled: WorkItemEvent.Cancelled,
  rejected: WorkItemEvent.Rejected
};

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

export function createNotStartedResult(error: string): WorkerResult {
  return workerResultSchema.parse({ execution_mode: "not_started", error, evidence_source: "acs_derived" });
}

export function workItemCreatedEvent(workItem: WorkItem): AuditEvent {
  return createEvent(WorkItemEvent.Created, workItem, workItemAttributes(workItem));
}

export function workItemStatusEvent(
  workItem: WorkItem,
  body: Record<string, unknown> = {},
  attributes: Record<string, string> = {}
): AuditEvent {
  return createEvent(statusEvents[workItem.status], { ...workItem, ...body }, { ...workItemAttributes(workItem), ...attributes });
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

function workItemAttributes(workItem: WorkItem): Record<string, string> {
  return {
    "work_item.id": workItem.id,
    "work_item.status": workItem.status,
    "work_item.risk": workItem.risk,
    "work_item.requester": workItem.requester,
    ...(workItem.requesterSubject ? { "work_item.requester_subject": workItem.requesterSubject } : {})
  };
}
