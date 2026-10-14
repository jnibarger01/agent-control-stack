/**
 * @agent-control-stack/local-advisor
 *
 * Local, advisory-only review over Ollama. Outputs are untrusted recommendations: this package grants no capability,
 * approves no execution, and never overrides ACS policy.
 *
 * This is not `@agent-control-stack/jev-advisor`. Jev is the System One probability client (ADR 0020). A free-form
 * Ollama reviewer does not belong in that package or in its ESLint allow-list.
 */
export {
  ADVISOR_OPERATIONS,
  ADVISOR_REASONS,
  ADVISOR_SCHEMA_VERSION,
  ADVISOR_STATUSES,
  AdvisorRequestError,
  MAX_TOTAL_EVIDENCE_CHARS,
  advisorRequestSchema,
  advisorResponseSchema,
  modelReviewOutputSchema
} from "./contracts.js";
export type {
  AdvisorOperation,
  AdvisorReason,
  AdvisorRequest,
  AdvisorResponse,
  AdvisorStatus,
  EvidenceItem
} from "./contracts.js";
export { findModelOutputViolation, runAdvisor } from "./advisor.js";
export type { RunAdvisorOptions } from "./advisor.js";
export { ProviderError } from "./provider.js";
export type { AdvisorProvider, GenerateInput, GenerateResult, ProviderErrorKind } from "./provider.js";
export {
  DEFAULT_OLLAMA_BASE_URL,
  OllamaProvider,
  assertOllamaBaseUrl,
  chatModelNames,
  listInstalledOllamaModels
} from "./ollama-provider.js";
export type { InstalledOllamaModel, OllamaProviderOptions } from "./ollama-provider.js";
export { redactText } from "./redact.js";
export { EgressConfigError, assertDirectLoopbackEgress, envProxyModeOn, nodeWouldProxy } from "./egress.js";
export {
  ADVISOR_MODEL_ROLES,
  DEFAULT_MODEL_ROUTES,
  ModelRouteError,
  modelRouteSchema,
  parseModelRoutes,
  selectModelRoute
} from "./router.js";
export type { AdvisorModelRole, ModelRoute } from "./router.js";
export type { AdvisorAuthorizationOutcome } from "./trace-event.js";
export { ReviewBindingError, projectReviewFinding, projectReviewFindingFromConsultation } from "./to-review-finding.js";
export type { ReviewFindingBinding } from "./to-review-finding.js";
export { consultationDraftFromResponse, recordLocalAdvisorConsultation } from "./to-consultation.js";
export type { LocalAdvisorFence, RecordLocalAdvisorConsultationInput } from "./to-consultation.js";
export { advisorTraceEvent, advisorTraceEventFromConsultation } from "./trace-event.js";
