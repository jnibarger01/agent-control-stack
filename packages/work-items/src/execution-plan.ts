import { ControlStackError, domainHash } from "@agent-control-stack/shared";
import { z } from "zod";
import { actionRequestSchema, targetSchema, type WorkItem } from "./work-item.js";

export const EXECUTION_PLAN_SCHEMA_VERSION = "acs.execution-plan.v1" as const;
export const EXECUTION_PLAN_ADMISSION_SCHEMA_VERSION = "acs.execution-plan-admission.v1" as const;
export const EXECUTION_PLAN_APPROVAL_SCHEMA_VERSION = "acs.execution-plan-approval.v1" as const;
export const EXECUTION_ATTEMPT_CLAIM_SCHEMA_VERSION = "acs.execution-attempt-claim.v1" as const;
export const WORKER_PROTOCOL_VERSION = "acs.worker.v2" as const;

const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const actorIdSchema = z.string().min(1).max(256);
export const executionHashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const timestampSchema = z.string().datetime({ offset: true }).max(64);
const jsonRecordSchema = z.record(z.string(), z.json());
const positiveLeaseMsSchema = z
  .number()
  .int()
  .min(1)
  .max(24 * 60 * 60 * 1_000);

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
    subjectInputHash: executionHashSchema,
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
    planHash: executionHashSchema,
    subjectInputHash: executionHashSchema,
    createdByActorId: actorIdSchema,
    createdAt: timestampSchema
  })
  .strict();

export const executionPlanAdmissionDecisionSchema = z.enum(["allow", "require_approval"]);

export const executionPlanAdmissionSchema = z
  .object({
    admissionId: identifierSchema,
    workItemId: identifierSchema,
    planId: identifierSchema,
    planHash: executionHashSchema,
    admissionHash: executionHashSchema,
    policyVersion: z.string().min(1).max(128),
    policyDecisionHash: executionHashSchema,
    decision: executionPlanAdmissionDecisionSchema,
    requiredApprovalActionHashes: z.array(executionHashSchema).max(128),
    admittedByActorId: actorIdSchema,
    admittedAt: timestampSchema
  })
  .strict();

export const executionPlanApprovalSchema = z
  .object({
    approvalId: identifierSchema,
    workItemId: identifierSchema,
    planId: identifierSchema,
    planHash: executionHashSchema,
    admissionId: identifierSchema,
    admissionHash: executionHashSchema,
    policyVersion: z.string().min(1).max(128),
    actionHash: executionHashSchema,
    approvalBindingHash: executionHashSchema,
    approvedByActorId: actorIdSchema,
    reason: z.string().min(1).max(2_000),
    status: z.enum(["granted", "consumed", "expired", "revoked"]),
    createdAt: timestampSchema,
    expiresAt: timestampSchema,
    consumedAt: timestampSchema.optional()
  })
  .strict();

export const executionAttemptClaimSchema = z
  .object({
    schemaVersion: z.literal(EXECUTION_ATTEMPT_CLAIM_SCHEMA_VERSION),
    protocolVersion: z.literal(WORKER_PROTOCOL_VERSION),
    attemptId: identifierSchema,
    attemptNumber: z.number().int().positive(),
    workItemId: identifierSchema,
    planId: identifierSchema,
    planHash: executionHashSchema,
    admissionId: identifierSchema,
    admissionHash: executionHashSchema,
    inputHash: executionHashSchema,
    workerId: identifierSchema,
    leaseId: identifierSchema,
    leaseToken: z.string().min(32).max(256),
    fencingEpoch: z.number().int().positive(),
    issuedAt: timestampSchema,
    expiresAt: timestampSchema
  })
  .strict();

export const executionAttemptStatusSchema = z.enum(["leased", "unknown", "quarantined"]);

export const executionAttemptRecordSchema = z
  .object({
    attemptId: identifierSchema,
    workItemId: identifierSchema,
    attemptNumber: z.number().int().positive(),
    protocolVersion: z.literal(WORKER_PROTOCOL_VERSION),
    planId: identifierSchema,
    planHash: executionHashSchema,
    admissionId: identifierSchema,
    admissionHash: executionHashSchema,
    inputHash: executionHashSchema,
    workerId: identifierSchema,
    fencingEpoch: z.number().int().positive(),
    status: executionAttemptStatusSchema,
    createdAt: timestampSchema,
    claimedAt: timestampSchema,
    startedAt: timestampSchema.optional()
  })
  .strict();

