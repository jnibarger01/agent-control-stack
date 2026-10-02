/**
 * Nimble selects. ACS policy authorizes. This package does not execute tools.
 * Jev may be compared in shadow and never replaces an accepted Nimble choice.
 */
export { authorizeOperation, authorizationFactsSchema } from "./authorize.js";
export type { AuthorizationFacts } from "./authorize.js";
export {
  decide,
  decideParsed,
  parseDecisionBatch,
  DecisionAuthorityError,
  DecisionModelUnavailable,
  DecisionParseError
} from "./decide.js";
export type { DecidedAnswer, DecidedBatch, NimbleDecisionModel, ParsedDecision } from "./decide.js";
export { selectDecisionLevel } from "./hierarchy.js";
export type { DecisionLevel } from "./hierarchy.js";
export { nextMissionAction, resolveNextOperationSelection } from "./loop.js";
export type { MissionPolicyFacts, MissionStep } from "./loop.js";
export { doneProjection, doneQuestion } from "./questions/done.js";
export { nextOperationProjection, nextOperationQuestion } from "./questions/next-operation.js";
export { relevanceProjection, relevanceQuestion } from "./questions/relevance.js";
export { riskProjection, riskQuestion } from "./questions/risk.js";
export { routeProjection, routeQuestion } from "./questions/route.js";
export { buildDecisionReceipt, candidateIdsFor } from "./receipts.js";
export type { DecisionReceipt } from "./receipts.js";
export {
  decisionAnswerSchema,
  decisionQuestionSchema,
  doneQuestionSchema,
  nextOperationQuestionSchema,
  relevanceQuestionSchema,
  riskQuestionSchema,
  routeQuestionSchema
} from "./schemas.js";
export type { AuthorizationResult, DecisionAnswer, DecisionQuestion, DecisionResult, DecisionType } from "./schemas.js";
export { applyShadow, compareShadow } from "./shadow.js";
export type { ShadowComparison } from "./shadow.js";
export { CAPABILITY_FOR_CLASS, SIDE_EFFECT_CLASSES, classifySideEffect } from "./side-effect.js";
export type { SideEffectClass } from "./side-effect.js";
export {
  DEFAULT_CONFIDENCE_THRESHOLDS,
  RELEVANCE_KEEP_CUTOFF,
  confidenceThreshold,
  relevanceKeep
} from "./thresholds.js";
export type { ConfidenceThresholds } from "./thresholds.js";
