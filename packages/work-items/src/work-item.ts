import { createEvent, createId, stableHash, type AuditEvent } from "@agent-control-stack/shared";
import { z } from "zod";

export const requesterSchema = z.enum(["user", "agent", "system"]);
export const workItemRiskSchema = z.enum(["low", "medium", "high", "critical"]);
export const workItemStatusSchema = z.enum([
  "draft",
  "pending_policy",
  "needs_approval",
  "approved",
  "running",
  "cancelling",
  "succeeded",
  "failed",
  "blocked",
  "cancelled",
  "rejected",
  "unknown",
  "quarantined"
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

const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/iu);
const timestampSchema = z.string().datetime({ offset: true }).max(64);
const boundedSummarySchema = z.string().min(1).max(2_000);
const boundedOutputSchema = z
  .string()
  .max(64_000)
  .refine((value) => Buffer.byteLength(value, "utf8") <= 64_000, "output exceeds 64 KiB");
const boundedErrorSchema = z
  .string()
  .max(4_000)
  .refine((value) => Buffer.byteLength(value, "utf8") <= 4_000, "error exceeds 4 KiB");
const lineageTypeSchema = z.enum(["retry", "clone"]);
const noControlCharacters = (value: string): boolean =>
  [...value].every((character) => character.charCodeAt(0) >= 0x20);

const artifactSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(256)
      .refine(
        (value) => !value.includes("/") && !value.includes("\\") && noControlCharacters(value),
        "artifact name contains an unsafe character"
      ),
    kind: identifierSchema.optional(),
    mediaType: z
      .string()
      .min(1)
      .max(128)
      .refine(noControlCharacters, "media type contains a control character")
      .optional(),
    sizeBytes: z
      .number()
      .int()
      .nonnegative()
      .max(16 * 1024 * 1024)
      .optional(),
    sha256: hashSchema.optional()
  })
  .strict();

const resourceUsageSchema = z
  .object({
    durationMs: z.number().int().nonnegative().max(86_400_000).optional(),
    cpuMs: z.number().int().nonnegative().max(86_400_000).optional(),
    memoryBytes: z
      .number()
      .int()
      .nonnegative()
      .max(4 * 1024 * 1024 * 1024)
      .optional()
  })
  .strict();

const simulationMetadataSchema = z
  .object({
    executionMode: z.literal("dry_run"),
    simulated: z.literal(true),
    workerVersion: identifierSchema.optional(),
    reason: z.string().max(512).optional()
  })
  .strict();

const structuredOutputSchema = z.record(z.string(), z.unknown()).superRefine((value, context) => {
  validateStructuredValue(value, context, "structuredOutput", 0);
  try {
    const serialized = JSON.stringify(value);
    if (serialized && Buffer.byteLength(serialized, "utf8") > 64_000) {
      context.addIssue({ code: z.ZodIssueCode.too_big, origin: "string", maximum: 64_000, inclusive: true });
    }
  } catch {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["structuredOutput"],
      message: "structured output must be JSON serializable"
    });
  }
});

/**
 * Caller-supplied provenance that isn't part of the work item's own
 * governed fields (title/intent/target/actions) but still needs to survive
 * to the persisted record - e.g. an external webhook's correlationId, so a
 * caller can trace the work item it produced back to the event that
 * created it. Strict: this is not a general escape hatch for smuggling
 * unvalidated data into a governed work item.
 */
export const workItemMetadataSchema = z
  .object({
    webhookSource: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9_-]{1,64}$/iu)
      .optional(),
    correlationId: z.string().min(1).max(512).optional()
  })
  .strict();

export const createWorkItemSchema = z.object({
  title: z.string().min(1),
  requester: requesterSchema,
  requesterSubject: z.string().min(1).optional(),
  status: z.enum(["draft", "pending_policy"]).default("pending_policy"),
  intent: z.string().min(1),
  target: targetSchema,
  requestedActions: z.array(actionRequestSchema).default([]),
  risk: workItemRiskSchema.default("medium"),
  metadata: workItemMetadataSchema.optional()
});

