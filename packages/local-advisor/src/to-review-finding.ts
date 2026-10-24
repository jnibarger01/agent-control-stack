import { createReviewFinding, verifyReviewFindingHash, type ReviewFinding } from "@agent-control-stack/advisory";
import type { AdvisorConsultationRecord } from "@agent-control-stack/work-items";
import { type AdvisorResponse } from "./contracts.js";
import { redactText } from "./redact.js";

/** Every text that reaches a finding is redacted here too, whatever the caller already did. */
const redacted = (text: string, max: number) => redactText(text).text.slice(0, max);

export interface ReviewFindingBinding {
  /** Mission the caller sent to the advisor. Must equal `response.missionId`. */
  readonly missionId: string;
  /** `inputHash` of the request the caller sent. Must equal `response.inputHash`, binding the finding to what was reviewed. */
  readonly inputHash: string;
  /** Work item the finding is recorded against. Must equal `response.missionId` (the trace's `work_item_id`). */
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
  // The advisor trace records missionId as work_item_id, so the finding's work item must be that same mission.
  if (binding.workItemId !== response.missionId) {
    throw new ReviewBindingError("binding work item does not match the advisor response mission");
  }
  if (response.inputHash !== binding.inputHash) {
    throw new ReviewBindingError("advisor response input hash does not match the reviewed request");
  }
  return buildFinding(binding, {
    verdict: response.verdict,
    findings: response.findings.map((item) => ({
      category: redacted(item.category, 128),
      severity: item.severity,
      summary: redacted(item.summary, 2_000),
      evidenceRefs: [...item.evidenceRefs]
    })),
    recommendedActions: response.recommendedActions.map((action) => redacted(action, 500))
  });
}

/**
 * Derived view of a stored #367 consultation at trust "asserted". Only `reviewed` with guidance becomes a finding;
 * `declined` / `unavailable` return null and never satisfy completion. The finding never feeds authority,
 * approvals, or receipts.
 */
export function projectReviewFindingFromConsultation(
  record: AdvisorConsultationRecord,
  binding: ReviewFindingBinding
): ReviewFinding | null {
  if (record.disposition !== "reviewed" || !record.guidanceText) return null;
  if (record.missionId !== binding.missionId) {
    throw new ReviewBindingError("consultation mission does not match the binding mission");
  }
  if (binding.workItemId !== record.missionId) {
    throw new ReviewBindingError("binding work item does not match the consultation mission");
  }
  const inputHash = record.inputSha256.startsWith("sha256:") ? record.inputSha256 : `sha256:${record.inputSha256}`;
  if (inputHash !== binding.inputHash) {
    throw new ReviewBindingError("consultation input hash does not match the reviewed request");
  }
  return buildFinding(binding, {
    verdict: "UNKNOWN",
    findings: [
      {
        category: "advisor_consultation",
        severity: "info",
        summary: redacted(record.guidanceText, 2_000),
        evidenceRefs: ["consultation"]
      }
    ],
    recommendedActions: []
  });
}

function buildFinding(
  binding: ReviewFindingBinding,
  content: {
    verdict: ReviewFinding["verdict"];
    findings: Array<{
      category: string;
      severity: ReviewFinding["findings"][number]["severity"];
      summary: string;
      evidenceRefs: string[];
    }>;
    recommendedActions: string[];
  }
): ReviewFinding {
  const finding = createReviewFinding({
    workItemId: binding.workItemId,
    attemptId: binding.attemptId,
    reviewerPrincipalId: binding.reviewerPrincipalId,
    reviewerRole: "ADVISORY_REASONER",
    reviewerProvider: "ollama",
    evidenceManifestHash: binding.evidenceManifestHash,
    verdict: content.verdict,
    findings: content.findings,
    recommendedActions: content.recommendedActions,
    now: binding.now
  });
  if (!verifyReviewFindingHash(finding)) {
    throw new Error("projected review finding failed its own hash check");
  }
  return finding;
}
