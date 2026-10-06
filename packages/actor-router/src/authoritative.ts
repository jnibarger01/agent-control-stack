import type { RegistryAgentDetail } from "@agent-control-stack/work-items";
import type {
  AuthoritativeRoutingEvidence,
  PrivilegedTransitionOptions,
  RecordAuthoritativeRoutingEvidenceInput,
  RecordRoutingExecutionOutcomeInput,
  RoutingExecutionOutcome,
  WorkItemRoutingSnapshot
} from "@agent-control-stack/work-items";
import { askNimbleToChooseExecutor, type NimbleChoiceResult } from "./nimble-client.js";
import { NIMBLE_PROMPT_VERSION, NIMBLE_ROUTER_VERSION, type NimbleRoutingConfig } from "./nimble-config.js";
import { routeActor, type ActorRoutingInput } from "./index.js";
import { startRouteShadow, type RouteShadowOptions } from "./route-shadow.js";

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "blocked", "cancelled", "rejected", "quarantined"]);
// TypeSafe Choice rejects criteria outside 2–26 options. One eligible executor is already decided.
const MIN_NIMBLE_CANDIDATES = 2;
const MAX_CANDIDATES = 26;

export interface AuthoritativeRoutingPort {
  getWorkItemRoutingSnapshot(workItemId: string): WorkItemRoutingSnapshot | undefined;
  recordAuthoritativeRoutingEvidence(
    input: RecordAuthoritativeRoutingEvidenceInput,
    options: PrivilegedTransitionOptions
  ): AuthoritativeRoutingEvidence;
  getLatestAuthoritativeRoutingEvidence(workItemId: string): AuthoritativeRoutingEvidence | undefined;
  listAuthoritativeRoutingEvidence(workItemId: string): AuthoritativeRoutingEvidence[];
  recordRoutingExecutionOutcome(
    input: RecordRoutingExecutionOutcomeInput,
    options: PrivilegedTransitionOptions
  ): RoutingExecutionOutcome;
  listRoutingExecutionOutcomes(decisionId: string): RoutingExecutionOutcome[];
}

export interface AuthoritativeRoutingContext {
  missionId?: string;
  workItemId: string;
  operationType: string;
  requiredCapabilities: string[];
  lane?: "jc" | "dc";
  priority?: string;
  retryCount?: number;
  previousAttemptId?: string;
  requiredRole?: string;
  taskType?: string;
  now?: Date;
  heartbeatTtlMs?: number;
  freeCapacity?: Record<string, number>;
  successRate?: Record<string, number>;
  estimatedCost?: Record<string, number>;
  recentFailures?: Set<string>;
  sameTaskFailures?: Set<string>;
  policyEligible?: (agent: RegistryAgentDetail) => boolean;
  executionModeAllowed?: (agent: RegistryAgentDetail) => boolean;
  operatorRestricted?: ReadonlySet<string>;
  unhealthy?: ReadonlySet<string>;
}

export interface AuthoritativeRouteResult {
  decision: "route" | "fallback" | "reject";
  executorId?: string;
  model?: string;
  lane?: "jc" | "dc";
  confidence?: number;
  reasonCode: string;
  fallbackReason?: string;
  decisionId: string;
  source: "nimble" | "deterministic_fallback";
  disposition: "fresh" | "resumed" | "completed" | "reconcile" | "replacement";
  evidence?: AuthoritativeRoutingEvidence;
}

export interface DecideAuthoritativeRouteOptions {
  agents: RegistryAgentDetail[];
  context: AuthoritativeRoutingContext;
  config: NimbleRoutingConfig;
  store: AuthoritativeRoutingPort;
  transition: PrivilegedTransitionOptions;
  fetchImpl?: typeof fetch;
  /** ADR 0025 shadow stage. Observed after the decision is persisted; never read back by the decision. */
  routeShadow?: RouteShadowOptions;
}

/**
 * One routing decision for an approved operation.
 * Hard eligibility is applied before Nimble is called. A valid Nimble choice is the route.
 */
