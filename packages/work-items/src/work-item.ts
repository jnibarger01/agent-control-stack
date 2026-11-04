import { ControlStackError, createEvent, createId, stableHash, type AuditEvent } from "@agent-control-stack/shared";
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

// Discriminated on `executionMode`. The `dry_run` branch is byte-identical to
// the schema that has always shipped; the `desktop_commander` branch is the
// only way a non-simulated result can be persisted, and it can only be produced
// by the ACS worker after the full execution-authorization chain has passed.
const simulationMetadataSchema = z.discriminatedUnion("executionMode", [
  z
    .object({
      executionMode: z.literal("dry_run"),
      simulated: z.literal(true),
      workerVersion: identifierSchema.optional(),
      reason: z.string().max(512).optional()
    })
    .strict(),
  z
    .object({
      executionMode: z.literal("desktop_commander"),
      simulated: z.literal(false),
      backend: z.literal("desktop-commander-mcp"),
      backendVersion: z.string().max(128).optional(),
      /**
       * True when execution was authorized-then-denied before any Desktop
       * Commander invocation. A blocked execution is a real desktop_commander
       * authorization outcome, never a simulated dry run; toolName and
       * invocationFingerprint are only required once a tool was invoked.
       */
      blocked: z.literal(true).optional(),
      toolName: z.string().min(1).max(128).optional(),
      invocationFingerprint: hashSchema.optional(),
      requestId: identifierSchema,
      approvalId: identifierSchema.optional(),
      workerVersion: identifierSchema.optional(),
      reason: z.string().max(512).optional()
    })
    .strict()
    .superRefine((value, context) => {
      if (value.blocked) return;
      if (value.toolName === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["toolName"],
          message: "toolName is required unless the execution was blocked before invocation"
        });
      }
      if (value.invocationFingerprint === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["invocationFingerprint"],
          message: "invocationFingerprint is required unless the execution was blocked before invocation"
        });
      }
    }),
  z
    .object({
      executionMode: z.literal("jace_commander"),
      simulated: z.literal(false),
      backend: z.literal("jace-commander-mcp"),
      backendVersion: z.string().max(128).optional(),
      toolName: z.string().min(1).max(128),
      invocationFingerprint: hashSchema,
      requestId: identifierSchema,
      approvalId: identifierSchema.optional(),
      workerVersion: identifierSchema.optional(),
      reason: z.string().max(512).optional()
    })
    .strict(),
  // ARES Studio executes its own approved ares.* actions in its sandbox and reports through the
  // worker lease; the gateway restricts this mode to ares.* work items.
  z
    .object({
      executionMode: z.literal("ares"),
      simulated: z.literal(false),
      backend: z.literal("ares-studio"),
      backendVersion: z.string().max(128).optional(),
      toolName: z.string().min(1).max(128),
      invocationFingerprint: hashSchema,
      requestId: identifierSchema,
      approvalId: identifierSchema.optional(),
      workerVersion: identifierSchema.optional(),
      reason: z.string().max(512).optional()
    })
    .strict()
]);

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

/** Default page size for list_work_items when the client omits `limit`. */
export const DEFAULT_WORK_ITEM_LIST_LIMIT = 100;
/** Hard server cap for list_work_items (and store.list when `limit` is set). */
export const MAX_WORK_ITEM_LIST_LIMIT = 500;

/**
 * Clamp an oversize positive integer page size down to {@link MAX_WORK_ITEM_LIST_LIMIT}.
 * Invalid values are left untouched so Zod can reject them with a stable error.
 */
export function clampWorkItemListLimit(value: unknown): unknown {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const numeric = typeof value === "number" ? value : Number(value);
  if (typeof numeric === "number" && Number.isInteger(numeric) && numeric > MAX_WORK_ITEM_LIST_LIMIT) {
    return MAX_WORK_ITEM_LIST_LIMIT;
  }
  return Number.isNaN(numeric) ? value : numeric;
}

