/**
 * Model and compute broker.
 *
 * An evidence-driven selection layer for local and hosted models. It decides *which model* should serve a request and
 * records why. It is not an authority: it grants no capability, holds no credentials, and does not replace ACS's worker
 * routing (Nimble). Callers keep whatever authorization they already have; the broker only ranks models the caller is
 * already allowed to use, and a privacy class can only narrow that set.
 */
export const PRIVACY_CLASSES = ["public", "internal", "confidential", "restricted"] as const;
export type PrivacyClass = (typeof PRIVACY_CLASSES)[number];

/** Higher means more sensitive. A provider may serve a request only if it is cleared for at least that level. */
export function privacyRank(privacy: PrivacyClass): number {
  return PRIVACY_CLASSES.indexOf(privacy);
}

export type ProviderKind = "local" | "hosted";

/** What the operator says a model is allowed and able to do. Discovery cannot know any of this. */
export interface CatalogEntry {
  providerId: string;
  model: string;
  kind: ProviderKind;
  taskTypes: string[];
  contextWindow?: number;
  /** Highest privacy class this model may serve. Defaults: local `restricted`, hosted `internal`. */
  maxPrivacy: PrivacyClass;
  /** Resident memory the model needs when loaded (local models). */
  memoryBytes?: number;
  needsGpu: boolean;
  vramBytes?: number;
  /** Lower is preferred when there is no evidence to rank on. */
  priority: number;
  /** Hosted list price, micro-USD per 1,000 tokens, for callers that compute a cost from reported tokens. The broker never estimates a cost itself. */
  costMicroUsdPer1kTokens?: { input: number; output: number };
}

/** What discovery actually observed. A model is usable only if it is both catalogued and observed here. */
export interface ProviderAvailability {
  providerId: string;
  kind: ProviderKind;
  /** Local: the endpoint answered. Hosted: always `unknown`; a credential's presence is not reachability. */
  reachable: boolean | "unknown";
  /** Hosted only: a credential is configured. Its value is never read into this structure. */
  credentialPresent?: boolean;
  models: string[];
  /** Models currently resident in memory (local servers that report it). */
  loadedModels: string[];
  checkedAt: string;
  error?: string;
}

export interface GpuDevice {
  name: string;
  totalBytes: number;
  freeBytes: number;
}

export interface ComputeSnapshot {
  takenAt: string;
  cpu: { cores: number; load1: number };
  memory: { totalBytes: number; availableBytes: number };
  /** `unknown` means the host could not be asked (no `nvidia-smi`); it does not mean there is no GPU. */
  gpus: { status: "unknown" | "none" | "present"; devices: GpuDevice[] };
}

export interface RouteRequest {
  /** Correlation and idempotency key: routing the same id again returns the first decision. */
  requestId: string;
  taskType: string;
  privacy: PrivacyClass;
  /** Tokens the prompt plus expected output need. Omit only if genuinely unknown. */
  requiredContextTokens?: number;
}

export type RejectionReason =
  | "not_available"
  | "provider_unreachable"
  | "task_unsupported"
  | "context_too_small"
  | "context_window_unknown"
  | "privacy_not_allowed"
  | "circuit_open"
  | "insufficient_memory"
  | "gpu_unconfirmed";

export interface EvidenceStats {
  /** All recorded attempts for this provider, model and task type in the window. */
  attempts: number;
  providerFailures: number;
  /** Outcomes that have an independent verification. Correctness is measured on these only. */
  verified: number;
  verifiedPassed: number;
  /** Lower bound of the 95% Wilson interval on verified correctness; absent below the minimum sample size. */
  correctnessLowerBound?: number;
  latencyP50Ms?: number;
  latencyP95Ms?: number;
  /** Mean over outcomes that reported a cost; absent if none did. */
  meanCostMicroUsd?: number;
  costReportedFor: number;
}

export interface RankedCandidate {
  providerId: string;
  model: string;
  kind: ProviderKind;
  priority: number;
  score?: number;
  stats: EvidenceStats;
  circuit: CircuitState;
  warnings: string[];
}

export interface RejectedCandidate {
  providerId: string;
  model: string;
  reasons: RejectionReason[];
}

export type RoutingMode = "evidence" | "default_priority" | "last_resort" | "none";
export type CircuitState = "closed" | "half_open" | "open";

export interface RoutingDecision {
  decisionId: string;
  requestId: string;
  taskType: string;
  privacy: PrivacyClass;
  requiredContextTokens?: number;
  mode: RoutingMode;
  /** Best first. Empty when nothing is eligible. */
  ranking: RankedCandidate[];
  rejected: RejectedCandidate[];
  /** Hash of the compute snapshot that was used, so the rationale can be tied to the host state it saw. */
  computeHash: string;
  createdAt: string;
  /** True when an earlier decision for the same requestId was returned unchanged. */
  replayed: boolean;
}

export interface RoutingPolicy {
  minSamples: number;
  minAcceptableCorrectness: number;
  weights: { correctness: number; latency: number; cost: number };
  circuit: { failureThreshold: number; cooldownMs: number };
  memoryReserveBytes: number;
  maxAttempts: number;
  evidenceWindowMs: number;
}

export const DEFAULT_ROUTING_POLICY: RoutingPolicy = {
  minSamples: 5,
  minAcceptableCorrectness: 0.6,
  weights: { correctness: 1, latency: 0.2, cost: 0.2 },
  circuit: { failureThreshold: 3, cooldownMs: 60_000 },
  memoryReserveBytes: 1024 ** 3,
  maxAttempts: 3,
  evidenceWindowMs: 30 * 24 * 3600 * 1000
};
