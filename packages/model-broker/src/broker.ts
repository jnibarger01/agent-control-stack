import { z } from "zod";
import { ControlStackError } from "@agent-control-stack/shared";
import { computeHash } from "./compute.js";
import type { ModelEvidenceStore } from "./evidence.js";
import { candidateKey, rankModels } from "./policy.js";
import {
  DEFAULT_ROUTING_POLICY,
  PRIVACY_CLASSES,
  type CatalogEntry,
  type ComputeSnapshot,
  type EvidenceStats,
  type CircuitState,
  type ProviderAvailability,
  type RouteRequest,
  type RoutingDecision,
  type RoutingPolicy
} from "./types.js";

const requestSchema = z
  .object({
    requestId: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
    taskType: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_.-]*$/u),
    privacy: z.enum(PRIVACY_CLASSES),
    requiredContextTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional()
  })
  .strict();

export function resolveRoutingPolicy(partial: Partial<RoutingPolicy> | undefined): RoutingPolicy {
  const policy: RoutingPolicy = {
    ...DEFAULT_ROUTING_POLICY,
    ...partial,
    weights: { ...DEFAULT_ROUTING_POLICY.weights, ...partial?.weights },
    circuit: { ...DEFAULT_ROUTING_POLICY.circuit, ...partial?.circuit }
  };
  const finite = (n: number) => Number.isFinite(n) && n >= 0;
  const ok =
    Number.isInteger(policy.minSamples) &&
    policy.minSamples >= 1 &&
    policy.minAcceptableCorrectness >= 0 &&
    policy.minAcceptableCorrectness <= 1 &&
    finite(policy.weights.correctness) &&
    finite(policy.weights.latency) &&
    finite(policy.weights.cost) &&
    Number.isInteger(policy.circuit.failureThreshold) &&
    policy.circuit.failureThreshold >= 1 &&
    finite(policy.circuit.cooldownMs) &&
    finite(policy.memoryReserveBytes) &&
    Number.isInteger(policy.maxAttempts) &&
    policy.maxAttempts >= 1 &&
    policy.maxAttempts <= 5 &&
    finite(policy.evidenceWindowMs) &&
    policy.evidenceWindowMs > 0;
  if (!ok) throw new ControlStackError("model_routing_policy_invalid", "routing policy is out of bounds");
  return policy;
}

export interface BrokerDeps {
  catalog: readonly CatalogEntry[];
  store: ModelEvidenceStore;
  /** Current provider availability, from discovery. */
  availability(): Promise<ProviderAvailability[]>;
  compute(): Promise<ComputeSnapshot>;
  policy?: Partial<RoutingPolicy>;
  now?: () => Date;
}

export type CallResult<T> =
  | { ok: true; value: T; latencyMs: number; tokensIn?: number; tokensOut?: number; costMicroUsd?: number }
  | { ok: false; failureKind: "provider" | "request"; latencyMs?: number };

export interface AttemptRecord {
  providerId: string;
  model: string;
  ok: boolean;
  failureKind?: "provider" | "request";
  outcomeId: string;
}

export interface ExecutionResult<T> {
  ok: boolean;
  value?: T;
  /** The model that served the request, when ok. */
  served?: { providerId: string; model: string; outcomeId: string };
  attempts: AttemptRecord[];
  /** Why execution stopped without a result. */
  stoppedBecause?: "no_candidates" | "request_failure" | "attempts_exhausted";
}

export class ModelBroker {
  private readonly policy: RoutingPolicy;
  private readonly now: () => Date;

