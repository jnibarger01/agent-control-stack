import { z } from "zod";

const identifierSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

export const actorRoutingDecisionSchema = z.object({
  decisionId: identifierSchema,
  workItemId: identifierSchema,
  attemptId: identifierSchema.optional(),
  selectedActorId: identifierSchema.optional(),
  eligible: z.array(identifierSchema),
  excluded: z.record(z.string(), z.array(z.string())),
  scores: z.record(z.string(), z.number().int()),
  idempotencyKey: identifierSchema,
  createdAt: z.string().datetime({ offset: true })
}).strict();

export const recordActorRoutingDecisionInputSchema = actorRoutingDecisionSchema.omit({ decisionId: true, createdAt: true }).extend({
  now: z.date().optional()
}).strict();

export const actorReliabilitySchema = z.object({
  actorId: identifierSchema,
  successCount: z.number().int().nonnegative(),
  failureCount: z.number().int().nonnegative(),
  updatedAt: z.string().datetime({ offset: true })
}).strict();

export const recordActorReliabilityInputSchema = z.object({
  actorId: identifierSchema,
  outcome: z.enum(["success", "failure"]),
  now: z.date().optional()
}).strict();

export type ActorRoutingDecision = z.infer<typeof actorRoutingDecisionSchema>;
export type RecordActorRoutingDecisionInput = z.infer<typeof recordActorRoutingDecisionInputSchema>;
export type ActorReliability = z.infer<typeof actorReliabilitySchema>;
export type RecordActorReliabilityInput = z.infer<typeof recordActorReliabilityInputSchema>;
