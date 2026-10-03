import { z } from "zod";

const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

export const actorRoutingDecisionSchema = z
  .object({
    decisionId: identifierSchema,
    workItemId: identifierSchema,
    attemptId: identifierSchema.optional(),
    selectedActorId: identifierSchema.optional(),
    eligible: z.array(identifierSchema),
    excluded: z.record(z.string(), z.array(z.string())),
    scores: z.record(z.string(), z.number().int()),
    idempotencyKey: identifierSchema,
    createdAt: z.string().datetime({ offset: true })
  })
  .strict();

export const recordActorRoutingDecisionInputSchema = actorRoutingDecisionSchema
  .omit({ decisionId: true, createdAt: true })
  .extend({
    now: z.date().optional()
  })
  .strict();

export const actorReliabilitySchema = z
  .object({
    actorId: identifierSchema,
    successCount: z.number().int().nonnegative(),
    failureCount: z.number().int().nonnegative(),
    updatedAt: z.string().datetime({ offset: true })
  })
  .strict();

export const recordActorReliabilityInputSchema = z
  .object({
    actorId: identifierSchema,
    outcome: z.enum(["success", "failure"]),
    now: z.date().optional()
  })
  .strict();

export const authoritativeRoutingDecisionKindSchema = z.enum(["route", "fallback", "reject"]);
export const authoritativeRoutingSourceSchema = z.enum(["nimble", "deterministic_fallback"]);

export const authoritativeRoutingEvidenceSchema = z
  .object({
    decisionId: identifierSchema,
    workItemId: identifierSchema,
    missionId: identifierSchema.optional(),
    operationId: identifierSchema.optional(),
    attemptId: identifierSchema.optional(),
    selectedActorId: identifierSchema.optional(),
    decision: authoritativeRoutingDecisionKindSchema,
    source: authoritativeRoutingSourceSchema,
    reasonCode: z.string().min(1).max(128),
    fallbackReason: z.string().min(1).max(128).optional(),
    confidence: z.number().min(0).max(1).optional(),
    model: z.string().min(1).max(128).optional(),
    lane: z.enum(["jc", "dc"]).optional(),
    routerVersion: z.string().min(1).max(128),
    promptVersion: z.string().min(1).max(128),
    eligible: z.array(identifierSchema),
    excluded: z.record(z.string(), z.array(z.string())),
    scores: z.record(z.string(), z.number().int()),
    candidates: z.array(identifierSchema),
    constraints: z.record(z.string(), z.unknown()),
    normalizedDecision: z.record(z.string(), z.unknown()),
    supersedesDecisionId: identifierSchema.optional(),
    idempotencyKey: identifierSchema,
    createdAt: z.string().datetime({ offset: true })
  })
  .strict();

export const recordAuthoritativeRoutingEvidenceInputSchema = authoritativeRoutingEvidenceSchema
  .omit({ decisionId: true, createdAt: true, idempotencyKey: true })
  .extend({ now: z.date().optional() })
  .strict();

export const routingExecutionOutcomeSchema = z
  .object({
    outcomeId: identifierSchema,
    decisionId: identifierSchema,
    executorId: identifierSchema,
    model: z.string().min(1).max(128).optional(),
    latencyMs: z.number().int().nonnegative(),
    success: z.boolean(),
    timedOut: z.boolean(),
    verificationResult: z.string().min(1).max(128).optional(),
    testsResult: z.string().min(1).max(128).optional(),
    retryCount: z.number().int().nonnegative(),
    idempotencyKey: identifierSchema,
    createdAt: z.string().datetime({ offset: true })
  })
  .strict();

export const recordRoutingExecutionOutcomeInputSchema = routingExecutionOutcomeSchema
  .omit({ outcomeId: true, createdAt: true })
  .extend({ now: z.date().optional() })
  .strict();

export const workItemRoutingSnapshotSchema = z
  .object({
    workItemId: identifierSchema,
    status: z.string().min(1),
    hasExecutionResult: z.boolean(),
    activeAttempt: z.boolean()
  })
  .strict();

export type ActorRoutingDecision = z.infer<typeof actorRoutingDecisionSchema>;
export type RecordActorRoutingDecisionInput = z.infer<typeof recordActorRoutingDecisionInputSchema>;
export type ActorReliability = z.infer<typeof actorReliabilitySchema>;
export type RecordActorReliabilityInput = z.infer<typeof recordActorReliabilityInputSchema>;
export type AuthoritativeRoutingEvidence = z.infer<typeof authoritativeRoutingEvidenceSchema>;
export type RecordAuthoritativeRoutingEvidenceInput = z.infer<typeof recordAuthoritativeRoutingEvidenceInputSchema>;
export type RoutingExecutionOutcome = z.infer<typeof routingExecutionOutcomeSchema>;
export type RecordRoutingExecutionOutcomeInput = z.infer<typeof recordRoutingExecutionOutcomeInputSchema>;
export type WorkItemRoutingSnapshot = z.infer<typeof workItemRoutingSnapshotSchema>;
