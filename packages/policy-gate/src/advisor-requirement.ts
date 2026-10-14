/**
 * Whether a mission requires an advisor result before ACS may proceed.
 *
 * This module does not call a model and does not import `@agent-control-stack/local-advisor`.
 * A completed review is evidence only. It is never an allow, a capability, or an approval.
 * When the advisor is required and did not complete, the decision is fail-closed.
 * When the advisor is not required, independently authorized ACS operations continue.
 */
export const ADVISOR_REQUIREMENTS = ["not_required", "required"] as const;
export type AdvisorRequirement = (typeof ADVISOR_REQUIREMENTS)[number];

export const ADVISOR_OPERATIONAL_STATUSES = [
  "completed",
  "unavailable",
  "timeout",
  "invalid_output",
  "insufficient_evidence",
  "absent"
] as const;
export type AdvisorOperationalStatus = (typeof ADVISOR_OPERATIONAL_STATUSES)[number];

export type AdvisorRequirementDecision =
  | { readonly effect: "not_applicable" }
  | { readonly effect: "evidence_only"; readonly note: "advisor_completed_is_not_authorization" }
  | { readonly effect: "fail_closed"; readonly reason: "advisor_required_but_not_completed" };

export function decideAdvisorRequirement(
  requirement: AdvisorRequirement,
  status: AdvisorOperationalStatus
): AdvisorRequirementDecision {
  if (requirement === "not_required") return { effect: "not_applicable" };
  if (status === "completed") {
    return { effect: "evidence_only", note: "advisor_completed_is_not_authorization" };
  }
  return { effect: "fail_closed", reason: "advisor_required_but_not_completed" };
}
