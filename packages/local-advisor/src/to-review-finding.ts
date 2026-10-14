import { createReviewFinding, verifyReviewFindingHash, type ReviewFinding } from "@agent-control-stack/advisory";
import { type AdvisorResponse } from "./contracts.js";

export interface ReviewFindingBinding {
  /** Mission the caller sent to the advisor. Must equal `response.missionId`. */
  readonly missionId: string;
  /** `inputHash` of the request the caller sent. Must equal `response.inputHash`, binding the finding to what was reviewed. */
  readonly inputHash: string;
  readonly workItemId: string;
  readonly attemptId: string;
  /** Hash of an ACS EvidenceManifest. The advisor does not invent one. */
  readonly evidenceManifestHash: string;
  readonly reviewerPrincipalId: string;
  readonly now?: Date;
}

/**
 * Projects a completed advisor response into `acs.review-finding.v1`.
 * Non-completed statuses return null: an inference failure never becomes a finding,
 * and a finding never grants a capability or approves execution.
 */
export class ReviewBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewBindingError";
  }
}

export function projectReviewFinding(response: AdvisorResponse, binding: ReviewFindingBinding): ReviewFinding | null {
  if (response.status !== "completed" || response.verdict === undefined) return null;
  // Refuse cross-mission or cross-request projection: a review of A must never become evidence for B.
  if (response.missionId !== binding.missionId) {
    throw new ReviewBindingError("advisor response mission does not match the binding mission");
  }
  if (response.inputHash !== binding.inputHash) {
    throw new ReviewBindingError("advisor response input hash does not match the reviewed request");
  }
  const finding = createReviewFinding({
    workItemId: binding.workItemId,
    attemptId: binding.attemptId,
    reviewerPrincipalId: binding.reviewerPrincipalId,
    reviewerRole: "ADVISORY_REASONER",
    reviewerProvider: "ollama",
    evidenceManifestHash: binding.evidenceManifestHash,
    verdict: response.verdict,
    findings: response.findings.map((item) => ({
      category: item.category,
      severity: item.severity,
      summary: item.summary,
      evidenceRefs: [...item.evidenceRefs]
    })),
    recommendedActions: [...response.recommendedActions],
    now: binding.now
  });
  if (!verifyReviewFindingHash(finding)) {
    throw new Error("projected review finding failed its own hash check");
  }
  return finding;
}
