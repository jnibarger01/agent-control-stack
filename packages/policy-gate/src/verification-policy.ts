import { z } from "zod";
import type { ReviewFinding, ReviewVerdict } from "@agent-control-stack/advisory";

/**
 * Verification POLICY layer (ADR 0015). Not a second result authority.
 *
 * It answers exactly two questions:
 *   1. Requirement  — how many independent reviewers does this attempt need,
 *      and how are conflicts resolved?
 *   2. Classification — given a set of `ReviewFinding`s, what is the outcome?
 *      Disagreement is represented explicitly as `disputed`; it is never a
 *      silent pick of one reviewer.
 *
 * ACS `packages/work-items` remains the only thing that ACCEPTS a terminal
 * result. This module only produces a requirement and a classification for it
 * to consume.
 */

export const VERIFICATION_POLICY_VERSION = "acs.verification-policy.v1" as const;

export const conflictResolutionSchema = z.enum([
  "another_reviewer",
  "unanimous",
  "majority",
  "designated_reviewer",
  "human_approval"
]);
export type ConflictResolution = z.infer<typeof conflictResolutionSchema>;

export const verificationRequirementSchema = z
  .object({
    policyVersion: z.literal(VERIFICATION_POLICY_VERSION),
    reviewersRequired: z.number().int().min(0).max(8),
    requireIndependentPrincipal: z.boolean(),
    requireIndependentProvider: z.boolean(),
    conflictResolution: conflictResolutionSchema,
    humanEscalationRiskClasses: z.array(z.string().min(1)).max(16)
  })
  .strict();
export type VerificationRequirement = z.infer<typeof verificationRequirementSchema>;

export interface VerificationRequirementInput {
  /** ACS policy risk class for the attempt's action(s). */
  riskClass: "low" | "medium" | "high" | "critical" | string;
  /** Canonical action kinds requested (e.g. "fs.read", "fs.write", "shell"). */
  actionKinds: readonly string[];
  executorPrincipalId: string;
  executorProvider: string;
  /** Deployment override; defaults below are used when omitted. */
  overrides?: Partial<Pick<VerificationRequirement, "requireIndependentProvider" | "conflictResolution">>;
}

const READ_ONLY_KINDS = new Set([
  "system.status",
  "fs.list",
  "fs.stat",
  "fs.read",
  "fs.search_name",
  "cmd.preview"
]);
const DESTRUCTIVE_KINDS = new Set(["fs.delete", "fs.move", "service.restart", "shell", "cmd.run"]);

/**
 * Default verification requirement. Read-only low risk needs no reviewer;
 * source-code mutation needs one INDEPENDENT reviewer; destructive / high /
 * critical needs two. Independent principal is always required once any
 * reviewer is required (so `executorPrincipal != reviewerPrincipal`).
 */
export function evaluateVerificationRequirement(
  input: VerificationRequirementInput
): VerificationRequirement {
  const allReadOnly = input.actionKinds.length > 0 && input.actionKinds.every((k) => READ_ONLY_KINDS.has(k));
  const anyDestructive = input.actionKinds.some((k) => DESTRUCTIVE_KINDS.has(k));
  const highRisk = input.riskClass === "high" || input.riskClass === "critical";

  let reviewersRequired: number;
  if (allReadOnly && (input.riskClass === "low" || input.riskClass === "medium")) {
    reviewersRequired = 0;
  } else if (anyDestructive || highRisk) {
    reviewersRequired = 2;
  } else {
    reviewersRequired = 1;
  }

  return verificationRequirementSchema.parse({
    policyVersion: VERIFICATION_POLICY_VERSION,
    reviewersRequired,
    requireIndependentPrincipal: reviewersRequired > 0,
    requireIndependentProvider:
      input.overrides?.requireIndependentProvider ?? (highRisk || anyDestructive),
    conflictResolution:
      input.overrides?.conflictResolution ?? (highRisk ? "human_approval" : "another_reviewer"),
    humanEscalationRiskClasses: ["high", "critical"]
  });
}

export const verificationOutcomeSchema = z.enum([
  "pass",
  "needs_changes",
  "blocked",
  "disputed",
  "unknown",
  "insufficient_reviews"
]);
export type VerificationOutcome = z.infer<typeof verificationOutcomeSchema>;

export interface ReviewOutcomeClassification {
  outcome: VerificationOutcome;
  reason: string;
  /** The distinct verdicts observed, for the audit record. */
  verdicts: ReviewVerdict[];
  /** Reviewer principals counted toward the requirement. */
  independentReviewers: string[];
  /** What `conflictResolution` says must happen next when `disputed`. */
  nextStep?: ConflictResolution;
}

/**
 * Classify a set of review findings against a requirement. Fail-closed:
 * anything unclear ⇒ NOT `pass`. Conflicting findings ⇒ `disputed`, never a
 * silent selection.
 */
export function classifyReviewOutcome(
  findings: readonly ReviewFinding[],
  requirement: VerificationRequirement,
  options: { executorPrincipalId?: string; executorProvider?: string } = {}
): ReviewOutcomeClassification {
  if (requirement.reviewersRequired === 0) {
    return {
      outcome: "pass",
      reason: "no reviewer required for this attempt",
      verdicts: [],
      independentReviewers: []
    };
  }

  // Only findings from principals that satisfy the independence rules count.
  const eligible = findings.filter((f) => {
    if (requirement.requireIndependentPrincipal && f.reviewerPrincipalId === options.executorPrincipalId) {
      return false;
    }
    if (requirement.requireIndependentProvider && f.reviewerProvider === options.executorProvider) {
      return false;
    }
    return true;
  });

  // De-duplicate by reviewer principal (last finding wins per reviewer).
  const byReviewer = new Map<string, ReviewFinding>();
  for (const f of eligible) byReviewer.set(f.reviewerPrincipalId, f);
  const counted = [...byReviewer.values()];
  const independentReviewers = [...byReviewer.keys()];
  const verdicts = [...new Set(counted.map((f) => f.verdict))];

  if (counted.length < requirement.reviewersRequired) {
    return {
      outcome: "insufficient_reviews",
      reason: `requires ${requirement.reviewersRequired} independent reviewer(s), have ${counted.length}`,
      verdicts,
      independentReviewers
    };
  }

  if (counted.some((f) => f.verdict === "BLOCK")) {
    return { outcome: "blocked", reason: "at least one reviewer returned BLOCK", verdicts, independentReviewers };
  }
  if (counted.some((f) => f.verdict === "UNKNOWN")) {
    return { outcome: "unknown", reason: "at least one reviewer returned UNKNOWN", verdicts, independentReviewers };
  }

  const allPass = counted.every((f) => f.verdict === "PASS");
  const allNeedsChanges = counted.every((f) => f.verdict === "NEEDS_CHANGES");

  if (allPass) {
    return { outcome: "pass", reason: "every independent reviewer returned PASS", verdicts, independentReviewers };
  }
  if (allNeedsChanges) {
    return {
      outcome: "needs_changes",
      reason: "every independent reviewer returned NEEDS_CHANGES",
      verdicts,
      independentReviewers
    };
  }

  // Mixed PASS / NEEDS_CHANGES — genuine disagreement. Never silently pick one.
  return {
    outcome: "disputed",
    reason: "independent reviewers disagree (PASS vs NEEDS_CHANGES)",
    verdicts,
    independentReviewers,
    nextStep: requirement.conflictResolution
  };
}

/** True only when a terminal `succeeded` may be accepted for this attempt. */
export function verificationPermitsSuccess(outcome: VerificationOutcome): boolean {
  return outcome === "pass";
}
