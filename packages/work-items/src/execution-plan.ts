import { domainHash } from "@agent-control-stack/shared";
import { z } from "zod";
import { actionRequestSchema, targetSchema, type WorkItem } from "./work-item.js";

export const EXECUTION_PLAN_SCHEMA_VERSION = "acs.execution-plan.v1" as const;
export const WORKER_PROTOCOL_VERSION = "acs.worker.v2" as const;

const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const timestampSchema = z.string().datetime({ offset: true }).max(64);
const jsonRecordSchema = z.record(z.string(), z.json());

export const executionPlanStepSchema = z
  .object({
    stepId: identifierSchema,
    sequence: z.number().int().positive().max(1_000),
    action: actionRequestSchema.omit({ params: true }).extend({ params: jsonRecordSchema }).strict(),
    successCriteria: z.array(z.string().min(1).max(1_000)).max(32)
  })
  .strict();

export const executionPlanDefinitionSchema = z
  .object({
    schemaVersion: z.literal(EXECUTION_PLAN_SCHEMA_VERSION),
    workItemId: identifierSchema,
    subjectInputHash: hashSchema,
    objective: z.string().min(1).max(8_000),
    target: targetSchema,
    steps: z.array(executionPlanStepSchema).min(1).max(128),
    constraints: z
      .object({
        executionMode: z.literal("dry_run"),
        network: z.literal("none"),
        localGitOnly: z.literal(true),
        allowPush: z.literal(false),
        allowDeployment: z.literal(false),
        allowedCommands: z.array(z.array(z.string().min(1).max(8_192)).min(1).max(256)).max(64),
        maxRuntimeMs: z.number().int().min(1).max(86_400_000)
      })
      .strict()
  })
  .strict()
  .superRefine((value, context) => {
    const stepIds = new Set<string>();
    for (const [index, step] of value.steps.entries()) {
      if (step.sequence !== index + 1) {
        context.addIssue({
          code: "custom",
          path: ["steps", index, "sequence"],
          message: "step sequence must be contiguous and one-based"
        });
      }
      if (stepIds.has(step.stepId)) {
        context.addIssue({
          code: "custom",
          path: ["steps", index, "stepId"],
          message: "step identifiers must be unique"
        });
      }
      stepIds.add(step.stepId);
    }
  });

export const executionPlanRecordSchema = z
  .object({
    planId: identifierSchema,
    workItemId: identifierSchema,
    planNumber: z.number().int().positive(),
    definition: executionPlanDefinitionSchema,
    planHash: hashSchema,
    subjectInputHash: hashSchema,
    createdByActorId: z.string().min(1).max(256),
    createdAt: timestampSchema
  })
  .strict();

export const executionPlanAdmissionSchema = z
  .object({
    admissionId: identifierSchema,
    workItemId: identifierSchema,
    planId: identifierSchema,
    planHash: hashSchema,
    policyVersion: z.string().min(1).max(128),
    policyDecisionHash: hashSchema,
    admittedByActorId: z.string().min(1).max(256),
    admittedAt: timestampSchema
  })
  .strict();

export const createExecutionPlanInputSchema = z
  .object({
    workItemId: identifierSchema,
    definition: executionPlanDefinitionSchema,
    createdByActorId: z.string().min(1).max(256),
    expectedCurrentPlanHash: hashSchema.optional(),
    now: z.date().optional()
  })
  .strict();

export const admitExecutionPlanInputSchema = z
  .object({
    workItemId: identifierSchema,
    planHash: hashSchema,
    policyVersion: z.string().min(1).max(128),
    policyDecisionHash: hashSchema,
    admittedByActorId: z.string().min(1).max(256),
    now: z.date().optional()
  })
  .strict();

export type ExecutionPlanStep = z.infer<typeof executionPlanStepSchema>;
export type ExecutionPlanDefinition = z.infer<typeof executionPlanDefinitionSchema>;
export type ExecutionPlanRecord = z.infer<typeof executionPlanRecordSchema>;
export type ExecutionPlanAdmission = z.infer<typeof executionPlanAdmissionSchema>;
export type CreateExecutionPlanInput = z.infer<typeof createExecutionPlanInputSchema>;
export type AdmitExecutionPlanInput = z.infer<typeof admitExecutionPlanInputSchema>;

export function executionPlanHash(input: unknown): string {
  return domainHash("acs:execution-plan:v1", executionPlanDefinitionSchema.parse(input));
}

export function executionPlanSubjectInputHash(
  workItem: Pick<WorkItem, "id" | "requester" | "requesterSubject" | "intent" | "target" | "requestedActions" | "risk">
): string {
  return domainHash("acs:execution-plan-subject:v1", {
    workItemId: workItem.id,
    requester: workItem.requester,
    requesterSubject: workItem.requesterSubject,
    intent: workItem.intent,
    target: workItem.target,
    requestedActions: workItem.requestedActions,
    risk: workItem.risk
  });
}

export function executionAttemptInputHash(input: {
  workItemId: string;
  planHash: string;
  subjectInputHash: string;
}): string {
  return domainHash("acs:execution-attempt-input:v1", input);
}

export function defaultExecutionPlanForWorkItem(
  workItem: Pick<WorkItem, "id" | "requester" | "requesterSubject" | "intent" | "target" | "requestedActions" | "risk">
): ExecutionPlanDefinition {
  const subjectInputHash = executionPlanSubjectInputHash(workItem);
  return executionPlanDefinitionSchema.parse({
    schemaVersion: EXECUTION_PLAN_SCHEMA_VERSION,
    workItemId: workItem.id,
    subjectInputHash,
    objective: workItem.intent,
    target: workItem.target,
    steps: workItem.requestedActions.map((action, index) => ({
      stepId: `step-${String(index + 1).padStart(3, "0")}`,
      sequence: index + 1,
      action,
      successCriteria: []
    })),
    constraints: {
      executionMode: "dry_run",
      network: "none",
      localGitOnly: true,
      allowPush: false,
      allowDeployment: false,
      allowedCommands: [],
      maxRuntimeMs: 5 * 60 * 1_000
    }
  });
}
