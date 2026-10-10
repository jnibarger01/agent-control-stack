import { ControlStackError, domainHash } from "@agent-control-stack/shared";
import { z } from "zod";
import { evidenceManifestSchema, verifyEvidenceManifestHash } from "./evidence-manifest.js";

/**
 * Content-addressed attempt receipt. A receipt is EVIDENCE, not authority.
 *
 * It records what canonical ACS state decided (policy decision, approval grant, verification
 * requirement outcome) and what ran (manifest, reviews, readback). Every claim is valid only when
 * `verifyExecutionReceipt` matches it against a `ReceiptBinding` the caller obtained from canonical
 * state (verified audit chain plus attempt and lease records). Hash agreement alone proves nothing,
 * and a receipt never grants, extends or replaces an approval. This module cannot authorize work or
 * transition a mission to COMPLETED.
 */
export const EXECUTION_RECEIPT_SCHEMA_VERSION = "acs.execution-receipt.v1" as const;
export const EXECUTION_RECEIPT_HASH_DOMAIN = "acs:execution-receipt:v1" as const;
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
/** Engine and provider identifiers. The canonical verification contract accepts any non-empty id. */
const engineId = z.string().min(1).max(256);
/** Principal and actor identities. The ACS registry accepts any non-empty id, including external ids with @ or /. */
const actorId = z.string().trim().min(1).max(4096);
const isoTimestamp = z.string().refine((value) => !Number.isNaN(Date.parse(value)), "invalid timestamp");
const auditRef = z.object({ eventId: id, eventHash: hash }).strict();
/**
 * The canonical approval grant that authorized the attempt. `consumedAt` is the canonical time the
 * grant was consumed by the attempt's lease. Expiry is enforced at consumption, not at execution start,
 * because provisioning can run past the deadline after a grant has legitimately been consumed.
 */
const approvalRef = z
  .object({
    approvalId: id,
    /** The action this approval was granted for. A multi-action plan carries one approval per action. */
    actionHash: hash,
    /** Canonical approval request fingerprint, bound to the action. */
    requestHash: hash,
    /** approvalGrantHash over the canonical grant record. */
    grantHash: hash,
    approverActorId: actorId,
    grantedAt: isoTimestamp,
    expiresAt: isoTimestamp,
    consumedAt: isoTimestamp,
    audit: auditRef
  })
  .strict();
/** One reviewer whose canonical verification passed. Independence is by principal, as canonical review does. */
const reviewerRef = z
  .object({
    reviewerPrincipalId: actorId,
    verifierEngineId: engineId,
    verifierProviderId: engineId,
    verdict: z.literal("pass"),
    audit: auditRef
  })
  .strict();
const policyDecisionSchema = z.enum(["allow", "require_approval"]);
/** A canonical attempt can legitimately have zero reviewers when its requirement needs none. */
const MAX_REVIEWERS = 8;
/** Every approval the lease consumed: approvalId plus additionalApprovalIds in the canonical attempt lease. */
const MAX_APPROVALS = 16;
/** Terminal attempt outcomes the canonical store records (work-items attempt status). */
const attemptOutcomeSchema = z.enum(["succeeded", "failed", "cancelled", "interrupted", "unknown", "quarantined"]);

/** Thrown when a receipt fails its internal completeness checks. The defect list is kept as data, not parsed from text. */
export class ExecutionReceiptIncompleteError extends ControlStackError {
  constructor(readonly defects: readonly string[]) {
    super("execution_receipt_incomplete", `execution receipt is incomplete: ${defects.join(",")}`);
    this.name = "ExecutionReceiptIncompleteError";
  }
}

function requireApprovalMatchesDecision(
  value: { policyDecision: "allow" | "require_approval"; approvals: readonly unknown[] },
  context: z.RefinementCtx
): void {
  if (value.policyDecision === "require_approval" && value.approvals.length === 0) {
    context.addIssue({ code: "custom", path: ["approvals"], message: "require_approval needs a canonical grant" });
  }
  if (value.policyDecision === "allow" && value.approvals.length > 0) {
    context.addIssue({ code: "custom", path: ["approvals"], message: "allow carries no approval grant" });
  }
}

