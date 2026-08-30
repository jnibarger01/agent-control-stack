import { z } from "zod";

/**
 * ADR 0015 governance projections — input schemas for the append-only
 * advisory / evidence / verification tables (migration 018).
 *
 * These are PROJECTIONS. `packages/work-items` stays the sole authority for the
 * work-item lifecycle, leases, and terminal result acceptance. The canonical
 * schemas + hashing live in `packages/advisory` / `packages/evidence`; the
 * store re-checks the hash *format* and JSON validity and enforces referential
 * integrity (a review finding must reference an existing evidence manifest;
 * a reviewer grant transitions at most once), but does not re-run the content
 * hash (that is the caller's job and is covered by their tests).
 */

const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const hash64 = z.string().regex(/^[a-f0-9]{64}$/u);
const rev = z.string().min(1).max(256);
const jsonObject = z.record(z.string(), z.unknown());
const timestamp = z.string().datetime({ offset: true });

export const attemptPhaseSchema = z.enum([
  "planning",
  "admitted",
  "executing",
  "collecting_evidence",
  "reviewing",
  "accepted",
  "rejected"
]);
export type AttemptPhase = z.infer<typeof attemptPhaseSchema>;

export const verificationDecisionOutcomeSchema = z.enum([
  "attempt_accepted",
  "attempt_rejected",
  "replan_required",
  "verification_disputed",
  "human_escalation_required"
]);
export type VerificationDecisionOutcome = z.infer<typeof verificationDecisionOutcomeSchema>;

export const recordPlanProposalInputSchema = z
  .object({
    proposalHash: hash64,
    proposalId: id,
    workItemId: id,
    principalId: id,
    proposal: jsonObject,
    now: z.date().optional()
  })
  .strict();
export type RecordPlanProposalInput = z.infer<typeof recordPlanProposalInputSchema>;

export const recordEvidenceManifestInputSchema = z
  .object({
    manifestHash: hash64,
    attemptId: id,
    workItemId: id,
    admittedPlanHash: hash64,
    planHash: hash64,
    actionHash: hash64,
    baseWorkspaceRevision: rev,
    resultWorkspaceRevision: rev,
    manifest: jsonObject,
    now: z.date().optional()
  })
  .strict();
export type RecordEvidenceManifestInput = z.infer<typeof recordEvidenceManifestInputSchema>;

export const recordReviewFindingInputSchema = z
  .object({
    findingHash: hash64,
    findingId: id,
    workItemId: id,
    attemptId: id,
    reviewerPrincipalId: id,
    reviewerProvider: z.string().min(1).max(128),
    evidenceManifestHash: hash64,
    verdict: z.enum(["PASS", "NEEDS_CHANGES", "BLOCK", "UNKNOWN"]),
    finding: jsonObject,
    now: z.date().optional()
  })
  .strict();
export type RecordReviewFindingInput = z.infer<typeof recordReviewFindingInputSchema>;

export const issueReviewerGrantInputSchema = z
  .object({
    grantHash: hash64,
    grantId: id,
    principalId: id,
    workItemId: id,
    planId: id,
    admittedPlanHash: hash64,
    attemptId: id,
    workspaceId: id,
    workspaceRevision: rev,
    issuedAt: timestamp,
    expiresAt: timestamp,
    grant: jsonObject
  })
  .strict();
export type IssueReviewerGrantInput = z.infer<typeof issueReviewerGrantInputSchema>;

export const recordAttemptPhaseInputSchema = z
  .object({
    attemptId: id,
    workItemId: id,
    phase: attemptPhaseSchema,
    note: z.string().max(2_000).optional(),
    now: z.date().optional()
  })
  .strict();
export type RecordAttemptPhaseInput = z.infer<typeof recordAttemptPhaseInputSchema>;

export const recordVerificationRequirementInputSchema = z
  .object({
    attemptId: id,
    workItemId: id,
    policyVersion: z.string().min(1).max(128),
    reviewersRequired: z.number().int().min(0).max(8),
    requirement: jsonObject,
    now: z.date().optional()
  })
  .strict();
export type RecordVerificationRequirementInput = z.infer<typeof recordVerificationRequirementInputSchema>;

export const recordVerificationDecisionInputSchema = z
  .object({
    attemptId: id,
    workItemId: id,
    outcome: verificationDecisionOutcomeSchema,
    evidenceManifestHash: hash64,
    reviewFindingHashes: z.array(hash64).max(64).default([]),
    verificationPolicyVersion: z.string().min(1).max(128),
    now: z.date().optional()
  })
  .strict();
export type RecordVerificationDecisionInput = z.infer<typeof recordVerificationDecisionInputSchema>;

export interface PlanProposalProjection {
  proposalHash: string;
  workItemId: string;
  principalId: string;
  proposal: Record<string, unknown>;
  createdAt: string;
  admittedAt: string | null;
}
export interface EvidenceManifestProjection {
  manifestHash: string;
  attemptId: string;
  workItemId: string;
  manifest: Record<string, unknown>;
  createdAt: string;
}
export interface ReviewFindingProjection {
  findingHash: string;
  attemptId: string;
  workItemId: string;
  reviewerPrincipalId: string;
  reviewerProvider: string;
  evidenceManifestHash: string;
  verdict: "PASS" | "NEEDS_CHANGES" | "BLOCK" | "UNKNOWN";
  finding: Record<string, unknown>;
  createdAt: string;
}
export interface ReviewerGrantProjection {
  grantHash: string;
  attemptId: string;
  workItemId: string;
  principalId: string;
  status: "issued" | "consumed" | "expired" | "revoked";
  workspaceRevision: string;
  admittedPlanHash: string;
  grant: Record<string, unknown>;
  issuedAt: string;
  expiresAt: string;
  consumedAt: string | null;
}
export interface VerificationRequirementProjection {
  attemptId: string;
  workItemId: string;
  policyVersion: string;
  reviewersRequired: number;
  requirement: Record<string, unknown>;
  recordedAt: string;
}
export interface VerificationDecisionProjection {
  attemptId: string;
  workItemId: string;
  outcome: VerificationDecisionOutcome;
  evidenceManifestHash: string;
  reviewFindingHashes: string[];
  verificationPolicyVersion: string;
  decidedAt: string;
}
