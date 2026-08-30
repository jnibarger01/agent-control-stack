import { createId, domainHash } from "@agent-control-stack/shared";
import { z } from "zod";
import { assertAdvisoryReasoner } from "./roles.js";

/**
 * `acs.review-finding.v1` — an immutable advisory review result.
 *
 * A `ReviewFinding` is EVIDENCE to ACS verification policy. It does not, on its
 * own, change any terminal work-item state. A reviewer may return
 * `PASS | NEEDS_CHANGES | BLOCK | UNKNOWN`; it may never mark an execution
 * successful, authorize execution, approve itself, or mutate canonical state.
 */

export const REVIEW_FINDING_SCHEMA_VERSION = "acs.review-finding.v1" as const;
export const REVIEW_FINDING_HASH_DOMAIN = "acs:review-finding:v1" as const;

export const reviewVerdictSchema = z.enum(["PASS", "NEEDS_CHANGES", "BLOCK", "UNKNOWN"]);
export type ReviewVerdict = z.infer<typeof reviewVerdictSchema>;

const hash64 = z.string().regex(/^[a-f0-9]{64}$/u);
const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const boundedText = z.string().min(1).max(8_000);

/**
 * A `Finding` is a MODEL INTERPRETATION (not a machine fact). Machine facts are
 * `Observation`s in `packages/evidence` and live only inside an
 * `EvidenceManifest`.
 */
export const findingSchema = z
  .object({
    category: z.string().min(1).max(128),
    severity: z.enum(["info", "low", "medium", "high", "critical"]),
    summary: z.string().min(1).max(2_000),
    detail: z.string().max(16_000).default(""),
    /** References into the evidence manifest this finding is grounded in. */
    evidenceRefs: z.array(z.string().min(1).max(512)).max(64).default([])
  })
  .strict();

export type Finding = z.infer<typeof findingSchema>;

/** The object shape without the cross-field checks (so `.omit()` still works). */
export const reviewFindingBaseSchema = z
  .object({
    schemaVersion: z.literal(REVIEW_FINDING_SCHEMA_VERSION),
    findingId: identifierSchema,
    workItemId: identifierSchema,
    attemptId: identifierSchema,
    reviewerPrincipalId: identifierSchema,
    reviewerRole: z.literal("ADVISORY_REASONER"),
    /** Provider/model family, for the independent-provider verification constraint. */
    reviewerProvider: z.string().min(1).max(128),
    /** Must match an existing `EvidenceManifest.manifestHash`. */
    evidenceManifestHash: hash64,
    verdict: reviewVerdictSchema,
    findings: z.array(findingSchema).max(256).default([]),
    recommendedActions: z.array(boundedText).max(64).default([]),
    createdAt: z.string().datetime({ offset: true }),
    findingHash: hash64
  })
  .strict();

function coherenceIssues(value: { verdict: ReviewVerdict; findings: Finding[] }, context: z.RefinementCtx): void {
  if (
    value.verdict === "PASS" &&
    value.findings.some((f) => f.severity === "high" || f.severity === "critical")
  ) {
    context.addIssue({
      code: "custom",
      path: ["verdict"],
      message: "verdict cannot be PASS while high/critical findings are reported"
    });
  }
  if (value.verdict === "BLOCK" && value.findings.length === 0) {
    context.addIssue({ code: "custom", path: ["verdict"], message: "verdict BLOCK requires at least one finding" });
  }
}

export const reviewFindingSchema = reviewFindingBaseSchema.superRefine(coherenceIssues);

export type ReviewFinding = z.infer<typeof reviewFindingBaseSchema>;

export function reviewFindingHash(input: Omit<ReviewFinding, "findingHash">): string {
  return domainHash(REVIEW_FINDING_HASH_DOMAIN, {
    schemaVersion: input.schemaVersion,
    findingId: input.findingId,
    workItemId: input.workItemId,
    attemptId: input.attemptId,
    reviewerPrincipalId: input.reviewerPrincipalId,
    reviewerRole: input.reviewerRole,
    reviewerProvider: input.reviewerProvider,
    evidenceManifestHash: input.evidenceManifestHash,
    verdict: input.verdict,
    findings: input.findings,
    recommendedActions: input.recommendedActions,
    createdAt: input.createdAt
  });
}

export interface CreateReviewFindingInput {
  workItemId: string;
  attemptId: string;
  reviewerPrincipalId: string;
  reviewerRole: unknown;
  reviewerProvider: string;
  evidenceManifestHash: string;
  verdict: ReviewVerdict;
  findings?: Array<Partial<Finding> & { category: string; severity: Finding["severity"]; summary: string }>;
  recommendedActions?: string[];
  now?: Date;
}

export function createReviewFinding(input: CreateReviewFindingInput): ReviewFinding {
  assertAdvisoryReasoner(input.reviewerRole);
  const base = {
    schemaVersion: REVIEW_FINDING_SCHEMA_VERSION,
    findingId: createId("review_finding"),
    workItemId: input.workItemId,
    attemptId: input.attemptId,
    reviewerPrincipalId: input.reviewerPrincipalId,
    reviewerRole: "ADVISORY_REASONER" as const,
    reviewerProvider: input.reviewerProvider,
    evidenceManifestHash: input.evidenceManifestHash,
    verdict: input.verdict,
    findings: (input.findings ?? []).map((f) => findingSchema.parse(f)),
    recommendedActions: input.recommendedActions ?? [],
    createdAt: (input.now ?? new Date()).toISOString()
  };
  const parsedBase = reviewFindingBaseSchema.omit({ findingHash: true }).parse(base);
  return reviewFindingSchema.parse({ ...parsedBase, findingHash: reviewFindingHash(parsedBase) });
}

export function verifyReviewFindingHash(finding: ReviewFinding): boolean {
  const { findingHash: stored, ...rest } = finding;
  return reviewFindingHash(rest) === stored;
}