export const createExecutionPlanInputSchema = z
  .object({
    workItemId: identifierSchema,
    definition: executionPlanDefinitionSchema,
    createdByActorId: actorIdSchema,
    expectedCurrentPlanHash: executionHashSchema.optional(),
    now: z.date().optional()
  })
  .strict();

export const admitExecutionPlanInputSchema = z
  .object({
    workItemId: identifierSchema,
    planHash: executionHashSchema,
    policyVersion: z.string().min(1).max(128),
    policyDecisionHash: executionHashSchema,
    decision: executionPlanAdmissionDecisionSchema,
    requiredApprovalActionHashes: z.array(executionHashSchema).max(128).default([]),
    admittedByActorId: actorIdSchema,
    now: z.date().optional()
  })
  .strict()
  .superRefine((value, context) => {
    const unique = new Set(value.requiredApprovalActionHashes);
    if (unique.size !== value.requiredApprovalActionHashes.length) {
      context.addIssue({
        code: "custom",
        path: ["requiredApprovalActionHashes"],
        message: "required approval action hashes must be unique"
      });
    }
    if (value.decision === "allow" && value.requiredApprovalActionHashes.length !== 0) {
      context.addIssue({
        code: "custom",
        path: ["requiredApprovalActionHashes"],
        message: "allow admissions cannot require approvals"
      });
    }
    if (value.decision === "require_approval" && value.requiredApprovalActionHashes.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["requiredApprovalActionHashes"],
        message: "require_approval admissions must identify at least one action hash"
      });
    }
  });

export const recordExecutionPlanApprovalInputSchema = z
  .object({
    workItemId: identifierSchema,
    planHash: executionHashSchema,
    admissionHash: executionHashSchema,
    policyVersion: z.string().min(1).max(128),
    actionHash: executionHashSchema,
    approvedByActorId: actorIdSchema,
    reason: z.string().min(1).max(2_000),
    expiresAt: timestampSchema,
    now: z.date().optional()
  })
  .strict();

export const claimExecutionAttemptInputSchema = z
  .object({
    protocolVersion: z.string().min(1).max(128),
    workItemId: identifierSchema,
    planId: identifierSchema,
    planHash: executionHashSchema,
    admissionId: identifierSchema,
    admissionHash: executionHashSchema,
    inputHash: executionHashSchema,
    workerId: identifierSchema,
    leaseMs: positiveLeaseMsSchema.optional(),
    now: z.date().optional()
  })
  .strict();

export const verifyExecutionAttemptClaimInputSchema = executionAttemptClaimSchema
  .extend({ now: z.date().optional() })
  .strict();

export const renewExecutionAttemptLeaseInputSchema = executionAttemptClaimSchema
  .extend({ leaseMs: positiveLeaseMsSchema.optional(), now: z.date().optional() })
  .strict();

export const startExecutionAttemptInputSchema = executionAttemptClaimSchema
  .extend({ now: z.date().optional() })
  .strict();

export const reacquireExecutionAttemptLeaseInputSchema = z
  .object({
    protocolVersion: z.string().min(1).max(128),
    attemptId: identifierSchema,
    workerId: identifierSchema,
    leaseMs: positiveLeaseMsSchema.optional(),
    now: z.date().optional()
  })
  .strict();

export const transitionExecutionAttemptInputSchema = z
  .object({
    attemptId: identifierSchema,
    status: z.enum(["unknown", "quarantined"]),
    actorId: actorIdSchema,
    reason: z.string().min(1).max(2_000),
    now: z.date().optional()
  })
  .strict();

export const retryExecutionAttemptInputSchema = z
  .object({
    attemptId: identifierSchema,
    protocolVersion: z.string().min(1).max(128),
    workItemId: identifierSchema,
    planId: identifierSchema,
    planHash: executionHashSchema,
    admissionId: identifierSchema,
    admissionHash: executionHashSchema,
    inputHash: executionHashSchema,
    workerId: identifierSchema,
    leaseMs: positiveLeaseMsSchema.optional(),
    now: z.date().optional()
  })
  .strict();

