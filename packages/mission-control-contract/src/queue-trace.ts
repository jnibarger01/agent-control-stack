/**
 * Queue and execution-trace read models (additive to the v1 overview contract).
 * Same rules: strict objects, bounded strings, `unknown` over invention.
 */
import { z } from "zod";

const iso = z.string().min(1);
const risk = z.string().min(1).max(32);

export const queueItemSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().max(300),
    intent: z.string().max(500),
    status: z.string().min(1),
    stageLabel: z.string().min(1),
    risk,
    requester: z.string().max(100).optional(),
    createdAt: iso,
    updatedAt: iso,
    lineage: z
      .object({
        retrySequence: z.number().int().nonnegative().optional(),
        sourceWorkItemId: z.string().min(1).optional(),
        rootWorkItemId: z.string().min(1).optional(),
        type: z.string().max(40).optional()
      })
      .strict()
      .optional(),
    /** `unknown` when the gateway did not supply plan data; never inferred from status. */
    plan: z
      .object({
        state: z.enum(["none", "drafted", "admitted", "unknown"]),
        planNumber: z.number().int().positive().optional(),
        requiresApproval: z.boolean().optional()
      })
      .strict(),
    attempt: z.object({ status: z.string().min(1), number: z.number().int().positive(), workerId: z.string().max(200).optional() }).strict().optional(),
    lease: z
      .object({ status: z.string().min(1), fencingEpoch: z.number().int().nonnegative(), workerId: z.string().max(200), expiresAt: iso })
      .strict()
      .optional()
  })
  .strict();

export const queueReadModelSchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: iso,
    counts: z.object({ source: z.enum(["store", "window"]), byStatus: z.record(z.string(), z.number().int().nonnegative()) }).strict(),
    finishedWindow: z.object({ shown: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).strict().optional(),
    items: z.array(queueItemSchema).max(1000)
  })
  .strict();

export type QueueItem = z.infer<typeof queueItemSchema>;
export type QueueReadModel = z.infer<typeof queueReadModelSchema>;

export const traceStageKeySchema = z.enum(["request", "policy", "plan", "admission", "approval", "attempt", "lease", "result"]);
export const traceStageStateSchema = z.enum(["done", "current", "pending", "not_applicable", "unavailable"]);

export const traceStageSchema = z
  .object({
    key: traceStageKeySchema,
    label: z.string().min(1),
    state: traceStageStateSchema,
    summary: z.string().max(300),
    /** True when the stage is projected from audit events rather than a persisted record. */
    derived: z.boolean()
  })
  .strict();

export const traceLeaseSchema = z
  .object({
    leaseId: z.string().min(1),
    status: z.string().min(1),
    fencingEpoch: z.number().int().nonnegative(),
    workerId: z.string().min(1).max(200),
    issuedAt: iso,
    expiresAt: iso,
    closedAt: iso.optional()
  })
  .strict();

export const traceAttemptSchema = z
  .object({
    attemptId: z.string().min(1),
    attemptNumber: z.number().int().positive(),
    status: z.string().min(1),
    claimedByWorkerId: z.string().max(200).optional(),
    currentFencingEpoch: z.number().int().nonnegative(),
    createdAt: iso,
    startedAt: iso.optional(),
    updatedAt: iso,
    leases: z.array(traceLeaseSchema)
  })
  .strict();

export const traceReadModelSchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: iso,
    workItem: z
      .object({
        id: z.string().min(1),
        title: z.string().max(300),
        intent: z.string().max(500),
        status: z.string().min(1),
        risk,
        requester: z.string().max(100).optional(),
        createdAt: iso,
        updatedAt: iso,
        requestedActions: z.array(z.object({ kind: z.string().max(100), description: z.string().max(300) }).strict()).max(64),
        lineage: queueItemSchema.shape.lineage
      })
      .strict(),
    stages: z.array(traceStageSchema),
    plan: z
      .object({
        planNumber: z.number().int().positive(),
        planHash: z.string().min(1),
        objective: z.string().max(500),
        steps: z.array(z.object({ sequence: z.number().int().positive(), kind: z.string().max(100), description: z.string().max(300) }).strict()).max(128),
        constraints: z.object({ executionMode: z.string().max(40), maxRuntimeMs: z.number().int().nonnegative(), allowedCommandCount: z.number().int().nonnegative() }).strict(),
        createdAt: iso,
        createdBy: z.string().max(256)
      })
      .strict()
      .nullable(),
    admission: z
      .object({
        admissionId: z.string().min(1),
        policyVersion: z.string().max(128),
        policyDecisionHash: z.string().min(1),
        requiresApproval: z.boolean(),
        admittedBy: z.string().max(256),
        admittedAt: iso
      })
      .strict()
      .nullable(),
    approval: z
      .object({
        state: z.enum(["not_required", "required", "granted", "rejected", "unknown"]),
        events: z.array(z.object({ name: z.string().min(1), at: iso }).strict()).max(20)
      })
      .strict(),
    attempts: z.array(traceAttemptSchema).max(100),
    result: z.object({ outcome: z.string().max(60).optional(), summary: z.string().max(500).optional() }).strict().nullable(),
    events: z.array(z.object({ sequence: z.number().int().nonnegative(), name: z.string().min(1), at: iso, summary: z.string().max(400) }).strict()).max(100)
  })
  .strict();

export type TraceStage = z.infer<typeof traceStageSchema>;
export type TraceReadModel = z.infer<typeof traceReadModelSchema>;
export type TraceAttempt = z.infer<typeof traceAttemptSchema>;

export type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };
function parseWith<T>(schema: z.ZodType<T>, input: unknown): Parsed<T> {
  const r = schema.safeParse(input);
  if (r.success) return { ok: true, value: r.data };
  return { ok: false, reason: `schema_invalid:${r.error.issues[0]?.path.join(".") ?? ""}` };
}
export const parseQueueReadModel = (input: unknown) => parseWith(queueReadModelSchema, input);
export const parseTraceReadModel = (input: unknown) => parseWith(traceReadModelSchema, input);
