import {
  buildJevTelemetryEvent,
  choice,
  classifyJev,
  formatJevTelemetry,
  isJevEnabled,
  redactJevText,
  type ClassifyJevOptions
} from "@agent-control-stack/jev-advisor";
import type {
  ActorRoutingDecision as PersistedActorRoutingDecision,
  PrivilegedTransitionOptions,
  RecordActorRoutingDecisionInput,
  RegistryAgentDetail
} from "@agent-control-stack/work-items";

export interface ActorRoutingInput {
  requiredCapabilities: string[];
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
}

export interface ActorRoutingCandidate {
  id: string;
  score: number;
  reasons: string[];
}

export interface ActorRoutingDecision {
  selected?: string;
  eligible: string[];
  excluded: Record<string, string[]>;
  scores: Record<string, number>;
  candidates: ActorRoutingCandidate[];
}

export type ActorRoutingShadowObservationInput = {
  workItemId: string;
  routingDecisionId: string;
  deterministicSelectedActorId?: string;
  eligible: string[];
  semanticSelectedActorId?: string;
  semanticConfidence?: number;
  semanticProbabilities: Record<string, number>;
  questionSetVersion: string;
  classifierVersion: string;
  model?: string;
  degraded: boolean;
  failureReason?: string;
  latencyMs: number;
  now?: Date;
};

export interface ActorRoutingPersistence {
  recordActorRoutingDecision(
    input: RecordActorRoutingDecisionInput,
    options: PrivilegedTransitionOptions
  ): PersistedActorRoutingDecision;
  recordActorRoutingShadowObservation?(
    input: ActorRoutingShadowObservationInput,
    options: PrivilegedTransitionOptions
  ): void;
}

export const JEV_ACTOR_ROUTING_QUESTION_SET_VERSION = "jev-actor-routing@1" as const;
const MAX_JEV_ROUTING_CANDIDATES = 16;

export type ActorRoutingJevShadowOptions = ClassifyJevOptions & {
  sink?: (line: string) => void;
};

const DEFAULT_HEARTBEAT_TTL_MS = 120_000;

/** Deterministic, explainable actor selection. It never asks an LLM to route work. */
export function routeActor(agents: RegistryAgentDetail[], input: ActorRoutingInput): ActorRoutingDecision {
  const now = input.now ?? new Date();
  const ttl = input.heartbeatTtlMs ?? DEFAULT_HEARTBEAT_TTL_MS;
  const excluded: Record<string, string[]> = {};
  const candidates: ActorRoutingCandidate[] = [];

  for (const agent of [...agents].sort((left, right) => left.id.localeCompare(right.id))) {
    const reasons: string[] = [];
    const capabilityNames = new Set(agent.capabilities.map((capability) => capability.name));
    for (const capability of input.requiredCapabilities) {
      if (!capabilityNames.has(capability)) reasons.push(`missing capability: ${capability}`);
    }
    if (agent.status !== "AVAILABLE") reasons.push(`availability: ${agent.status}`);
    const heartbeat = agent.latestHeartbeat?.observedAt ?? agent.lastHeartbeatAt;
    if (!heartbeat || now.getTime() - Date.parse(heartbeat) > ttl) reasons.push("stale heartbeat");
    if (input.requiredRole && agent.acpRole !== input.requiredRole) reasons.push("role mismatch");
    if (input.policyEligible && !input.policyEligible(agent)) reasons.push("policy ineligible");
    if (input.freeCapacity && (input.freeCapacity[agent.id] ?? 0) <= 0) reasons.push("no free capacity");
    if (reasons.length) {
      excluded[agent.id] = reasons;
      continue;
    }

    let score = 0;
    const scoreReasons: string[] = [];
    if (input.requiredRole && agent.acpRole === input.requiredRole) {
      score += 40;
      scoreReasons.push("role fit +40");
    }
    if (
      input.taskType &&
      (agent.kind === input.taskType || agent.capabilities.some((capability) => capability.name === input.taskType))
    ) {
      score += 25;
      scoreReasons.push("task specialization +25");
    }
    const rate = input.successRate?.[agent.id];
    if (rate !== undefined) {
      score += Math.round(Math.max(0, Math.min(1, rate)) * 15);
      scoreReasons.push(`historical reliability +${Math.round(Math.max(0, Math.min(1, rate)) * 15)}`);
    }
    if ((input.freeCapacity?.[agent.id] ?? 0) > 0) {
      score += 10;
      scoreReasons.push("free capacity +10");
    }
    const cost = input.estimatedCost?.[agent.id];
    if (cost !== undefined) {
      score += Math.max(0, 5 - Math.min(5, Math.round(cost)));
      scoreReasons.push("estimated cost considered");
    }
    if (input.recentFailures?.has(agent.id)) {
      score -= 20;
      scoreReasons.push("recent failure -20");
    }
    if (input.sameTaskFailures?.has(agent.id)) {
      score -= 30;
      scoreReasons.push("same-task failure -30");
    }
    candidates.push({ id: agent.id, score, reasons: scoreReasons });
  }

  candidates.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  return {
    selected: candidates[0]?.id,
    eligible: candidates.map((candidate) => candidate.id),
    excluded,
    scores: Object.fromEntries(candidates.map((candidate) => [candidate.id, candidate.score])),
    candidates
  };
}

