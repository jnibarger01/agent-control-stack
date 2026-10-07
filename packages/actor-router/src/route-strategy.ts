/**
 * Route enrichment: the structured execution strategy ACS attaches to a persisted route (ADR 0025).
 *
 * Everything here is deterministic ACS policy. A model (Nimble, later) may *recommend* a strategy, but a
 * recommendation outside the policy-derived candidate set is rejected and recorded, never repaired or followed.
 * Jev is not an input: its output lives in routing_shadow_observations and is only joined for comparison.
 */
import type { RouteEnrichment, RouteExecutorClass, RouteStrategy } from "@agent-control-stack/work-items";

export const ROUTE_ENRICHMENT_VERSION = "acs-route-enrichment@1";

/** Mirrors the work-unit kinds. Kept local because the coding-mission package depends on this one. */
export type RouteUnitKind =
  "planning" | "coding" | "shell" | "tool" | "desktop" | "cua" | "verification" | "agent" | "swarm" | "recovery";
export type RouteVerificationPolicy = "none" | "lightweight" | "independent" | "multi_verifier" | "release_gate";

export interface RouteUnitContext {
  kind: RouteUnitKind;
  verificationPolicy: RouteVerificationPolicy;
}

/** Mission/ACS policy bounds on the strategy. Hard limits: a model recommendation can never exceed them. */
export interface RoutePolicy {
  allowedStrategies?: readonly RouteStrategy[];
  maxParallelism?: number;
  delegationAllowed?: boolean;
  modelClass?: string;
  checkpointPolicy?: string;
  retryPolicy?: string;
}

/** A model's strategy recommendation. Its return value is untrusted input. */
export type StrategyChooser = (input: {
  candidates: readonly RouteStrategy[];
  unit: RouteUnitContext;
  eligibleCount: number;
}) => Promise<string | undefined> | string | undefined;

const SAFE = /[^A-Za-z0-9_.:-]/gu;
const SAFE_LIST = /[^A-Za-z0-9_.:,-]/gu;

export const MAX_ROUTE_PARALLELISM = 8;
export const DEFAULT_STRATEGY_CHOOSER_TIMEOUT_MS = 1000;

const EXECUTOR_CLASS_BY_KIND: Readonly<Record<RouteUnitKind, RouteExecutorClass>> = {
  coding: "coding",
  shell: "shell",
  tool: "shell",
  desktop: "desktop",
  cua: "cua",
  agent: "agent",
  swarm: "swarm",
  planning: "agent",
  verification: "agent",
  recovery: "agent"
};

export function executorClassFor(kind: RouteUnitKind): RouteExecutorClass {
  return EXECUTOR_CLASS_BY_KIND[kind];
}

export interface StrategyCandidates {
  candidates: RouteStrategy[];
  reasons: Array<{ code: string; detail?: string }>;
  /** True when the policy allow-list leaves no candidate. The route must be rejected, never defaulted. */
  rejected?: boolean;
}

/**
 * Thrown by deriveRouteEnrichment when policy leaves no allowed strategy. Fail closed: callers must reject the
 * route and persist `reasons` / `deterministicEvidence`, never substitute a default strategy.
 */
export class RouteStrategyRejectedError extends Error {
  readonly code = "route_strategy_rejected";
  constructor(
    readonly reasons: StrategyCandidates["reasons"],
    readonly deterministicEvidence: Array<{ kind: string; value: unknown }>
  ) {
    super("route policy allow-list leaves no permitted strategy");
    this.name = "RouteStrategyRejectedError";
  }
}

/** The hard-policy candidate set. Anything a model says is checked against exactly this list. */
export function candidateStrategies(
  unit: RouteUnitContext,
  eligibleCount: number,
  policy: RoutePolicy = {}
): StrategyCandidates {
  const reasons: StrategyCandidates["reasons"] = [];
  const candidates: RouteStrategy[] = ["single"];
  const planning = unit.kind === "coding" || unit.kind === "agent";
  if (planning) candidates.push("plan_execute");
  if (unit.verificationPolicy !== "none" && unit.kind !== "verification" && eligibleCount >= 2) {
    // The verifier must be a different executor from the maker, so a second eligible executor is required.
    candidates.push("maker_verifier");
  } else if (unit.verificationPolicy !== "none" && eligibleCount < 2) {
    reasons.push({ code: "maker_verifier_unavailable", detail: "needs a second eligible executor" });
  }
  const parallelLimit = Math.min(policy.maxParallelism ?? 1, eligibleCount, MAX_ROUTE_PARALLELISM);
  if (parallelLimit >= 2 && (unit.kind === "coding" || unit.kind === "agent" || unit.kind === "swarm")) {
    candidates.push("parallel_candidates");
  }
  if (policy.delegationAllowed === true && (unit.kind === "agent" || unit.kind === "swarm")) {
    candidates.push("specialist_delegation");
  }
  if (unit.kind === "cua") candidates.push("cua_recovery");
  if (!policy.allowedStrategies) return { candidates, reasons };
  const allowed = new Set<RouteStrategy>(policy.allowedStrategies);
  const narrowed = candidates.filter((strategy) => allowed.has(strategy));
  if (narrowed.length === 0) {
    // Fail closed: an empty or non-matching allow-list rejects the route. It never falls back to `single`.
    reasons.push({
      code: "allowed_strategies_rejected",
      detail: (policy.allowedStrategies.length === 0 ? "empty" : policy.allowedStrategies.join(","))
        .replace(SAFE_LIST, "?")
        .slice(0, 64)
    });
    return { candidates: [], reasons, rejected: true };
  }
  return { candidates: narrowed, reasons };
}