export async function decideAuthoritativeRoute(
  options: DecideAuthoritativeRouteOptions
): Promise<AuthoritativeRouteResult> {
  const result = await decideRoute(options);
  if (options.routeShadow) launchShadow(options, result);
  return result;
}

/**
 * Shadow only fresh or replacement decisions that selected an executor from two or more candidates.
 * Replays, rejects and sole-candidate decisions are never shadowed, so a resume does not re-query a model.
 */
function launchShadow(options: DecideAuthoritativeRouteOptions, result: AuthoritativeRouteResult): void {
  try {
    const shadow = options.routeShadow;
    const evidence = result.evidence;
    if (!shadow || !evidence) return;
    if (result.disposition !== "fresh" && result.disposition !== "replacement") return;
    if (result.decision === "reject" || !result.executorId) return;
    const byId = new Map(options.agents.map((agent) => [agent.id, agent]));
    const candidates = evidence.candidates.flatMap((id) => {
      const agent = byId.get(id);
      if (!agent) return [];
      return [
        {
          id: agent.id,
          ...(agent.acpRole ? { role: agent.acpRole } : {}),
          ...(agent.kind ? { kind: agent.kind } : {}),
          capabilities: agent.capabilities.map((capability) => capability.name)
        }
      ];
    });
    if (candidates.length < MIN_NIMBLE_CANDIDATES) return;
    startRouteShadow(shadow, {
      decisionId: result.decisionId,
      workItemId: options.context.workItemId,
      ...(options.context.missionId ? { missionId: options.context.missionId } : {}),
      operationType: options.context.operationType,
      requiredCapabilities: [...options.context.requiredCapabilities],
      ...(options.context.lane ? { lane: options.context.lane } : {}),
      authoritative: { executorId: result.executorId, source: result.source },
      candidates
    });
  } catch {
    // The shadow stage can never fail a route.
  }
}