export function routeAndPersistActor(
  agents: RegistryAgentDetail[],
  input: ActorRoutingInput & {
    workItemId: string;
    idempotencyKey: string;
    attemptId?: string;
    jevShadow?: {
      goal: string;
      options?: ActorRoutingJevShadowOptions;
    };
  },
  persistence: ActorRoutingPersistence,
  options: PrivilegedTransitionOptions
): { decision: ActorRoutingDecision; persisted: PersistedActorRoutingDecision } {
  const decision = routeActor(agents, input);
  const persisted = persistence.recordActorRoutingDecision(
    {
      workItemId: input.workItemId,
      ...(input.attemptId ? { attemptId: input.attemptId } : {}),
      ...(decision.selected ? { selectedActorId: decision.selected } : {}),
      eligible: decision.eligible,
      excluded: decision.excluded,
      scores: decision.scores,
      idempotencyKey: input.idempotencyKey
    },
    options
  );

  const recordShadow = persistence.recordActorRoutingShadowObservation;
  if (input.jevShadow && recordShadow) {
    const byId = new Map(agents.map((agent) => [agent.id, agent] as const));
    const candidates = decision.eligible
      .map((actorId) => byId.get(actorId))
      .filter((agent): agent is RegistryAgentDetail => agent !== undefined);
    void observeJevRoutingShadow(input.workItemId, input.jevShadow.goal, candidates, input.jevShadow.options)
      .then((shadow) => {
        if (!shadow) return;
        try {
          recordShadow.call(
            persistence,
            {
              workItemId: input.workItemId,
              routingDecisionId: persisted.decisionId,
              ...(decision.selected ? { deterministicSelectedActorId: decision.selected } : {}),
              eligible: [...decision.eligible],
              ...(shadow.selectedActorId ? { semanticSelectedActorId: shadow.selectedActorId } : {}),
              ...(shadow.confidence !== null ? { semanticConfidence: shadow.confidence } : {}),
              semanticProbabilities: shadow.probabilities,
              questionSetVersion: JEV_ACTOR_ROUTING_QUESTION_SET_VERSION,
              classifierVersion: shadow.classifierVersion,
              ...(shadow.model ? { model: shadow.model } : {}),
              degraded: shadow.degraded,
              ...(shadow.failureReason ? { failureReason: shadow.failureReason } : {}),
              latencyMs: shadow.latencyMs
            },
            options
          );
        } catch {
          // Shadow persistence is observational and never alters routing.
        }
      })
      .catch(() => {
        // JEV routing shadow is fail-open by invariant.
      });
  }

  return { decision, persisted };
}

async function observeJevRoutingShadow(
  workItemId: string,
  goal: string,
  candidates: RegistryAgentDetail[],
  options: ActorRoutingJevShadowOptions = {}
): Promise<{
  selectedActorId: string | null;
  confidence: number | null;
  probabilities: Record<string, number>;
  classifierVersion: string;
  model: string | null;
  degraded: boolean;
  failureReason?: string;
  latencyMs: number;
} | null> {
  if (options.enabled === false) return null;
  if (options.enabled !== true && !isJevEnabled()) return null;
  if (candidates.length === 0 || candidates.length > MAX_JEV_ROUTING_CANDIDATES) return null;

  const ordered = [...candidates].sort((left, right) => left.id.localeCompare(right.id));
  const actorByOpaque: Record<string, string> = {};
  const criteria: Record<
    string,
    {
      kind: string;
      role: string;
      provider: string | null;
      model: string | null;
      capabilities: string[];
    }
  > = {};

  for (let index = 0; index < ordered.length; index += 1) {
    const agent = ordered[index];
    if (!agent) continue;
    const opaqueId = "candidate_" + String(index + 1).padStart(2, "0");
    actorByOpaque[opaqueId] = agent.id;
    criteria[opaqueId] = {
      kind: redactJevText(agent.kind, 96),
      role: redactJevText(agent.acpRole, 96),
      provider: agent.provider ? redactJevText(agent.provider, 96) : null,
      model: agent.model ? redactJevText(agent.model, 128) : null,
      capabilities: [...new Set(agent.capabilities.map((capability) => capability.name))]
        .sort()
        .slice(0, 32)
        .map((name) => redactJevText(name, 96))
    };
  }

  const { sink, ...classifyOptions } = options;
  const result = await classifyJev(
    {
      goal,
      candidates: Object.entries(criteria).map(([opaqueId, descriptor]) => ({
        opaque_id: opaqueId,
        ...descriptor
      }))
    },
    {
      route: choice(
        {
          task: "Select the eligible candidate that is the best semantic fit to execute state.goal.",
          constraints: [
            "Every candidate already passed deterministic ACS policy, capability, availability, and capacity gates.",
            "Choose only one declared candidate.",
            "Do not infer, grant, revoke, or override authority."
          ]
        },
        criteria
      )
    },
    { ...classifyOptions, enabled: true }
  );

  const telemetry = buildJevTelemetryEvent({
    result,
    consumer: "actor-routing-shadow",
    questionSetVersion: JEV_ACTOR_ROUTING_QUESTION_SET_VERSION,
    correlation: { workItemId }
  });
  try {
    (sink ?? ((line: string) => process.stderr.write(line + "\n")))(formatJevTelemetry(telemetry));
  } catch {
    // Telemetry sinks never alter routing.
  }

  const route = result.answers.route;
  const selectedOpaque = route?.type === "choice" ? route.choice : null;
  const probabilities: Record<string, number> = {};
  if (route?.type === "choice") {
    for (const [opaqueId, probability] of Object.entries(route.probabilities)) {
      const actorId = actorByOpaque[opaqueId];
      if (actorId) probabilities[actorId] = probability;
    }
  }

  return {
    selectedActorId: selectedOpaque ? (actorByOpaque[selectedOpaque] ?? null) : null,
    confidence: route?.type === "choice" ? route.confidence : null,
    probabilities,
    classifierVersion: result.classifierVersion,
    model: result.model,
    degraded: result.degraded,
    ...(result.failureReason ? { failureReason: result.failureReason } : {}),
    latencyMs: result.latencyMs
  };
}