  constructor(private readonly deps: BrokerDeps) {
    this.policy = resolveRoutingPolicy(deps.policy);
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Choose models for a request and record why. Idempotent on `requestId`: a retried request gets the first decision, so
   * routing is not re-evaluated against a host that has since changed and the evidence is not double counted.
   */
  async route(input: RouteRequest): Promise<RoutingDecision> {
    const request = requestSchema.parse(input) as RouteRequest;
    const existing = this.deps.store.findDecision(request.requestId);
    if (existing) return existing;

    const now = this.now();
    const [availability, compute] = await Promise.all([this.deps.availability(), this.deps.compute()]);
    const evidence = new Map<string, { stats: EvidenceStats; circuit: CircuitState }>();
    for (const entry of this.deps.catalog) {
      evidence.set(candidateKey(entry.providerId, entry.model), {
        stats: this.deps.store.stats(entry.providerId, entry.model, request.taskType, this.policy, now),
        circuit: this.deps.store.circuit(entry.providerId, this.policy, now)
      });
    }
    const { mode, ranking, rejected } = rankModels({
      request,
      catalog: this.deps.catalog,
      availability,
      compute,
      evidence,
      policy: this.policy
    });
    return this.deps.store.recordDecision({
      requestId: request.requestId,
      taskType: request.taskType,
      privacy: request.privacy,
      ...(request.requiredContextTokens !== undefined ? { requiredContextTokens: request.requiredContextTokens } : {}),
      mode,
      ranking,
      rejected,
      computeHash: computeHash(compute),
      createdAt: now.toISOString()
    });
  }

  /**
   * Run `call` against the ranked models, best first, with bounded failover. Failover happens only on a provider failure
   * (unreachable, timeout, 5xx); a request failure (bad request, context overflow) would fail the same way elsewhere and
   * stops the run. Once a provider has failed in this run, its other models are skipped. Every attempt is recorded as
   * evidence whether or not it succeeded, and a thrown error counts as a provider failure.
   *
   * Model generation has no side effect to repeat, which is what makes failover safe. Do not use this to run a call that
   * does have one.
   */
  async execute<T>(
    decision: RoutingDecision,
    call: (target: { providerId: string; model: string }) => Promise<CallResult<T>>
  ): Promise<ExecutionResult<T>> {
    const attempts: AttemptRecord[] = [];
    const failedProviders = new Set<string>();
    if (decision.ranking.length === 0) return { ok: false, attempts, stoppedBecause: "no_candidates" };

    for (const candidate of decision.ranking) {
      if (attempts.length >= this.policy.maxAttempts) break;
      if (failedProviders.has(candidate.providerId)) continue;
      const attempt = this.deps.store.nextAttempt(decision.decisionId);
      const started = this.now().getTime();
      let result: CallResult<T>;
      try {
        result = await call({ providerId: candidate.providerId, model: candidate.model });
      } catch {
        // The error text is not recorded: it can carry request content. Only that the provider failed is evidence.
        result = { ok: false, failureKind: "provider", latencyMs: Math.max(0, this.now().getTime() - started) };
      }
      const outcomeId = this.deps.store.recordOutcome({
        decisionId: decision.decisionId,
        attempt,
        providerId: candidate.providerId,
        model: candidate.model,
        taskType: decision.taskType,
        ok: result.ok,
        ...(result.ok ? {} : { failureKind: result.failureKind }),
        ...(result.latencyMs !== undefined ? { latencyMs: Math.round(result.latencyMs) } : {}),
        ...(result.ok && result.tokensIn !== undefined ? { tokensIn: result.tokensIn } : {}),
        ...(result.ok && result.tokensOut !== undefined ? { tokensOut: result.tokensOut } : {}),
        ...(result.ok && result.costMicroUsd !== undefined ? { costMicroUsd: Math.round(result.costMicroUsd) } : {}),
        recordedAt: this.now().toISOString()
      });
      attempts.push({
        providerId: candidate.providerId,
        model: candidate.model,
        ok: result.ok,
        ...(result.ok ? {} : { failureKind: result.failureKind }),
        outcomeId
      });
      if (result.ok) {
        return {
          ok: true,
          value: result.value,
          served: { providerId: candidate.providerId, model: candidate.model, outcomeId },
          attempts
        };
      }
      if (result.failureKind === "request") return { ok: false, attempts, stoppedBecause: "request_failure" };
      failedProviders.add(candidate.providerId);
    }
    return { ok: false, attempts, stoppedBecause: "attempts_exhausted" };
  }

  /** Independent verdict on a served outcome. Correctness evidence is built only from these. */
  verify(outcomeId: string, passed: boolean, verifier: string): void {
    this.deps.store.recordVerification({ outcomeId, passed, verifier, recordedAt: this.now().toISOString() });
  }
}
