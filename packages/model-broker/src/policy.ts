import type {
  CatalogEntry,
  CircuitState,
  ComputeSnapshot,
  EvidenceStats,
  ProviderAvailability,
  RankedCandidate,
  RejectedCandidate,
  RejectionReason,
  RouteRequest,
  RoutingMode,
  RoutingPolicy
} from "./types.js";
import { privacyRank } from "./types.js";

/** Lower bound of the Wilson score interval. Conservative with few samples, unlike the raw rate. */
export function wilsonLowerBound(passed: number, total: number, z = 1.96): number {
  if (total <= 0) return 0;
  const p = passed / total;
  const z2 = z * z;
  const centre = p + z2 / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);
  return Math.max(0, (centre - margin) / (1 + z2 / total));
}

export function percentile(sortedAscending: readonly number[], p: number): number | undefined {
  if (sortedAscending.length === 0) return undefined;
  const rank = Math.ceil((p / 100) * sortedAscending.length);
  return sortedAscending[Math.min(sortedAscending.length - 1, Math.max(0, rank - 1))];
}

export interface OutcomeForCircuit {
  ok: boolean;
  failureKind: "provider" | "request" | null;
  recordedAt: string;
}

/**
 * closed: healthy. open: the provider's most recent N attempts were all provider failures and the last one is inside the
 * cooldown. half_open: same streak, cooldown elapsed, so one attempt may probe it. A single success ends the streak.
 * Request-level failures (a bad request, a context overflow) say nothing about provider health and do not count.
 * `outcomes` must be newest first.
 */
export function circuitState(outcomes: readonly OutcomeForCircuit[], policy: RoutingPolicy, now: Date): CircuitState {
  const considered = outcomes.filter((o) => o.ok || o.failureKind === "provider");
  const recent = considered.slice(0, policy.circuit.failureThreshold);
  if (recent.length < policy.circuit.failureThreshold || recent.some((o) => o.ok)) return "closed";
  const lastFailure = Date.parse(recent[0]!.recordedAt);
  return now.getTime() - lastFailure < policy.circuit.cooldownMs ? "open" : "half_open";
}

export interface Candidate {
  entry: CatalogEntry;
  stats: EvidenceStats;
  circuit: CircuitState;
}

export interface RankInput {
  request: RouteRequest;
  catalog: readonly CatalogEntry[];
  availability: readonly ProviderAvailability[];
  compute: ComputeSnapshot;
  /** Keyed `${providerId}\u0000${model}`. */
  evidence: ReadonlyMap<string, { stats: EvidenceStats; circuit: CircuitState }>;
  policy: RoutingPolicy;
}

export const candidateKey = (providerId: string, model: string) => `${providerId}\u0000${model}`;

const EMPTY_STATS: EvidenceStats = { attempts: 0, providerFailures: 0, verified: 0, verifiedPassed: 0, costReportedFor: 0 };

/**
 * Pure selection. Hard eligibility first, in a fixed order, recording every reason a candidate was rejected. Then ranking:
 *
 *  1. Models with enough verified outcomes whose conservative correctness clears `minAcceptableCorrectness`, best score first.
 *  2. Models with too little evidence, by catalog priority. Cold start is explicit, not hidden: the mode says so.
 *  3. Models with enough evidence that clears nothing, best score first, as a last resort.
 *
 * Evidence ranks models; it never overrides an eligibility rule. A model that has been right every time is still rejected
 * if the request's privacy class exceeds its clearance.
 */
