import type { DatabaseSync } from "node:sqlite";
import { ControlStackError, stableHash, strictCanonicalJsonV1 } from "@agent-control-stack/shared";
import { z } from "zod";
import type { WorkItemStore } from "./store.js";
import { readVerifiedChangeSetAuthorityEvent } from "./change-set-approval-store.js";

export const changeSetReviewBodySchema = z
  .object({
    attemptId: z.string().min(1).max(256),
    evidenceManifestHash: z.string().regex(/^[a-f0-9]{64}$/u),
    verdict: z.enum(["PASS", "NEEDS_CHANGES", "BLOCK", "UNKNOWN"]),
    reason: z.string().min(1).max(4000)
  })
  .strict();
export type ChangeSetReviewInput = z.infer<typeof changeSetReviewBodySchema>;
export function changeSetReviewHash(finding: unknown) {
  return stableHash({ domain: "acs.change-set.review.v1", finding });
}

/** Legacy advisory findings never satisfy the canonical completion gate. */
export function verifyChangeSetReviews(
  db: DatabaseSync,
  store: WorkItemStore,
  attemptId: string,
  evidenceHash: string,
  required: number,
  excluded: string[]
): string[] {
  const seen = new Set<string>();
  const hashes: string[] = [];
  for (const review of store.listReviewFindings(attemptId)) {
    if (review.finding.schemaVersion !== "acs.change-set.review.v1") continue;
    const finding = review.finding;
    const eventRow = db
      .prepare(
        `SELECT id, sequence FROM audit_events WHERE name = 'review.finding_recorded'
      AND json_extract(body, '$.findingHash') = ?`
      )
      .get(review.findingHash) as { id: string; sequence: number } | undefined;
    const event = eventRow ? readVerifiedChangeSetAuthorityEvent(db, eventRow.id) : undefined;
    const evidenceEvent = db
      .prepare(
        `SELECT sequence FROM audit_events WHERE name = 'evidence.manifest_recorded'
      AND json_extract(body, '$.manifestHash') = ?`
      )
      .get(evidenceHash) as { sequence: number } | undefined;
    if (
      !event ||
      !evidenceEvent ||
      eventRow!.sequence <= evidenceEvent.sequence ||
      changeSetReviewHash(finding) !== review.findingHash ||
      finding.attemptId !== attemptId ||
      finding.workItemId !== review.workItemId ||
      finding.evidenceManifestHash !== evidenceHash ||
      review.evidenceManifestHash !== evidenceHash ||
      finding.reviewerPrincipalId !== review.reviewerPrincipalId ||
      finding.verdict !== review.verdict ||
      excluded.includes(review.reviewerPrincipalId) ||
      seen.has(review.reviewerPrincipalId) ||
      event.body.reviewerPrincipalId !== review.reviewerPrincipalId ||
      event.body.verdict !== review.verdict ||
      event.body.attemptId !== attemptId ||
      event.body.workItemId !== review.workItemId ||
      event.attributes["actor.id"] !== review.reviewerPrincipalId ||
      event.body.evidenceManifestHash !== evidenceHash
    )
      throw new ControlStackError(
        "change_set_review_integrity_mismatch",
        "review identity or evidence binding mismatch"
      );
    seen.add(review.reviewerPrincipalId);
    if (review.verdict !== "PASS") return [];
    hashes.push(review.findingHash);
  }
  return hashes.length >= required ? hashes : [];
}

export function assertChangeSetEvidenceAudit(
  db: DatabaseSync,
  evidence: {
    manifestHash: string;
    attemptId: string;
    workItemId: string;
    manifest: Record<string, unknown>;
  }
) {
  const row = db
    .prepare(
      `SELECT id, sequence FROM audit_events WHERE name = 'evidence.manifest_recorded'
    AND json_extract(body, '$.manifestHash') = ?`
    )
    .get(evidence.manifestHash) as { id: string; sequence: number } | undefined;
  const event = row ? readVerifiedChangeSetAuthorityEvent(db, row.id) : undefined;
  const resultRow = db
    .prepare(
      `SELECT sequence FROM audit_events WHERE name = 'execution_attempt.result_accepted'
    AND json_extract(body, '$.attemptId') = ?`
    )
    .get(evidence.attemptId) as { sequence: number } | undefined;
  if (
    !event ||
    !resultRow ||
    row!.sequence <= resultRow.sequence ||
    evidence.manifest.verifierId !== "acs-file-readback" ||
    evidence.manifest.attemptId !== evidence.attemptId ||
    event.body.attemptId !== evidence.attemptId ||
    event.body.workItemId !== evidence.workItemId ||
    stableHash({ domain: "acs.change-set.evidence.v1", evidence: evidence.manifest }) !== evidence.manifestHash ||
    !Array.isArray(evidence.manifest.observations) ||
    evidence.manifest.observations.length === 0 ||
    !evidence.manifest.observations.every(
      (item) => typeof item === "object" && item !== null && "passed" in item && item.passed === true
    )
  )
    throw new ControlStackError("change_set_evidence_integrity_mismatch", "machine evidence is missing or failed");
}

export function sameReview(left: unknown, right: unknown) {
  return strictCanonicalJsonV1(left) === strictCanonicalJsonV1(right);
}
