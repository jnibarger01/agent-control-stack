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
  advisorRequestSchema,
  advisorResponseSchema,
  modelReviewOutputSchema
} from "./contracts.js";
export type { AdvisorOperation, AdvisorReason, AdvisorRequest, AdvisorResponse, AdvisorStatus, EvidenceItem } from "./contracts.js";
export { findModelOutputViolation, runAdvisor } from "./advisor.js";
export type { RunAdvisorOptions } from "./advisor.js";
export { ProviderError } from "./provider.js";
export type { AdvisorProvider, GenerateInput, GenerateResult, ProviderErrorKind } from "./provider.js";
export { DEFAULT_OLLAMA_BASE_URL, OllamaProvider, chatModelNames, listInstalledOllamaModels } from "./ollama-provider.js";
export type { InstalledOllamaModel, OllamaProviderOptions } from "./ollama-provider.js";
export { redactText } from "./redact.js";
export { EgressConfigError, assertDirectLoopbackEgress, noProxyCoversLoopback } from "./egress.js";
export {
  ADVISOR_MODEL_ROLES,
  DEFAULT_MODEL_ROUTES,
  ModelRouteError,
  modelRouteSchema,
  parseModelRoutes,
  selectModelRoute
} from "./router.js";
export type { AdvisorModelRole, ModelRoute } from "./router.js";
export { advisorTraceEvent } from "./trace-event.js";
export type { AdvisorAuthorizationOutcome } from "./trace-event.js";
export { projectReviewFinding } from "./to-review-finding.js";
export type { ReviewFindingBinding } from "./to-review-finding.js";