export const executionReceiptCoreSchema = z
  .object({
    schemaVersion: z.literal(EXECUTION_RECEIPT_SCHEMA_VERSION),
    manifest: evidenceManifestSchema,
    authorization: z
      .object({
        actorId,
        workerId: id,
        attemptId: id,
        actionHash: hash,
        admittedPlanHash: hash,
        capabilityId: id,
        leaseId: id,
        claimTokenHash: hash,
        policyDecision: policyDecisionSchema,
        approvals: z.array(approvalRef).max(MAX_APPROVALS),
        audit: auditRef
      })
      .strict()
      .superRefine(requireApprovalMatchesDecision),
    verification: z
      .object({
        implementerPrincipalId: actorId,
        implementerEngineId: engineId,
        implementerProviderId: engineId,
        reviewers: z.array(reviewerRef).max(MAX_REVIEWERS),
        verdict: z.literal("pass"),
        manifestHash: hash,
        criteriaPassed: z.number().int().positive().max(512),
        criteriaFailed: z.literal(0),
        audit: auditRef
      })
      .strict(),
    readback: z
      .object({
        resultWorkspaceRevision: z.string().min(1).max(256),
        diffHash: hash,
        /** Receipts only attest a succeeded readback. The canonical outcome decides whether that holds. */
        status: z.literal("succeeded"),
        resultId: id,
        audit: auditRef
      })
      .strict()
  })
  .strict();
export const executionReceiptSchema = executionReceiptCoreSchema.extend({ receiptHash: hash }).strict();
export type ExecutionReceipt = z.infer<typeof executionReceiptSchema>;
export type ExecutionReceiptCore = z.infer<typeof executionReceiptCoreSchema>;
export function executionReceiptHash(core: ExecutionReceiptCore): string {
  return domainHash(EXECUTION_RECEIPT_HASH_DOMAIN, core);
}

/** Internal consistency and completeness checks. These need no canonical state. */
export function receiptDefects(core: ExecutionReceiptCore): string[] {
  const { manifest: m, authorization: a, verification: v, readback: r } = core;
  const defects: string[] = [];
  if (!verifyEvidenceManifestHash(m)) defects.push("manifest_hash_invalid");
  if (m.workerId !== a.workerId) defects.push("worker_mismatch");
  if (m.attemptId !== a.attemptId) defects.push("attempt_mismatch");
  if (m.actionHash !== a.actionHash) defects.push("action_mismatch");
  if (m.admittedPlanHash !== a.admittedPlanHash) defects.push("admitted_plan_mismatch");
  if (v.manifestHash !== m.manifestHash) defects.push("verification_manifest_mismatch");
  if (!m.testEvidence || !m.testEvidence.passed || m.testEvidence.checksPassed < 1 || m.testEvidence.checksFailed !== 0)
    defects.push("tests_not_proven");
  // A test claim without a durable validation run cannot be retrieved or audited, so it proves nothing.
  if (m.testEvidence && !m.testEvidence.validationRunId) defects.push("validation_run_missing");
  if (m.commands.length === 0 || m.commands.some((c) => c.exitCode !== 0)) defects.push("command_execution_not_proven");
  if (r.resultWorkspaceRevision !== m.resultWorkspaceRevision || r.diffHash !== m.diffHash)
    defects.push("readback_mismatch");
  if (Date.parse(m.startedAt) > Date.parse(m.finishedAt)) defects.push("inverted_execution_time");
  // Each canonical grant must have been consumed while it was valid: after it was granted, before it expired.
  if (a.approvals.some((approval) => Date.parse(approval.consumedAt) < Date.parse(approval.grantedAt)))
    defects.push("approval_consumed_before_grant");
  if (a.approvals.some((approval) => Date.parse(approval.consumedAt) >= Date.parse(approval.expiresAt)))
    defects.push("approval_consumed_after_expiry");
  const approvalIds = a.approvals.map((approval) => approval.approvalId);
  if (new Set(approvalIds).size !== approvalIds.length) defects.push("approval_not_distinct");
  // Canonical review counts a reviewer by principal, so distinctness and independence are by principal.
  const principals = v.reviewers.map((reviewer) => reviewer.reviewerPrincipalId);
  if (new Set(principals).size !== principals.length) defects.push("reviewer_not_distinct");
  if (principals.includes(v.implementerPrincipalId)) defects.push("verifier_not_independent");
  const eventIds = [
    a.audit.eventId,
    ...a.approvals.map((approval) => approval.audit.eventId),
    v.audit.eventId,
    ...v.reviewers.map((reviewer) => reviewer.audit.eventId),
    r.audit.eventId
  ];
  if (new Set(eventIds).size !== eventIds.length) defects.push("audit_event_reused");
  return defects;
}