export const workItemSchema = createWorkItemSchema.extend({
  id: z.string().min(1),
  status: workItemStatusSchema,
  result: z.record(z.string(), z.unknown()).optional(),
  sourceWorkItemId: z.string().min(1).optional(),
  lineageType: lineageTypeSchema.optional(),
  retryReason: z.string().min(1).max(2_000).optional(),
  retrySequence: z.number().int().nonnegative().optional(),
  rootWorkItemId: z.string().min(1).optional(),
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

export const submitWorkResultSchema = z
  .object({
    workItemId: identifierSchema,
    attemptId: identifierSchema.optional(),
    leaseId: identifierSchema,
    workerId: identifierSchema,
    actionHash: hashSchema,
    planHash: hashSchema.optional(),
    inputHash: hashSchema.optional(),
    fencingEpoch: z.number().int().positive().optional(),
    idempotencyKey: identifierSchema,
    outcome: z.enum(["succeeded", "failed", "cancelled", "worker_infrastructure_failure", "blocked", "lease_expired"]),
    startedAt: timestampSchema,
    finishedAt: timestampSchema,
    exitCode: z.number().int().min(-255).max(255).nullable().optional(),
    summary: boundedSummarySchema,
    stdout: boundedOutputSchema.optional(),
    stderr: boundedOutputSchema.optional(),
    structuredOutput: structuredOutputSchema.default({}),
    artifacts: z.array(artifactSchema).max(32).default([]),
    error: boundedErrorSchema.optional(),
    resourceUsage: resourceUsageSchema.optional(),
    simulationMetadata: simulationMetadataSchema
  })
  .strict()
  .superRefine((value, context) => {
    const startedAt = Date.parse(value.startedAt);
    const finishedAt = Date.parse(value.finishedAt);
    if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt) || finishedAt < startedAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["finishedAt"],
        message: "finishedAt must not precede startedAt"
      });
    }
    if (
      value.outcome === "succeeded" &&
      value.exitCode !== undefined &&
      value.exitCode !== null &&
      value.exitCode !== 0
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["exitCode"],
        message: "succeeded results require exitCode 0"
      });
    }
    if ((value.outcome === "succeeded" || value.outcome === "cancelled") && value.error !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["error"],
        message: "successful or cancelled results cannot contain an error"
      });
    }
    if (value.outcome === "cancelled" && value.exitCode !== undefined && value.exitCode !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["exitCode"],
        message: "cancelled results cannot contain an exit code"
      });
    }
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
export type RejectRequest = z.infer<typeof rejectRequestSchema>;
export type SubmitWorkResultInput = z.infer<typeof submitWorkResultSchema>;
export type ResultOutcome = SubmitWorkResultInput["outcome"] | "blocked" | "lease_expired";
export type ClaimedWorkItem = WorkItem & {
  workerId: string;
  leaseToken: string;
  leaseId: string;
  actionHash: string;
  attemptId?: string;
  planHash?: string;
  inputHash?: string;
  fencingEpoch?: number;
  workspaceHash?: string;
  startedAt: string;
  leaseExpiresAt: string;
};

export const WorkItemEvent = {
  Created: "work_item.created",
  PendingPolicy: "work_item.pending_policy",
  NeedsApproval: "work_item.needs_approval",
  Approved: "work_item.approved",
  Running: "work_item.running",
  Cancelling: "work_item.cancelling",
  Succeeded: "work_item.succeeded",
  Failed: "work_item.failed",
  Blocked: "work_item.blocked",
  Cancelled: "work_item.cancelled",
  Rejected: "work_item.rejected",
  Unknown: "work_item.unknown",
  Quarantined: "work_item.quarantined"
} as const;

const statusEvents: Record<WorkItemStatus, (typeof WorkItemEvent)[keyof typeof WorkItemEvent]> = {
  draft: WorkItemEvent.Created,
  pending_policy: WorkItemEvent.PendingPolicy,
  needs_approval: WorkItemEvent.NeedsApproval,
  approved: WorkItemEvent.Approved,
  running: WorkItemEvent.Running,
  cancelling: WorkItemEvent.Cancelling,
  succeeded: WorkItemEvent.Succeeded,
  failed: WorkItemEvent.Failed,
  blocked: WorkItemEvent.Blocked,
  cancelled: WorkItemEvent.Cancelled,
  rejected: WorkItemEvent.Rejected,
  unknown: WorkItemEvent.Unknown,
  quarantined: WorkItemEvent.Quarantined
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

export function executionActionHash(
  workItem: Pick<WorkItem, "id" | "requester" | "intent" | "target" | "requestedActions" | "risk">
): string {
  return stableHash({
    domain: "acs.execution-action",
    workItemId: workItem.id,
    requester: workItem.requester,
    intent: workItem.intent,
    target: workItem.target,
    requestedActions: workItem.requestedActions,
    risk: workItem.risk
  });
}

export function workItemCreatedEvent(workItem: WorkItem): AuditEvent {
  return createEvent(WorkItemEvent.Created, workItem, workItemAttributes(workItem));
}

export function workItemStatusEvent(
  workItem: WorkItem,
  body: Record<string, unknown> = {},
  attributes: Record<string, string> = {}
): AuditEvent {
  return createEvent(
    statusEvents[workItem.status],
    { ...workItem, ...body },
    { ...workItemAttributes(workItem), ...attributes }
  );
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

const unsafeStructuredKey =
  /(token|secret|password|authorization|credential|environment|^env$|^path$|^cwd$|^file$|^directory$|command)/iu;

function validateStructuredValue(value: unknown, context: z.RefinementCtx, path: string, depth: number): void {
  if (depth > 5) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: [path], message: "structured output is too deeply nested" });
    return;
  }
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > 16_000) {
      context.addIssue({
        code: z.ZodIssueCode.too_big,
        path: [path],
        origin: "string",
        maximum: 16_000,
        inclusive: true
      });
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 64) {
      context.addIssue({ code: z.ZodIssueCode.too_big, path: [path], origin: "array", maximum: 64, inclusive: true });
    }
    value.forEach((entry, index) => validateStructuredValue(entry, context, `${path}.${index}`, depth + 1));
    return;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 64) {
      context.addIssue({ code: z.ZodIssueCode.too_big, path: [path], origin: "object", maximum: 64, inclusive: true });
    }
    for (const [key, entry] of entries) {
      if (!/^[A-Za-z0-9_.-]{1,64}$/u.test(key) || unsafeStructuredKey.test(key)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: [path, key], message: "unsafe structured output key" });
      }
      validateStructuredValue(entry, context, `${path}.${key}`, depth + 1);
    }
  }
}
