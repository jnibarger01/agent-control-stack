import { ControlStackError } from "@agent-control-stack/shared";
import {
  storedExecutionResultPayloadHash,
  type AttemptLease,
  type ExecutionAttempt,
  type ReviewFindingProjection,
  type StoredExecutionResult,
  type VerificationDecisionProjection,
  type VerificationRequirementProjection
} from "@agent-control-stack/work-items";
import {
  receiptBindingSchema,
  verifyExecutionReceipt,
  type ExecutionReceipt,
  type ReceiptBinding
} from "./execution-receipt.js";

/**
 * The stored canonical records a receipt binding is derived from. Every binding field these records hold is
 * taken from them and from nowhere else: the attempt, the lease that authorized it, the accepted execution
 * result, the verification requirement and decision, and the review findings the decision cites.
 */
export interface CanonicalReceiptRecords {
  attempt: ExecutionAttempt;
  lease: AttemptLease;
  result: StoredExecutionResult;
  requirement: VerificationRequirementProjection;
  decision: VerificationDecisionProjection;
  reviews: readonly ReviewFindingProjection[];
}

interface AuditRef {
  eventId: string;
  eventHash: string;
}

/**
 * Canonical facts that live outside those records (verified audit-chain references, the capability, the
 * validation run and the approval grants). The approval set is still checked against the lease's approval ids,
 * and each review audit reference is keyed by the stored finding hash.
 */
export interface CanonicalReceiptContext {
  actorId: string;
  capabilityId: string;
  admittedPlanHash: string;
  validation: ReceiptBinding["validation"];
  approvals: ReceiptBinding["approvals"];
  implementer: { principalId: string; engineId: string; providerId: string };
  policyAudit: AuditRef;
  verificationAudit: AuditRef;
  readbackAudit: AuditRef;
  reviewAudit: Readonly<Record<string, AuditRef>>;
}

export class ReceiptBindingInconsistentError extends ControlStackError {
  constructor(readonly reason: string) {
    super("receipt_binding_inconsistent", `canonical receipt records are inconsistent: ${reason}`);
    this.name = "ReceiptBindingInconsistentError";
  }
}

const ATTEMPT_OUTCOMES = new Set(["succeeded", "failed", "cancelled", "interrupted", "unknown", "quarantined"]);

function requireBool(requirement: Record<string, unknown>, key: string): boolean {
  const value = requirement[key];
  if (typeof value !== "boolean") throw new ReceiptBindingInconsistentError(`requirement_${key}_missing`);
  return value;
}