async function decideRoute(options: DecideAuthoritativeRouteOptions): Promise<AuthoritativeRouteResult> {
  const { context, store } = options;
  const snapshot = store.getWorkItemRoutingSnapshot(context.workItemId);
  if (!snapshot) {
    throw new Error(`work item ${context.workItemId} does not exist`);
  }
  const latest = store.getLatestAuthoritativeRoutingEvidence(context.workItemId);
  if (snapshot.hasExecutionResult || TERMINAL_STATUSES.has(snapshot.status)) {
    return replay(latest, "completed", "already_completed");
  }
  if (snapshot.activeAttempt || snapshot.status === "running" || snapshot.status === "cancelling") {
    return replay(latest, "reconcile", "reconcile_required");
  }
  if (snapshot.status !== "approved") {
    if (latest?.reasonCode === "not_ready" && latest.decision === "reject") {
      return replay(latest, "resumed", latest.reasonCode);
    }
    return persist(options, {
      decision: "reject",
      source: "deterministic_fallback",
      reasonCode: "not_ready",
      eligibleAgents: [],
      excluded: {},
      scores: {},
      normalized: { status: snapshot.status },
      disposition: "fresh"
    });
  }

  const filtered = applyHardConstraints(options.agents, context);
  const eligibility = routeActor(filtered.agents, routingInput(context));
  const excluded = { ...filtered.excluded, ...eligibility.excluded };
  const eligibleAgents = filtered.agents.filter((agent) => eligibility.eligible.includes(agent.id));

  if (
    latest &&
    (latest.decision === "route" || latest.decision === "fallback") &&
    latest.selectedActorId &&
    eligibility.eligible.includes(latest.selectedActorId)
  ) {
    return replay(latest, "resumed", latest.reasonCode);
  }

  let invalidated = latest?.decision === "reject" && latest.reasonCode === "candidate_invalidated";
  if (latest && (latest.decision === "route" || latest.decision === "fallback") && latest.selectedActorId) {
    persist(options, {
      decision: "reject",
      source: "deterministic_fallback",
      reasonCode: "candidate_invalidated",
      eligibleAgents,
      excluded,
      scores: eligibility.scores,
      supersedesDecisionId: latest.decisionId,
      normalized: { invalidatedExecutorId: latest.selectedActorId },
      disposition: "fresh"
    });
    invalidated = true;
  } else if (latest?.decision === "reject" && latest.reasonCode === "low_confidence") {
    return replay(latest, "resumed", latest.reasonCode);
  } else if (
    latest?.decision === "reject" &&
    latest.reasonCode === "no_eligible_candidate" &&
    eligibleAgents.length === 0
  ) {
    return replay(latest, "resumed", latest.reasonCode);
  }
  const disposition = invalidated ? "replacement" : "fresh";

  if (eligibleAgents.length === 0) {
    return persist(options, {
      decision: "reject",
      source: "deterministic_fallback",
      reasonCode: "no_eligible_candidate",
      eligibleAgents,
      excluded,
      scores: eligibility.scores,
      normalized: { eligible: [] },
      disposition
    });
  }
  if (eligibleAgents.length < MIN_NIMBLE_CANDIDATES) {
    return fallback(options, eligibleAgents, excluded, eligibility.scores, "sole_eligible_candidate", {}, disposition);
  }
  if (eligibleAgents.length > MAX_CANDIDATES) {
    return fallback(options, eligibleAgents, excluded, eligibility.scores, "candidate_set_too_large", {}, disposition);
  }

  const nimble = await askNimbleToChooseExecutor(
    {
      ...(context.missionId ? { missionId: context.missionId } : {}),
      workItemId: context.workItemId,
      operationType: context.operationType,
      requiredCapabilities: context.requiredCapabilities,
      ...(context.lane ? { lane: context.lane } : {}),
      ...(context.priority ? { priority: context.priority } : {}),
      retryCount: context.retryCount ?? 0,
      candidates: eligibleAgents.map((agent) => ({
        id: agent.id,
        role: agent.acpRole,
        kind: agent.kind,
        ...(agent.model ? { model: agent.model } : {}),
        capabilities: agent.capabilities.map((capability) => capability.name)
      }))
    },
    options.config,
    options.fetchImpl
  );

  const accepted = acceptNimbleChoice(nimble, eligibleAgents, options.config);
  if (accepted.kind === "route") {
    const agent = eligibleAgents.find((candidate) => candidate.id === accepted.executorId)!;
    return persist(options, {
      decision: "route",
      source: "nimble",
      reasonCode: "nimble_choice",
      executorId: agent.id,
      model: nimble.ok ? nimble.model : agent.model,
      confidence: accepted.confidence,
      eligibleAgents,
      excluded,
      scores: eligibility.scores,
      normalized: publicNimble(nimble),
      disposition
    });
  }
  if (accepted.kind === "reject") {
    return persist(options, {
      decision: "reject",
      source: "nimble",
      reasonCode: accepted.reason,
      executorId: undefined,
      confidence: accepted.confidence,
      eligibleAgents,
      excluded,
      scores: eligibility.scores,
      normalized: publicNimble(nimble),
      disposition: "fresh"
    });
  }
  return fallback(
    options,
    eligibleAgents,
    excluded,
    eligibility.scores,
    accepted.reason,
    publicNimble(nimble),
    disposition
  );
}

export function recordAuthoritativeOutcome(
  store: AuthoritativeRoutingPort,
  input: RecordRoutingExecutionOutcomeInput,
  transition: PrivilegedTransitionOptions
): RoutingExecutionOutcome {
  return store.recordRoutingExecutionOutcome(input, transition);
}