export function rankModels(input: RankInput): {
  mode: RoutingMode;
  ranking: RankedCandidate[];
  rejected: RejectedCandidate[];
} {
  const { request, policy } = input;
  const byProvider = new Map(input.availability.map((a) => [a.providerId, a]));
  const rejected: RejectedCandidate[] = [];
  const eligible: Array<Candidate & { warnings: string[] }> = [];

  for (const entry of input.catalog) {
    const reasons: RejectionReason[] = [];
    const warnings: string[] = [];
    const provider = byProvider.get(entry.providerId);
    const known = input.evidence.get(candidateKey(entry.providerId, entry.model));
    const stats = known?.stats ?? EMPTY_STATS;
    const circuit = known?.circuit ?? "closed";

    if (!provider) reasons.push("not_available");
    else if (entry.kind === "local" && provider.reachable !== true) reasons.push("provider_unreachable");
    else if (entry.kind === "local" && !provider.models.includes(entry.model)) reasons.push("not_available");
    else if (entry.kind === "hosted" && provider.credentialPresent !== true) reasons.push("not_available");

    if (!entry.taskTypes.includes(request.taskType)) reasons.push("task_unsupported");

    if (request.requiredContextTokens !== undefined) {
      if (entry.contextWindow === undefined) reasons.push("context_window_unknown");
      else if (entry.contextWindow < request.requiredContextTokens) reasons.push("context_too_small");
    }

    if (privacyRank(request.privacy) > privacyRank(entry.maxPrivacy)) reasons.push("privacy_not_allowed");
    if (circuit === "open") reasons.push("circuit_open");
    if (circuit === "half_open") warnings.push("circuit half-open: provider failed repeatedly and is being probed");

    if (entry.kind === "local") {
      const loaded = provider?.loadedModels.includes(entry.model) === true;
      if (entry.memoryBytes === undefined) warnings.push("memory requirement not declared in the catalog");
      else if (!loaded && input.compute.memory.availableBytes - policy.memoryReserveBytes < entry.memoryBytes) {
        reasons.push("insufficient_memory");
      }
      if (entry.needsGpu) {
        const free = input.compute.gpus.devices.reduce((max, d) => Math.max(max, d.freeBytes), 0);
        const confirmed =
          input.compute.gpus.status === "present" && (entry.vramBytes === undefined ? free > 0 : free >= entry.vramBytes);
        if (!confirmed) reasons.push("gpu_unconfirmed");
      }
    }

    if (reasons.length > 0) rejected.push({ providerId: entry.providerId, model: entry.model, reasons });
    else eligible.push({ entry, stats, circuit, warnings });
  }

  const evidenced = eligible.filter((c) => c.stats.correctnessLowerBound !== undefined);
  const maxP95 = Math.max(0, ...evidenced.map((c) => c.stats.latencyP95Ms ?? 0));
  const maxCost = Math.max(0, ...evidenced.map((c) => c.stats.meanCostMicroUsd ?? 0));
  const score = (c: Candidate) =>
    policy.weights.correctness * (c.stats.correctnessLowerBound ?? 0) -
    policy.weights.latency * (maxP95 > 0 && c.stats.latencyP95Ms !== undefined ? c.stats.latencyP95Ms / maxP95 : 0) -
    policy.weights.cost * (maxCost > 0 && c.stats.meanCostMicroUsd !== undefined ? c.stats.meanCostMicroUsd / maxCost : 0);

  const byScore = (a: Candidate, b: Candidate) =>
    score(b) - score(a) || a.entry.priority - b.entry.priority || a.entry.model.localeCompare(b.entry.model);
  const byPriority = (a: Candidate, b: Candidate) =>
    a.entry.priority - b.entry.priority ||
    a.entry.providerId.localeCompare(b.entry.providerId) ||
    a.entry.model.localeCompare(b.entry.model);

  const good = evidenced.filter((c) => (c.stats.correctnessLowerBound ?? 0) >= policy.minAcceptableCorrectness).sort(byScore);
  const cold = eligible.filter((c) => c.stats.correctnessLowerBound === undefined).sort(byPriority);
  const poor = evidenced.filter((c) => (c.stats.correctnessLowerBound ?? 0) < policy.minAcceptableCorrectness).sort(byScore);
  const ordered = [...good, ...cold, ...poor];

  const mode: RoutingMode =
    ordered.length === 0 ? "none" : good.length > 0 ? "evidence" : cold.length > 0 ? "default_priority" : "last_resort";
  const ranking: RankedCandidate[] = ordered.map((c) => ({
    providerId: c.entry.providerId,
    model: c.entry.model,
    kind: c.entry.kind,
    priority: c.entry.priority,
    ...(c.stats.correctnessLowerBound !== undefined ? { score: Number(score(c).toFixed(6)) } : {}),
    stats: c.stats,
    circuit: c.circuit,
    warnings: c.warnings
  }));
  rejected.sort((a, b) => a.providerId.localeCompare(b.providerId) || a.model.localeCompare(b.model));
  return { mode, ranking, rejected };
}
