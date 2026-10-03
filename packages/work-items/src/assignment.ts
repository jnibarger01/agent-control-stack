import { z } from "zod";

const identifierSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

export const workItemAssignmentSchema = z.object({
  workItemId: identifierSchema,
  selectedWorkerId: identifierSchema,
  selectedAgentId: identifierSchema.optional(),
  routingDecisionId: identifierSchema.optional(),
  assignedByActorId: identifierSchema,
  assignedAt: z.string().datetime({ offset: true })
}).strict();

export const assignWorkItemInputSchema = workItemAssignmentSchema.omit({ assignedAt: true }).extend({
  now: z.date().optional()
}).strict();

export type WorkItemAssignment = z.infer<typeof workItemAssignmentSchema>;
export type AssignWorkItemInput = z.infer<typeof assignWorkItemInputSchema>;
