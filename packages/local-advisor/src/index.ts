/**
 * @agent-control-stack/local-advisor
 *
 * Local, advisory-only review. Outputs are untrusted recommendations: this package grants no capability, approves no
 * execution, and never overrides ACS policy. See docs in `README.md` for the trust boundary.
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
export { ProviderError } from "./provider.js";
export type { AdvisorProvider, GenerateInput, GenerateResult, ProviderErrorKind } from "./provider.js";
export { DEFAULT_OLLAMA_BASE_URL, OllamaProvider } from "./ollama-provider.js";
export type { OllamaProviderOptions } from "./ollama-provider.js";
export { redactText } from "./redact.js";
