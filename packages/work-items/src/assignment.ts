import { z } from "zod";

const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const scoreSchema = z.number().finite().min(0).max(1);

export const workItemAssignmentSchema = z
  .object({
    workItemId: identifierSchema,
    selectedWorkerId: identifierSchema,
    selectedAgentId: identifierSchema,
    routingDecisionId: identifierSchema,
    assignedByActorId: identifierSchema,
    assignedAt: z.string().datetime({ offset: true })
  })
  .strict();

export const assignWorkItemInputSchema = workItemAssignmentSchema
  .omit({ assignedAt: true })
  .extend({ now: z.date().optional() })
  .strict();

export const nimbleRoutingDecisionDetailsSchema = z
  .object({
    routingDecisionId: identifierSchema,
    workItemId: identifierSchema,
    routingGeneration: z.number().int().positive(),
    selectedAgentId: identifierSchema,
    selectedWorkerId: identifierSchema,
    candidateScores: z.record(identifierSchema, scoreSchema).refine((scores) => Object.keys(scores).length <= 8),
    eligibleAgentIds: z.array(identifierSchema).max(8),
    excluded: z
      .record(identifierSchema, z.array(z.string().min(1).max(256)))
      .refine((items) => Object.keys(items).length <= 128),
    modelId: z.string().min(1).max(128),
    modelVersion: z.string().min(1).max(128),
    selectedScore: scoreSchema,
    threshold: scoreSchema,
    evaluatedAt: z.string().datetime({ offset: true }),
    algorithmVersion: identifierSchema,
    correlationId: identifierSchema
  })
  .strict()
  .superRefine((details, context) => {
    if (!details.eligibleAgentIds.includes(details.selectedAgentId)) {
      context.addIssue({ code: "custom", path: ["selectedAgentId"], message: "selected agent was not eligible" });
    }
    if (details.selectedScore < details.threshold) {
      context.addIssue({ code: "custom", path: ["selectedScore"], message: "selected score is below threshold" });
    }
    if (details.candidateScores[details.selectedAgentId] !== details.selectedScore) {
      context.addIssue({
        code: "custom",
        path: ["candidateScores"],
        message: "selected score does not match candidates"
      });
    }
    const scoreIds = Object.keys(details.candidateScores).sort();
    const eligibleIds = [...details.eligibleAgentIds].sort();
    if (scoreIds.length !== eligibleIds.length || scoreIds.some((id, index) => id !== eligibleIds[index])) {
      context.addIssue({
        code: "custom",
        path: ["candidateScores"],
        message: "score set does not match eligible candidates"
      });
    }
  });

export type WorkItemAssignment = z.infer<typeof workItemAssignmentSchema>;
export type AssignWorkItemInput = z.infer<typeof assignWorkItemInputSchema>;
export type NimbleRoutingDecisionDetails = z.infer<typeof nimbleRoutingDecisionDetailsSchema>;
