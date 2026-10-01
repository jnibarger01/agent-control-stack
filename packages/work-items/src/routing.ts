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

export type ActorRoutingDecision = z.infer<typeof actorRoutingDecisionSchema>;
export type RecordActorRoutingDecisionInput = z.infer<typeof recordActorRoutingDecisionInputSchema>;

const actorRoutingShadowObservationBaseSchema = z
  .object({
    workItemId: identifierSchema,
    routingDecisionId: identifierSchema,
    deterministicSelectedActorId: identifierSchema.optional(),
    eligible: z.array(identifierSchema).min(1).max(32),
    semanticSelectedActorId: identifierSchema.optional(),
    semanticConfidence: z.number().min(0).max(1).optional(),
    semanticProbabilities: z.record(z.string(), z.number().min(0).max(1)),
    questionSetVersion: z.string().min(1).max(128),
    classifierVersion: z.string().min(1).max(128),
    model: z.string().min(1).max(128).optional(),
    degraded: z.boolean(),
    failureReason: z.string().min(1).max(128).optional(),
    latencyMs: z.number().int().nonnegative().max(60_000),
    createdAt: z.string().datetime({ offset: true })
  })
  .strict();

type ActorRoutingShadowComparable = Pick<
  z.infer<typeof actorRoutingShadowObservationBaseSchema>,
  "eligible" | "deterministicSelectedActorId" | "semanticSelectedActorId" | "semanticProbabilities"
>;

function validateActorRoutingShadowObservation(value: ActorRoutingShadowComparable, ctx: z.RefinementCtx): void {
  const eligible = new Set(value.eligible);
  if (value.deterministicSelectedActorId && !eligible.has(value.deterministicSelectedActorId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "deterministic actor must be eligible" });
  }
  if (value.semanticSelectedActorId && !eligible.has(value.semanticSelectedActorId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "semantic actor must be eligible" });
  }
  for (const actorId of Object.keys(value.semanticProbabilities)) {
    if (!eligible.has(actorId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "semantic probability actor is not eligible: " + actorId });
    }
  }
}

export const actorRoutingShadowObservationSchema = actorRoutingShadowObservationBaseSchema.superRefine(
  validateActorRoutingShadowObservation
);

export const recordActorRoutingShadowObservationInputSchema = actorRoutingShadowObservationBaseSchema
  .omit({ createdAt: true })
  .extend({ now: z.date().optional() })
  .strict()
  .superRefine(validateActorRoutingShadowObservation);

export type ActorRoutingShadowObservation = z.infer<typeof actorRoutingShadowObservationSchema>;
export type RecordActorRoutingShadowObservationInput = z.infer<typeof recordActorRoutingShadowObservationInputSchema>;
export type ActorReliability = z.infer<typeof actorReliabilitySchema>;
export type RecordActorReliabilityInput = z.infer<typeof recordActorReliabilityInputSchema>;