export function deriveRouteEnrichment(input: {
  unit: RouteUnitContext;
  eligibleCount: number;
  policy?: RoutePolicy;
  /** The model's recommended strategy, if one was obtained. Untrusted. */
  recommended?: string;
}): RouteEnrichment {
  const policy = input.policy ?? {};
  const { candidates, reasons, rejected } = candidateStrategies(input.unit, input.eligibleCount, policy);
  const baseEvidence = (): Array<{ kind: string; value: unknown }> => [
    { kind: "unit_kind", value: input.unit.kind },
    { kind: "verification_policy", value: input.unit.verificationPolicy },
    { kind: "eligible_count", value: input.eligibleCount },
    { kind: "candidate_strategies", value: candidates },
    ...(policy.maxParallelism === undefined ? [] : [{ kind: "max_parallelism", value: policy.maxParallelism }]),
    ...(policy.allowedStrategies ? [{ kind: "allowed_strategies", value: [...policy.allowedStrategies] }] : [])
  ];
  if (rejected || candidates.length === 0) {
    if (input.recommended !== undefined) {
      reasons.push({
        code: "strategy_recommendation_rejected",
        detail: input.recommended.replace(SAFE, "?").slice(0, 64)
      });
    }
    throw new RouteStrategyRejectedError(reasons.slice(0, 16), baseEvidence());
  }
  let strategy: RouteStrategy = candidates.includes("single") ? "single" : candidates[0]!;
  let strategySource: RouteEnrichment["strategySource"] = "deterministic";
  if (input.recommended !== undefined) {
    if ((candidates as readonly string[]).includes(input.recommended)) {
      strategy = input.recommended as RouteStrategy;
      strategySource = "model";
      reasons.push({ code: "strategy_model_choice", detail: strategy });
    } else {
      reasons.push({
        code: "strategy_recommendation_rejected",
        detail: input.recommended.replace(SAFE, "?").slice(0, 64)
      });
    }
  }
  if (strategySource === "deterministic") reasons.push({ code: `strategy_default_${strategy}` });
  const verificationRequired = input.unit.verificationPolicy !== "none";
  if (verificationRequired) reasons.push({ code: "verification_required", detail: input.unit.verificationPolicy });
  let parallelism = 1;
  if (strategy === "parallel_candidates") {
    parallelism = Math.min(policy.maxParallelism ?? 1, input.eligibleCount, MAX_ROUTE_PARALLELISM);
    if (parallelism < (policy.maxParallelism ?? 1))
      reasons.push({ code: "parallelism_capped", detail: String(parallelism) });
  }
  const checkpointPolicy = policy.checkpointPolicy ?? (input.unit.kind === "cua" ? "per_logical_action" : undefined);
  return {
    executorClass: executorClassFor(input.unit.kind),
    strategy,
    strategySource,
    ...(policy.modelClass ? { modelClass: policy.modelClass } : {}),
    parallelism,
    verificationRequired,
    ...(checkpointPolicy ? { checkpointPolicy } : {}),
    ...(policy.retryPolicy ? { retryPolicy: policy.retryPolicy } : {}),
    reasons: reasons.slice(0, 16),
    deterministicEvidence: baseEvidence(),
    version: ROUTE_ENRICHMENT_VERSION
  };
}

/** Ask the chooser with a timeout. Any failure means "no recommendation"; the route never waits on it indefinitely. */
export async function recommendStrategy(
  chooser: StrategyChooser | undefined,
  input: Parameters<StrategyChooser>[0],
  timeoutMs = DEFAULT_STRATEGY_CHOOSER_TIMEOUT_MS
): Promise<string | undefined> {
  if (!chooser) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = await Promise.race([
      Promise.resolve().then(() => chooser(input)),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      })
    ]);
    return typeof answer === "string" ? answer : undefined;
  } catch {
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