function acceptNimbleChoice(
  result: NimbleChoiceResult,
  eligibleAgents: RegistryAgentDetail[],
  config: NimbleRoutingConfig
):
  | { kind: "route"; executorId: string; confidence: number }
  | { kind: "fallback" | "reject"; reason: string; confidence?: number } {
  if (!result.ok) {
    if (result.reason === "low_confidence" && config.lowConfidencePolicy === "reject") {
      return {
        kind: "reject",
        reason: "low_confidence",
        ...(result.confidence !== undefined ? { confidence: result.confidence } : {})
      };
    }
    return {
      kind: "fallback",
      reason: result.reason,
      ...(result.confidence !== undefined ? { confidence: result.confidence } : {})
    };
  }
  const stillEligible = eligibleAgents.some((agent) => agent.id === result.executorId);
  if (!stillEligible) return { kind: "fallback", reason: "unknown_executor", confidence: result.confidence };
  return { kind: "route", executorId: result.executorId, confidence: result.confidence };
}

function fallback(
  options: DecideAuthoritativeRouteOptions,
  eligibleAgents: RegistryAgentDetail[],
  excluded: Record<string, string[]>,
  scores: Record<string, number>,
  reason: string,
  normalized: Record<string, unknown> = {},
  disposition: AuthoritativeRouteResult["disposition"] = "fresh"
): AuthoritativeRouteResult {
  if (options.config.fallbackMode !== "deterministic_score") {
    throw new Error(`unsupported Nimble fallback mode ${options.config.fallbackMode}`);
  }
  const selected = routeActor(eligibleAgents, routingInput(options.context)).selected;
  if (!selected) {
    return persist(options, {
      decision: "reject",
      source: "deterministic_fallback",
      reasonCode: "no_eligible_candidate",
      eligibleAgents,
      excluded,
      scores,
      normalized,
      disposition: "fresh"
    });
  }
  const agent = eligibleAgents.find((candidate) => candidate.id === selected);
  return persist(options, {
    decision: "fallback",
    source: "deterministic_fallback",
    reasonCode: "deterministic_fallback",
    fallbackReason: reason,
    executorId: selected,
    ...(agent?.model ? { model: agent.model } : {}),
    eligibleAgents,
    excluded,
    scores,
    normalized: { ...normalized, fallbackReason: reason, fallbackMode: options.config.fallbackMode },
    disposition
  });
}

function persist(
  options: DecideAuthoritativeRouteOptions,
  input: {
    decision: "route" | "fallback" | "reject";
    source: "nimble" | "deterministic_fallback";
    reasonCode: string;
    fallbackReason?: string;
    executorId?: string;
    model?: string;
    confidence?: number;
    eligibleAgents: RegistryAgentDetail[];
    excluded: Record<string, string[]>;
    scores: Record<string, number>;
    normalized: Record<string, unknown>;
    supersedesDecisionId?: string;
    disposition: AuthoritativeRouteResult["disposition"];
  }
): AuthoritativeRouteResult {
  const evidence = options.store.recordAuthoritativeRoutingEvidence(
    {
      workItemId: options.context.workItemId,
      ...(options.context.missionId ? { missionId: options.context.missionId } : {}),
      operationId: options.context.workItemId,
      ...(options.context.previousAttemptId ? { attemptId: options.context.previousAttemptId } : {}),
      ...(input.executorId ? { selectedActorId: input.executorId } : {}),
      decision: input.decision,
      source: input.source,
      reasonCode: input.reasonCode,
      ...(input.fallbackReason ? { fallbackReason: input.fallbackReason } : {}),
      ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(options.context.lane ? { lane: options.context.lane } : {}),
      routerVersion: NIMBLE_ROUTER_VERSION,
      promptVersion: NIMBLE_PROMPT_VERSION,
      eligible: input.eligibleAgents.map((agent) => agent.id),
      excluded: input.excluded,
      scores: input.scores,
      candidates: input.eligibleAgents.map((agent) => agent.id),
      constraints: {
        requiredCapabilities: options.context.requiredCapabilities,
        requiredRole: options.context.requiredRole ?? null,
        lane: options.context.lane ?? null,
        operationType: options.context.operationType
      },
      normalizedDecision: input.normalized,
      ...(input.supersedesDecisionId ? { supersedesDecisionId: input.supersedesDecisionId } : {}),
      ...(options.context.now ? { now: options.context.now } : {})
    },
    options.transition
  );
  return {
    decision: evidence.decision,
    ...(evidence.selectedActorId ? { executorId: evidence.selectedActorId } : {}),
    ...(evidence.model ? { model: evidence.model } : {}),
    ...(evidence.lane ? { lane: evidence.lane } : {}),
    ...(evidence.confidence !== undefined ? { confidence: evidence.confidence } : {}),
    reasonCode: evidence.reasonCode,
    ...(evidence.fallbackReason ? { fallbackReason: evidence.fallbackReason } : {}),
    decisionId: evidence.decisionId,
    source: evidence.source,
    disposition: input.disposition,
    evidence
  };
}

