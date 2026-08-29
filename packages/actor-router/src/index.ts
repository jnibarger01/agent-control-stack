import type { ActorRoutingDecision as PersistedActorRoutingDecision, PrivilegedTransitionOptions, RecordActorRoutingDecisionInput, RegistryAgentDetail } from "@agent-control-stack/work-items";

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

export interface ActorRoutingPersistence {
  recordActorRoutingDecision(input: RecordActorRoutingDecisionInput, options: PrivilegedTransitionOptions): PersistedActorRoutingDecision;
}

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
    if (input.taskType && (agent.kind === input.taskType || agent.capabilities.some((capability) => capability.name === input.taskType))) {
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
  input: ActorRoutingInput & { workItemId: string; idempotencyKey: string; attemptId?: string },
  persistence: ActorRoutingPersistence,
  options: PrivilegedTransitionOptions
): { decision: ActorRoutingDecision; persisted: PersistedActorRoutingDecision } {
  const decision = routeActor(agents, input);
  const persisted = persistence.recordActorRoutingDecision({
    workItemId: input.workItemId,
    ...(input.attemptId ? { attemptId: input.attemptId } : {}),
    ...(decision.selected ? { selectedActorId: decision.selected } : {}),
    eligible: decision.eligible,
    excluded: decision.excluded,
    scores: decision.scores,
    idempotencyKey: input.idempotencyKey
  }, options);
  return { decision, persisted };
}