export type ExecutionPlanStep = z.infer<typeof executionPlanStepSchema>;
export type ExecutionPlanDefinition = z.infer<typeof executionPlanDefinitionSchema>;
export type ExecutionPlanRecord = z.infer<typeof executionPlanRecordSchema>;
export type ExecutionPlanAdmission = z.infer<typeof executionPlanAdmissionSchema>;
export type ExecutionPlanApproval = z.infer<typeof executionPlanApprovalSchema>;
export type ExecutionAttemptClaim = z.infer<typeof executionAttemptClaimSchema>;
export type ExecutionAttemptRecord = z.infer<typeof executionAttemptRecordSchema>;
export type ExecutionAttemptStatus = z.infer<typeof executionAttemptStatusSchema>;
export type CreateExecutionPlanInput = z.infer<typeof createExecutionPlanInputSchema>;
export type AdmitExecutionPlanInput = z.infer<typeof admitExecutionPlanInputSchema>;
export type RecordExecutionPlanApprovalInput = z.infer<typeof recordExecutionPlanApprovalInputSchema>;
export type ClaimExecutionAttemptInput = z.infer<typeof claimExecutionAttemptInputSchema>;
export type VerifyExecutionAttemptClaimInput = z.infer<typeof verifyExecutionAttemptClaimInputSchema>;
export type RenewExecutionAttemptLeaseInput = z.infer<typeof renewExecutionAttemptLeaseInputSchema>;
export type StartExecutionAttemptInput = z.infer<typeof startExecutionAttemptInputSchema>;
export type ReacquireExecutionAttemptLeaseInput = z.infer<typeof reacquireExecutionAttemptLeaseInputSchema>;
export type TransitionExecutionAttemptInput = z.infer<typeof transitionExecutionAttemptInputSchema>;
export type RetryExecutionAttemptInput = z.infer<typeof retryExecutionAttemptInputSchema>;

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

export function executionPlanAdmissionHash(input: {
  workItemId: string;
  planId: string;
  planHash: string;
  policyVersion: string;
  policyDecisionHash: string;
  decision: z.infer<typeof executionPlanAdmissionDecisionSchema>;
  requiredApprovalActionHashes: string[];
}): string {
  return domainHash("acs:execution-plan-admission:v1", {
    schemaVersion: EXECUTION_PLAN_ADMISSION_SCHEMA_VERSION,
    workItemId: input.workItemId,
    planId: input.planId,
    planHash: input.planHash,
    policyVersion: input.policyVersion,
    policyDecisionHash: input.policyDecisionHash,
    decision: input.decision,
    requiredApprovalActionHashes: [...input.requiredApprovalActionHashes].sort()
  });
}

export function executionPlanApprovalBindingHash(input: {
  workItemId: string;
  planId: string;
  planHash: string;
  admissionId: string;
  admissionHash: string;
  policyVersion: string;
  actionHash: string;
}): string {
  return domainHash("acs:execution-plan-approval:v1", {
    schemaVersion: EXECUTION_PLAN_APPROVAL_SCHEMA_VERSION,
    ...input
  });
}

export function executionAttemptInputHash(input: {
  workItemId: string;
  planId: string;
  planHash: string;
  admissionId: string;
  admissionHash: string;
  subjectInputHash: string;
  policyVersion: string;
  policyDecisionHash: string;
  approvalBindingHashes: string[];
}): string {
  return domainHash("acs:execution-attempt-input:v2", {
    ...input,
    approvalBindingHashes: [...input.approvalBindingHashes].sort()
  });
}

export function defaultExecutionPlanForWorkItem(
  workItem: Pick<WorkItem, "id" | "requester" | "requesterSubject" | "intent" | "target" | "requestedActions" | "risk">
): ExecutionPlanDefinition {
  if (workItem.requestedActions.length === 0) {
    throw new ControlStackError("execution_plan_no_actions", "execution plans require at least one requested action");
  }
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
