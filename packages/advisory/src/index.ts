/**
 * @agent-control-stack/advisory
 *
 * Immutable, content-addressed ADVISORY artifacts and reviewer grants (ADR 0015).
 *
 * Everything here is UNTRUSTED until ACS acts on it. This package owns no
 * durable authority state: it defines contracts + hashing + fail-closed
 * verification helpers only. It does not admit plans, approve anything, execute
 * anything, or mutate any canonical work-item / attempt / lease / result / audit
 * state. That is `CONTROL_AUTHORITY` (ACS) only.
 */

export { principalRoleSchema, assertAdvisoryReasoner } from "./roles.js";
export type { PrincipalRole } from "./roles.js";

export {
  PLAN_PROPOSAL_SCHEMA_VERSION,
  PLAN_PROPOSAL_HASH_DOMAIN,
  planProposalSchema,
  planProposalActionSchema,
  planProposalHash,
  createPlanProposal,
  verifyPlanProposalHash
} from "./plan-proposal.js";
export type { PlanProposal, PlanProposalAction, CreatePlanProposalInput } from "./plan-proposal.js";

export {
  ADMITTED_PLAN_SCHEMA_VERSION,
  ADMITTED_PLAN_HASH_DOMAIN,
  admittedPlanBindingSchema,
  sandboxProfileSchema,
  networkProfileSchema,
  admittedPlanHash,
  admittedPlanAuthorityMismatch,
  capabilityProfileHash,
  validationProfileHash,
  workspaceIdentityFromContainment
} from "./admitted-plan.js";
export type { AdmittedPlanBinding, SandboxProfile } from "./admitted-plan.js";

export {
  REVIEW_FINDING_SCHEMA_VERSION,
  REVIEW_FINDING_HASH_DOMAIN,
  reviewVerdictSchema,
  findingSchema,
  reviewFindingSchema,
  reviewFindingBaseSchema,
  reviewFindingHash,
  createReviewFinding,
  verifyReviewFindingHash
} from "./review-finding.js";
export type { ReviewVerdict, Finding, ReviewFinding, CreateReviewFindingInput } from "./review-finding.js";

export {
  REVIEWER_GRANT_SCHEMA_VERSION,
  REVIEWER_GRANT_HASH_DOMAIN,
  REVIEWER_EVIDENCE_SCOPE,
  reviewerGrantSchema,
  reviewerGrantHash,
  issueReviewerGrant,
  checkReviewerGrant
} from "./reviewer-grant.js";
export type {
  ReviewerGrant,
  IssueReviewerGrantInput,
  ReviewerGrantTarget,
  ReviewerGrantCheck
} from "./reviewer-grant.js";