/** Derive a ReceiptBinding exclusively from stored canonical records. Throws when the records disagree. */
export function receiptBindingFromCanonicalRecords(
  records: CanonicalReceiptRecords,
  context: CanonicalReceiptContext
): ReceiptBinding {
  const { attempt, lease, result, requirement, decision, reviews } = records;
  const fail = (reason: string): never => {
    throw new ReceiptBindingInconsistentError(reason);
  };
  if (lease.attemptId !== attempt.attemptId || lease.workItemId !== attempt.workItemId) fail("lease_attempt");
  if (lease.planHash !== attempt.planHash) fail("lease_plan_hash");
  if (attempt.claimedByWorkerId !== undefined && attempt.claimedByWorkerId !== lease.workerId) fail("attempt_worker");
  if (result.leaseId !== lease.leaseId || result.workerId !== lease.workerId) fail("result_lease");
  if (result.workItemId !== attempt.workItemId) fail("result_work_item");
  const resultPayloadHash = storedExecutionResultPayloadHash(result);
  if (resultPayloadHash !== result.payloadHash) fail("result_payload_hash");
  if (requirement.attemptId !== attempt.attemptId || requirement.workItemId !== attempt.workItemId)
    fail("requirement_attempt");
  if (decision.attemptId !== attempt.attemptId || decision.workItemId !== attempt.workItemId) fail("decision_attempt");
  if (decision.outcome !== "attempt_accepted") fail("decision_not_accepted");
  if (!ATTEMPT_OUTCOMES.has(attempt.status)) fail("attempt_not_terminal");

  const leaseApprovalIds = [lease.approvalId, ...(lease.additionalApprovalIds ?? [])].filter(
    (value): value is string => value !== undefined
  );
  const approvalIds = context.approvals.map((approval) => approval.approvalId);
  if (
    leaseApprovalIds.length !== approvalIds.length ||
    [...leaseApprovalIds].sort().join("\u0000") !== [...approvalIds].sort().join("\u0000")
  )
    fail("approval_set");

  const byHash = new Map(reviews.map((review) => [review.findingHash, review]));
  const reviewers = decision.reviewFindingHashes.map((findingHash) => {
    const review = byHash.get(findingHash) ?? fail("review_missing");
    if (review.attemptId !== attempt.attemptId || review.workItemId !== attempt.workItemId) fail("review_attempt");
    if (review.evidenceManifestHash !== decision.evidenceManifestHash) fail("review_manifest");
    if (review.verdict !== "PASS") fail("review_not_pass");
    // The engine must come from the stored review record, written by the server at review time.
    const verifierEngineId = review.verifierEngineId ?? fail("review_engine_unknown");
    const audit = context.reviewAudit[findingHash] ?? fail("review_audit_missing");
    return {
      reviewerPrincipalId: review.reviewerPrincipalId,
      verifierEngineId,
      verifierProviderId: review.reviewerProvider,
      verdict: "pass" as const,
      audit: { eventId: audit.eventId, eventHash: audit.eventHash }
    };
  });

  return receiptBindingSchema.parse({
    workItemId: attempt.workItemId,
    attemptId: attempt.attemptId,
    workerId: lease.workerId,
    actorId: context.actorId,
    actionHash: result.actionHash,
    admittedPlanHash: context.admittedPlanHash,
    attemptPlanHash: attempt.planHash,
    manifestHash: decision.evidenceManifestHash,
    validation: context.validation,
    leaseId: lease.leaseId,
    claimTokenHash: lease.tokenHash,
    capabilityId: context.capabilityId,
    policyDecision: leaseApprovalIds.length > 0 ? "require_approval" : "allow",
    policyVersion: lease.policyVersion,
    policyDecisionHash: lease.policyDecisionHash,
    approvals: context.approvals,
    policyAudit: context.policyAudit,
    attemptOutcome: attempt.status,
    resultId: result.resultId,
    resultPayloadHash,
    implementerPrincipalId: context.implementer.principalId,
    implementerEngineId: context.implementer.engineId,
    implementerProviderId: context.implementer.providerId,
    reviewers,
    reviewersRequired: requirement.reviewersRequired,
    requireIndependentPrincipal: requireBool(requirement.requirement, "requireIndependentPrincipal"),
    requireIndependentProvider: requireBool(requirement.requirement, "requireIndependentProvider"),
    criteriaPassed: reviewers.length,
    verificationAudit: context.verificationAudit,
    readbackAudit: context.readbackAudit
  });
}

/** Verify a receipt against a binding derived from stored canonical records. Inconsistent records never verify. */
export function verifyExecutionReceiptAgainstRecords(
  receipt: unknown,
  records: CanonicalReceiptRecords,
  context: CanonicalReceiptContext
): { ok: boolean; defects: string[] } {
  let binding: ReceiptBinding;
  try {
    binding = receiptBindingFromCanonicalRecords(records, context);
  } catch (error) {
    if (error instanceof ReceiptBindingInconsistentError) return { ok: false, defects: [error.code, error.reason] };
    return { ok: false, defects: ["invalid_binding_schema"] };
  }
  return verifyExecutionReceipt(receipt, binding);
}

/** One execution_receipts row (migration 071, PLAN P1-7). */
export interface ExecutionReceiptRow {
  receiptId: string;
  subject: string;
  docJson: string;
  docHash: string;
  prevHash: string | null;
  auditEventHash: string;
}

/**
 * Project a built receipt into the single P1-7 row format. `docHash` is the receipt hash, so a stored row is
 * verifiable by recomputing the receipt hash from `docJson`. `subject` names the attempt the receipt is about.
 */
export function executionReceiptRow(
  receipt: ExecutionReceipt,
  chain: { prevHash: string | null; auditEventHash: string }
): ExecutionReceiptRow {
  return {
    receiptId: `rcpt_${receipt.receiptHash.slice(0, 32)}`,
    subject: `work_item:${receipt.manifest.workItemId}/attempt:${receipt.manifest.attemptId}`,
    docJson: JSON.stringify(receipt),
    docHash: receipt.receiptHash,
    prevHash: chain.prevHash,
    auditEventHash: chain.auditEventHash
  };
}