function replay(
  latest: AuthoritativeRoutingEvidence | undefined,
  disposition: AuthoritativeRouteResult["disposition"],
  reasonCode: string
): AuthoritativeRouteResult {
  if (!latest) {
    return {
      decision: "reject",
      reasonCode,
      decisionId: "none",
      source: "deterministic_fallback",
      disposition
    };
  }
  return {
    decision: disposition === "completed" || disposition === "reconcile" ? "reject" : latest.decision,
    ...(latest.selectedActorId && disposition !== "completed" && disposition !== "reconcile"
      ? { executorId: latest.selectedActorId }
      : {}),
    ...(latest.model ? { model: latest.model } : {}),
    ...(latest.lane ? { lane: latest.lane } : {}),
    ...(latest.confidence !== undefined ? { confidence: latest.confidence } : {}),
    reasonCode,
    ...(latest.fallbackReason ? { fallbackReason: latest.fallbackReason } : {}),
    decisionId: latest.decisionId,
    source: latest.source,
    disposition,
    evidence: latest
  };
}

function applyHardConstraints(
  agents: RegistryAgentDetail[],
  context: AuthoritativeRoutingContext
): { agents: RegistryAgentDetail[]; excluded: Record<string, string[]> } {
  const excluded: Record<string, string[]> = {};
  const eligible: RegistryAgentDetail[] = [];
  for (const agent of agents) {
    const reasons: string[] = [];
    if (context.policyEligible && !context.policyEligible(agent)) reasons.push("authorization denied");
    if (context.executionModeAllowed && !context.executionModeAllowed(agent)) reasons.push("execution mode restricted");
    if (context.operatorRestricted?.has(agent.id)) reasons.push("operator restriction");
    if (context.unhealthy?.has(agent.id)) reasons.push("unhealthy executor");
    if (reasons.length > 0) excluded[agent.id] = reasons;
    else eligible.push(agent);
  }
  return { agents: eligible, excluded };
}

function routingInput(context: AuthoritativeRoutingContext): ActorRoutingInput {
  return {
    requiredCapabilities: context.requiredCapabilities,
    ...(context.requiredRole ? { requiredRole: context.requiredRole } : {}),
    ...(context.taskType ? { taskType: context.taskType } : {}),
    ...(context.now ? { now: context.now } : {}),
    ...(context.heartbeatTtlMs ? { heartbeatTtlMs: context.heartbeatTtlMs } : {}),
    ...(context.freeCapacity ? { freeCapacity: context.freeCapacity } : {}),
    ...(context.successRate ? { successRate: context.successRate } : {}),
    ...(context.estimatedCost ? { estimatedCost: context.estimatedCost } : {}),
    ...(context.recentFailures ? { recentFailures: context.recentFailures } : {}),
    ...(context.sameTaskFailures ? { sameTaskFailures: context.sameTaskFailures } : {})
  };
}

function publicNimble(result: NimbleChoiceResult): Record<string, unknown> {
  if (result.ok) {
    return {
      executorId: result.executorId,
      confidence: result.confidence,
      model: result.model,
      latencyMs: Math.round(result.latencyMs)
    };
  }
  return {
    failure: result.reason,
    ...(result.executorId ? { executorId: result.executorId } : {}),
    ...(result.confidence !== undefined ? { confidence: result.confidence } : {}),
    ...(result.model ? { model: result.model } : {}),
    latencyMs: Math.round(result.latencyMs)
  };
}