/** Build a receipt from machine-derived evidence, never a model's narrative. */
export function buildExecutionReceipt(input: unknown): ExecutionReceipt {
  const core = executionReceiptCoreSchema.parse(input);
  const defects = receiptDefects(core);
  if (defects.length) throw new ExecutionReceiptIncompleteError(defects);
  return executionReceiptSchema.parse({ ...core, receiptHash: executionReceiptHash(core) });
}

/**
 * Binding expectations must be obtained independently from a VERIFIED canonical audit chain and
 * current attempt, lease and verification-requirement state. Never use values copied from the
 * receipt as their own proof. `reviewersRequired`, `requireIndependentPrincipal` and
 * `requireIndependentProvider` are the canonical VerificationRequirement for this action
 * (policy-gate evaluateVerificationRequirement).
 */
export const receiptBindingSchema = z
  .object({
    workItemId: id,
    attemptId: id,
    workerId: id,
    actorId,
    actionHash: hash,
    admittedPlanHash: hash,
    manifestHash: hash,
    validationRunId: id,
    leaseId: id,
    claimTokenHash: hash,
    capabilityId: id,
    policyDecision: policyDecisionSchema,
    approvals: z.array(approvalRef).max(MAX_APPROVALS),
    policyAudit: auditRef,
    /** The canonical terminal outcome of the attempt. A receipt for any other outcome cannot verify. */
    attemptOutcome: attemptOutcomeSchema,
    resultId: id,
    implementerPrincipalId: actorId,
    implementerEngineId: engineId,
    implementerProviderId: engineId,
    reviewers: z.array(reviewerRef).max(MAX_REVIEWERS),
    reviewersRequired: z.number().int().min(0).max(MAX_REVIEWERS),
    requireIndependentPrincipal: z.boolean(),
    requireIndependentProvider: z.boolean(),
    criteriaPassed: z.number().int().positive().max(512),
    verificationAudit: auditRef,
    readbackAudit: auditRef
  })
  .strict()
  .superRefine(requireApprovalMatchesDecision);
export type ReceiptBinding = z.infer<typeof receiptBindingSchema>;

const sameRef = (x: { eventId: string; eventHash: string }, y: { eventId: string; eventHash: string }) =>
  x.eventId === y.eventId && x.eventHash === y.eventHash;

type Approval = z.infer<typeof approvalRef>;
function sameApproval(x: Approval, y: Approval): boolean {
  return (
    x.approvalId === y.approvalId &&
    x.actionHash === y.actionHash &&
    x.requestHash === y.requestHash &&
    x.grantHash === y.grantHash &&
    x.approverActorId === y.approverActorId &&
    x.grantedAt === y.grantedAt &&
    x.expiresAt === y.expiresAt &&
    x.consumedAt === y.consumedAt &&
    sameRef(x.audit, y.audit)
  );
}
/** The receipt's approval set must equal the canonical set, approval by approval, in approvalId order. */
function sameApprovalSet(x: readonly Approval[], y: readonly Approval[]): boolean {
  if (x.length !== y.length) return false;
  const left = [...x].sort((a, b) => a.approvalId.localeCompare(b.approvalId));
  const right = [...y].sort((a, b) => a.approvalId.localeCompare(b.approvalId));
  return left.every((approval, index) => {
    const other = right[index];
    return other !== undefined && sameApproval(approval, other);
  });
}

type Reviewer = z.infer<typeof reviewerRef>;
const reviewerKey = (reviewer: Reviewer) => `${reviewer.reviewerPrincipalId}\u0000${reviewer.audit.eventId}`;
function sameReviewers(x: readonly Reviewer[], y: readonly Reviewer[]): boolean {
  if (x.length !== y.length) return false;
  const left = [...x].sort((a, b) => reviewerKey(a).localeCompare(reviewerKey(b)));
  const right = [...y].sort((a, b) => reviewerKey(a).localeCompare(reviewerKey(b)));
  return left.every((reviewer, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      reviewer.reviewerPrincipalId === other.reviewerPrincipalId &&
      reviewer.verifierEngineId === other.verifierEngineId &&
      reviewer.verifierProviderId === other.verifierProviderId &&
      reviewer.verdict === other.verdict &&
      sameRef(reviewer.audit, other.audit)
    );
  });
}