export const listWorkItemsSchema = z.object({
  status: workItemStatusSchema.optional(),
  limit: z.preprocess(clampWorkItemListLimit, z.number().int().min(1).max(MAX_WORK_ITEM_LIST_LIMIT).optional())
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
  assertAresActionShape(parsed.requestedActions);
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

/**
 * ARES Studio actions. This is the ONE definition of which action kinds belong to ARES; policy-gate and the gateway
 * import it from here.
 */
export const ARES_ACTION_KIND_LIST = [
  "ares.analyze.local",
  "ares.adapter.ghidra",
  "ares.adapter.rea",
  "ares.spec.seal",
  "ares.oracle.run",
  "ares.task.decide"
] as const;
export const ARES_ACTION_KINDS: ReadonlySet<string> = new Set(ARES_ACTION_KIND_LIST);

/** An ARES work item has exactly one requested action and it is a known ares.* kind. The strict definition. */
export function isAresWorkItem(workItem: Pick<WorkItem, "requestedActions">): boolean {
  const [only, ...rest] = workItem.requestedActions;
  return only !== undefined && rest.length === 0 && ARES_ACTION_KINDS.has(only.kind);
}

/** Any requested action, known or not, in the ares.* namespace. The broader definition, used to fail closed. */
export function mentionsAresKind(workItem: Pick<WorkItem, "requestedActions">): boolean {
  return workItem.requestedActions.some((action) => action.kind.startsWith("ares."));
}

/**
 * ARES items cannot be mixed: an item that mentions ares.* must be a strict ARES item. This removes the only way
 * the strict and broad definitions could disagree about a stored item.
 */
function assertAresActionShape(requestedActions: readonly { kind: string }[]): void {
  const candidate = { requestedActions } as Pick<WorkItem, "requestedActions">;
  if (mentionsAresKind(candidate) && !isAresWorkItem(candidate)) {
    throw new z.ZodError([
      {
        code: "custom",
        path: ["requestedActions"],
        message: "an ares.* work item must have exactly one requested action, and it must be a known ARES action kind"
      }
    ]);
  }
}

/**
 * ARES Studio items name their executor in target.services. Unlike the registry-agent target rule
 * (which only binds registered agents), this binds unconditionally: a worker that is not named can
 * never claim an `ares.*` item, by id or by claim-next. Non-ARES items are unaffected. Items in the
 * broader ares.* namespace must also satisfy the strict shape, including when loaded from storage.
 */
export function aresItemTargetsWorker(
  workItem: Pick<WorkItem, "target" | "requestedActions">,
  workerId: string
): boolean {
  return (
    !mentionsAresKind(workItem) || (isAresWorkItem(workItem) && (workItem.target.services ?? []).includes(workerId))
  );
}

/** Validate ARES receipt labels against ACS-owned work and attempt identity, inside result acceptance. */
export function assertAresResultBinding(
  workItem: Pick<WorkItem, "requestedActions" | "target">,
  input: Pick<SubmitWorkResultInput, "simulationMetadata" | "attemptId" | "structuredOutput" | "workerId">
): void {
  const metadata = input.simulationMetadata;
  const ares = isAresWorkItem(workItem);
  if ((mentionsAresKind(workItem) && !ares) || ares !== (metadata.executionMode === "ares")) {
    throw new ControlStackError("result_mode_mismatch", "result mode does not match the work item");
  }
  if (!ares || metadata.executionMode !== "ares") return;
  const action = workItem.requestedActions[0]!;
  if (
    !aresItemTargetsWorker(workItem, input.workerId) ||
    !input.attemptId ||
    metadata.requestId !== input.attemptId ||
    metadata.toolName !== action.kind
  ) {
    throw new ControlStackError(
      "ares_result_binding_mismatch",
      "ARES receipt does not match the approved action and attempt"
    );
  }
  // ARES's local argument digest uses its own canonical form. ACS binds that digest as part of
  // the exact approved params rather than pretending the local principal or digest is ACS authority.
  if (action.params.aresArgsHash !== undefined) {
    const argsHash = hashSchema.parse(action.params.aresArgsHash);
    const digest = input.structuredOutput.resultDigest;
    if (
      input.structuredOutput.aresArgsHash !== argsHash ||
      !(digest === null || (typeof digest === "string" && /^[a-f0-9]{64}$/u.test(digest))) ||
      metadata.invocationFingerprint !==
        stableHash({ domain: "ares.invocation.v1", attemptId: input.attemptId, argsHash, resultDigest: digest })
    ) {
      throw new ControlStackError(
        "ares_result_binding_mismatch",
        "ARES receipt does not match the approved argument digest"
      );
    }
  }
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
