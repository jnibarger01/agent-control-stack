import { createHash } from "node:crypto";
import { z } from "zod";
import { WORKER_PROTOCOL_VERSION } from "./execution-plan.js";

const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const timestampSchema = z.string().datetime({ offset: true }).max(64);

export const executionAttemptStatusSchema = z.enum([
  "pending",
  "leased",
  "running",
  "cancellation_requested",
  "interrupted",
  "succeeded",
  "failed",
  "cancelled",
  "unknown",
  "quarantined"
]);

export const executionAttemptSchema = z
  .object({
    attemptId: identifierSchema,
    workItemId: identifierSchema,
    planId: identifierSchema,
    planHash: hashSchema,
    attemptNumber: z.number().int().positive(),
    protocolVersion: z.literal(WORKER_PROTOCOL_VERSION),
    inputHash: hashSchema,
    status: executionAttemptStatusSchema,
    currentFencingEpoch: z.number().int().nonnegative(),
    claimedByWorkerId: identifierSchema.optional(),
    startedAt: timestampSchema.optional(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema
  })
  .strict();

export const createAttemptInputSchema = z
  .object({
    workItemId: identifierSchema,
    planHash: hashSchema,
    inputHash: hashSchema,
    now: z.date().optional()
  })
  .strict();

export const attemptLeaseStatusSchema = z.enum(["active", "consumed", "expired", "revoked"]);

export const transitionAttemptInputSchema = z
  .object({
    attemptId: identifierSchema,
    workItemId: identifierSchema,
    workerId: identifierSchema,
    fencingEpoch: z.number().int().positive(),
    status: z.enum(["running", "cancellation_requested", "interrupted", "succeeded", "failed", "cancelled", "unknown", "quarantined"]),
    outcomeCode: z.string().min(1).max(256).optional(),
    now: z.date().optional()
  })
  .strict();

export const attemptLeaseSchema = z
  .object({
    leaseId: identifierSchema,
    attemptId: identifierSchema,
    workItemId: identifierSchema,
    admissionId: identifierSchema,
    approvalId: identifierSchema.optional(),
    /** Every additional required-plan-action approval consumed by this lease, beyond `approvalId`. */
    additionalApprovalIds: z.array(identifierSchema).optional(),
    workerId: identifierSchema,
    tokenHash: hashSchema,
    planHash: hashSchema,
    inputHash: hashSchema,
    fencingEpoch: z.number().int().positive(),
    protocolVersion: z.literal(WORKER_PROTOCOL_VERSION),
    policyVersion: z.string().min(1).max(128),
    policyDecisionHash: hashSchema,
    issuedAt: timestampSchema,
    expiresAt: timestampSchema,
    maxExpiresAt: timestampSchema,
    lastRenewedAt: timestampSchema,
    status: attemptLeaseStatusSchema,
    closedAt: timestampSchema.optional()
  })
  .strict();

export const leaseApprovalBindingSchema = z
  .object({
    approvalId: identifierSchema,
    actionHash: hashSchema
  })
  .strict();

export const issueLeaseInputSchema = z
  .object({
    attemptId: identifierSchema,
    workItemId: identifierSchema,
    admissionId: identifierSchema,
    approvalId: identifierSchema.optional(),
    /**
     * Every additional required-plan-action approval beyond `approvalId`
     * (which alone can only ever cover a single action), so a multi-action
     * approval-required plan binds and atomically consumes its complete
     * approval set through the lease's authority rather than just the
     * first one.
     */
    additionalApprovals: z.array(leaseApprovalBindingSchema).max(64).optional(),
    workerId: identifierSchema,
    leaseToken: z.string().min(16).max(512),
    policyVersion: z.string().min(1).max(128),
    policyDecisionHash: hashSchema,
    ttlMs: z
      .number()
      .int()
      .positive()
      .max(60 * 60 * 1_000),
    maxTtlMs: z
      .number()
      .int()
      .positive()
      .max(24 * 60 * 60 * 1_000)
      .optional(),
    now: z.date().optional()
  })
  .strict();

export const workspaceAllocationStatusSchema = z.enum(["active", "cleanup_requested", "cleanup_failed", "torn_down"]);

export const workspaceAllocationSchema = z
  .object({
    allocationId: identifierSchema,
    workItemId: identifierSchema,
    attemptId: identifierSchema.optional(),
    leaseId: identifierSchema.optional(),
    workerId: identifierSchema.optional(),
    fencingEpoch: z.number().int().nonnegative().optional(),
    hostPath: z.string().min(1).max(4_096),
    branch: z.string().min(1).max(256),
    baseRef: z.string().min(1).max(256),
    status: workspaceAllocationStatusSchema,
    createdAt: timestampSchema,
    tornDownAt: timestampSchema.optional(),
    cleanupAttempts: z.number().int().nonnegative().optional(),
    cleanupRequestedAt: timestampSchema.optional(),
    cleanupLastError: z.string().optional()
  })
  .strict();

export const recordWorkspaceAllocationInputSchema = z
  .object({
    allocationId: identifierSchema,
    workItemId: identifierSchema,
    attemptId: identifierSchema.optional(),
    leaseId: identifierSchema.optional(),
    workerId: identifierSchema.optional(),
    fencingEpoch: z.number().int().nonnegative().optional(),
    hostPath: z.string().min(1).max(4_096),
    branch: z.string().min(1).max(256),
    baseRef: z.string().min(1).max(256),
    now: z.date().optional()
  })
  .strict();

/**
 * The single joined lookup CommandBroker/EngineIsolationBackend authority
 * verifiers need: given the identifiers a caller claims (workItemId,
 * attemptId, leaseId, workerId, fencingToken, workspace.allocationId), is
 * there a genuinely persisted, currently-active lease bound to a
 * currently-active attempt bound to a currently-active workspace
 * allocation with all of those exact values - not merely internally
 * consistent with each other, but rooted in what the store actually
 * recorded when the attempt was created, the lease was issued, and the
 * workspace was provisioned.
 */
export const commandAuthoritySchema = z
  .object({
    attempt: executionAttemptSchema,
    lease: attemptLeaseSchema,
    workspaceAllocation: workspaceAllocationSchema
  })
  .strict();

export type ExecutionAttemptStatus = z.infer<typeof executionAttemptStatusSchema>;
export type ExecutionAttempt = z.infer<typeof executionAttemptSchema>;
export type CreateAttemptInput = z.infer<typeof createAttemptInputSchema>;
export type AttemptLeaseStatus = z.infer<typeof attemptLeaseStatusSchema>;
export type AttemptLease = z.infer<typeof attemptLeaseSchema>;
export type LeaseApprovalBinding = z.infer<typeof leaseApprovalBindingSchema>;
export type IssueLeaseInput = z.infer<typeof issueLeaseInputSchema>;
export type TransitionAttemptInput = z.infer<typeof transitionAttemptInputSchema>;
export type WorkspaceAllocationStatus = z.infer<typeof workspaceAllocationStatusSchema>;
export type WorkspaceAllocation = z.infer<typeof workspaceAllocationSchema>;
export type RecordWorkspaceAllocationInput = z.infer<typeof recordWorkspaceAllocationInputSchema>;
export type CommandAuthority = z.infer<typeof commandAuthoritySchema>;

export function hashAttemptLeaseToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
