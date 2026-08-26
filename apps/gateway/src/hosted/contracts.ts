import { createHash } from "node:crypto";
import { z } from "zod";

export const MCP_PROTOCOL_VERSION = "2024-11-05";

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
  .strict()
  .default({});

export const actionRequestSchema = z
  .object({
    kind: z.string().min(1),
    description: z.string().min(1).max(2_000),
    params: z.record(z.string(), z.unknown()).default({})
  })
  .strict();

export const workItemMetadataSchema = z
  .object({
    webhookSource: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/iu).optional(),
    correlationId: z.string().min(1).max(512).optional()
  })
  .strict();

export const workItemSchema = z
  .object({
    id: z.string().min(1).max(160),
    title: z.string().min(1).max(512),
    requester: requesterSchema,
    requesterSubject: z.string().min(1).max(512).optional(),
    status: workItemStatusSchema,
    intent: z.string().min(1).max(4_000),
    target: targetSchema,
    requestedActions: z.array(actionRequestSchema).min(1).max(32),
    risk: workItemRiskSchema,
    metadata: workItemMetadataSchema.optional(),
    result: z.record(z.string(), z.unknown()).optional(),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true })
  })
  .strict();

export type WorkItem = z.infer<typeof workItemSchema>;
export type ActionRequest = z.infer<typeof actionRequestSchema>;
export type WorkItemRisk = z.infer<typeof workItemRiskSchema>;

export const hostedCreateWorkItemSchema = z
  .object({
    title: z.string().min(1).max(512),
    intent: z.string().min(1).max(4_000),
    target: targetSchema.optional(),
    requestedActions: z.array(actionRequestSchema).min(1).max(32),
    risk: workItemRiskSchema.optional(),
    metadata: workItemMetadataSchema.optional()
  })
  .strict();

export const hostedListWorkItemsSchema = z
  .object({
    status: workItemStatusSchema.optional(),
    limit: z.coerce.number().int().positive().max(200).default(50)
  })
  .strict();

export const hostedApprovalSchema = z
  .object({
    actionHash: z.string().regex(/^[a-f0-9]{64}$/iu),
    reason: z.string().min(1).max(2_000)
  })
  .strict();

export const hostedReasonSchema = z.object({ reason: z.string().min(1).max(2_000).optional() }).strict();
export const hostedClaimSchema = z.object({ leaseMs: z.coerce.number().int().positive().optional() }).strict();

const identifierSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/iu);
const timestampSchema = z.string().datetime({ offset: true }).max(64);
const boundedOutputSchema = z.string().max(64_000).refine((value) => Buffer.byteLength(value, "utf8") <= 64_000);
const boundedErrorSchema = z.string().max(4_000).refine((value) => Buffer.byteLength(value, "utf8") <= 4_000);

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
    outcome: z.enum([
      "succeeded",
      "failed",
      "cancelled",
      "worker_infrastructure_failure",
      "blocked",
      "lease_expired"
    ]),
    startedAt: timestampSchema,
    finishedAt: timestampSchema,
    exitCode: z.number().int().min(-255).max(255).nullable().optional(),
    summary: z.string().min(1).max(2_000),
    stdout: boundedOutputSchema.optional(),
    stderr: boundedOutputSchema.optional(),
    structuredOutput: z.record(z.string(), z.unknown()).default({}),
    artifacts: z
      .array(
        z
          .object({
            name: z.string().min(1).max(256),
            kind: z.string().min(1).max(128).optional(),
            mediaType: z.string().min(1).max(128).optional(),
            sizeBytes: z.number().int().nonnegative().max(16 * 1024 * 1024).optional(),
            sha256: hashSchema.optional()
          })
          .strict()
      )
      .max(32)
      .default([]),
    error: boundedErrorSchema.optional(),
    resourceUsage: z
      .object({
        durationMs: z.number().int().nonnegative().max(86_400_000).optional(),
        cpuMs: z.number().int().nonnegative().max(86_400_000).optional(),
        memoryBytes: z.number().int().nonnegative().max(4 * 1024 * 1024 * 1024).optional()
      })
      .strict()
      .optional(),
    simulationMetadata: z
      .object({
        executionMode: z.literal("dry_run"),
        simulated: z.literal(true),
        workerVersion: identifierSchema.optional(),
        reason: z.string().max(512).optional()
      })
      .strict()
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.finishedAt) < Date.parse(value.startedAt)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["finishedAt"], message: "finishedAt precedes startedAt" });
    }
  });

export const jsonRpcRequestSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: z.union([z.string(), z.number(), z.null()]).default(null),
    method: z.string().min(1),
    params: z.unknown().optional()
  })
  .strict();

export function stableHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)])
    );
  }
  return value;
}