export function verifyExecutionReceipt(receipt: unknown, expected: unknown): { ok: boolean; defects: string[] } {
  const parsed = executionReceiptSchema.safeParse(receipt);
  const binding = receiptBindingSchema.safeParse(expected);
  // An invalid receipt is a rejected submission. An invalid binding means trusted state could not be verified.
  // Callers must be able to tell these apart for diagnostics and alerting, so they get distinct defects.
  if (!parsed.success || !binding.success) {
    const schemaDefects: string[] = [];
    if (!parsed.success) schemaDefects.push("invalid_receipt_schema");
    if (!binding.success) schemaDefects.push("invalid_binding_schema");
    return { ok: false, defects: schemaDefects };
  }
  const { receiptHash, ...core } = parsed.data;
  const defects = receiptDefects(core);
  if (executionReceiptHash(core) !== receiptHash) defects.push("receipt_hash_invalid");
  const { manifest: m, authorization: a, verification: v, readback: r } = core;
  const b = binding.data;
  const check = (holds: boolean, defect: string) => {
    if (!holds) defects.push(defect);
  };

  check(m.workItemId === b.workItemId, "work_item_binding_mismatch");
  check(m.attemptId === b.attemptId, "attempt_binding_mismatch");
  check(m.workerId === b.workerId, "worker_binding_mismatch");
  check(m.actionHash === b.actionHash, "action_binding_mismatch");
  check(m.admittedPlanHash === b.admittedPlanHash, "plan_binding_mismatch");
  check(m.manifestHash === b.manifestHash, "manifest_binding_mismatch");
  check(m.testEvidence?.validationRunId === b.validationRunId, "validation_run_binding_mismatch");

  check(a.actorId === b.actorId, "actor_binding_mismatch");
  check(a.leaseId === b.leaseId, "lease_mismatch");
  check(a.claimTokenHash === b.claimTokenHash, "claim_mismatch");
  check(a.capabilityId === b.capabilityId, "capability_mismatch");
  check(a.policyDecision === b.policyDecision, "policy_decision_mismatch");
  check(sameApprovalSet(a.approvals, b.approvals), "approval_binding_mismatch");
  check(sameRef(a.audit, b.policyAudit), "policy_audit_mismatch");

  check(v.implementerPrincipalId === b.implementerPrincipalId, "implementer_binding_mismatch");
  check(v.implementerEngineId === b.implementerEngineId, "implementer_binding_mismatch");
  check(v.implementerProviderId === b.implementerProviderId, "implementer_provider_binding_mismatch");
  check(sameReviewers(v.reviewers, b.reviewers), "reviewer_binding_mismatch");
  // The canonical requirement is the bar: enough reviewers, from the canonical set, counted by principal.
  check(b.reviewers.length >= b.reviewersRequired, "canonical_reviewers_insufficient");
  check(v.reviewers.length >= b.reviewersRequired, "insufficient_reviewers");
  if (b.requireIndependentPrincipal) {
    check(!v.reviewers.some((reviewer) => reviewer.reviewerPrincipalId === v.implementerPrincipalId), "verifier_not_independent");
  }
  // Canonical provider independence excludes only the executor's provider. Reviewers may share a provider.
  if (b.requireIndependentProvider) {
    check(!v.reviewers.some((reviewer) => reviewer.verifierProviderId === v.implementerProviderId), "provider_not_independent");
  }
  check(r.status === b.attemptOutcome, "attempt_outcome_mismatch");
  check(r.resultId === b.resultId, "result_binding_mismatch");
  check(v.criteriaPassed === b.criteriaPassed, "criteria_binding_mismatch");
  check(sameRef(v.audit, b.verificationAudit), "verification_audit_mismatch");
  check(sameRef(r.audit, b.readbackAudit), "readback_audit_mismatch");
  return { ok: defects.length === 0, defects };
}
