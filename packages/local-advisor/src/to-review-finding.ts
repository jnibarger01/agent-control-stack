import { createReviewFinding, verifyReviewFindingHash, type ReviewFinding } from "@agent-control-stack/advisory";
import { type AdvisorResponse } from "./contracts.js";

export interface ReviewFindingBinding {
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
export function projectReviewFinding(response: AdvisorResponse, binding: ReviewFindingBinding): ReviewFinding | null {
  if (response.status !== "completed" || response.verdict === undefined) return null;
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
