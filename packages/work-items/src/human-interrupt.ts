import { domainHash } from "@agent-control-stack/shared";
import { z } from "zod";
import type { AttemptLease, ExecutionAttempt } from "./attempt.js";
import type { ClaimedWorkItem } from "./work-item.js";

const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const timestampSchema = z.string().datetime({ offset: true }).max(64);

const boundedJsonObjectSchema = z.record(z.string().min(1).max(256), z.json()).superRefine((value, context) => {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > 64 * 1024) {
    context.addIssue({ code: "custom", message: "JSON object exceeds 64 KiB" });
  }
});

const boundedJsonValueSchema = z.json().superRefine((value, context) => {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > 64 * 1024) {
    context.addIssue({ code: "custom", message: "JSON value exceeds 64 KiB" });
  }
});

export const humanInterruptDecisionSchema = z.enum(["resume", "cancel"]);

export const requestHumanInterruptInputSchema = z
  .object({
    attemptId: identifierSchema,
    workItemId: identifierSchema,
    workerId: identifierSchema,
    fencingEpoch: z.number().int().positive(),
    leaseToken: z.string().min(16).max(512),
    prompt: z.string().min(1).max(8_000),
    checkpoint: boundedJsonObjectSchema,
    responseSpec: boundedJsonObjectSchema.optional(),
    idempotencyKey: identifierSchema,
    expiresInMs: z
      .number()
      .int()
      .positive()
      .max(7 * 24 * 60 * 60 * 1_000)
      .optional(),
    now: z.date().optional()
  })
  .strict();

export const humanInterruptRequestSchema = z
  .object({
    interruptId: identifierSchema,
    attemptId: identifierSchema,
    workItemId: identifierSchema,
    planHash: hashSchema,
    inputHash: hashSchema,
    admissionId: identifierSchema,
    actionHash: hashSchema,
    checkpoint: boundedJsonObjectSchema,
    checkpointHash: hashSchema,
    prompt: z.string().min(1).max(8_000),
    responseSpec: boundedJsonObjectSchema.optional(),
    requestedByActorId: identifierSchema,
    fencingEpoch: z.number().int().positive(),
    idempotencyKey: identifierSchema,
    createdAt: timestampSchema,
    expiresAt: timestampSchema
  })
  .strict();

export const resolveHumanInterruptInputSchema = z
  .object({
    interruptId: identifierSchema,
    decision: humanInterruptDecisionSchema,
    resolvedByActorId: identifierSchema,
    response: boundedJsonValueSchema.optional(),
    reason: z.string().min(1).max(2_000).optional(),
    approvalExpiresInMs: z
      .number()
      .int()
      .positive()
      .max(24 * 60 * 60 * 1_000)
      .optional(),
    now: z.date().optional()
  })
  .strict();

export const humanInterruptResolutionSchema = z
  .object({
    interruptId: identifierSchema,
    decision: humanInterruptDecisionSchema,
    response: boundedJsonValueSchema.optional(),
    responseHash: hashSchema.optional(),
    resolvedByActorId: identifierSchema,
    reason: z.string().min(1).max(2_000).optional(),
    resumeApprovalId: identifierSchema.optional(),
    resolvedAt: timestampSchema
  })
  .strict();

export const resumeHumanInterruptInputSchema = z
  .object({
    interruptId: identifierSchema,
    workerId: identifierSchema,
    attemptAuthority: z
      .object({
        planHash: hashSchema,
        admissionId: identifierSchema,
        approvalId: identifierSchema.optional(),
        additionalApprovals: z
          .array(z.object({ approvalId: identifierSchema, actionHash: hashSchema }).strict())
          .max(64)
          .optional(),
        policyVersion: z.string().min(1).max(128),
        policyDecisionHash: hashSchema
      })
      .strict(),
    ttlMs: z
      .number()
      .int()
      .positive()
      .max(60 * 60 * 1_000)
      .optional(),
    maxTtlMs: z
      .number()
      .int()
      .positive()
      .max(24 * 60 * 60 * 1_000)
      .optional(),
    now: z.date().optional()
  })
  .strict();

export type RequestHumanInterruptInput = z.infer<typeof requestHumanInterruptInputSchema>;
export type HumanInterruptRequest = z.infer<typeof humanInterruptRequestSchema>;
export type ResolveHumanInterruptInput = z.infer<typeof resolveHumanInterruptInputSchema>;
export type HumanInterruptResolution = z.infer<typeof humanInterruptResolutionSchema>;
export type ResumeHumanInterruptInput = z.infer<typeof resumeHumanInterruptInputSchema>;

export interface HumanInterruptResumeClaim {
  interrupt: HumanInterruptRequest;
  resolution: HumanInterruptResolution;
  attempt: ExecutionAttempt;
  lease: AttemptLease;
  running: ClaimedWorkItem;
}

export function humanInterruptCheckpointHash(checkpoint: Record<string, unknown>): string {
  return domainHash("acs:human-interrupt-checkpoint:v1", checkpoint);
}

export function humanInterruptResponseHash(response: unknown): string {
  return domainHash("acs:human-interrupt-response:v1", response);
}
