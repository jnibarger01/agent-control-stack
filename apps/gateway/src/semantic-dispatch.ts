import type { WorkItemStore, RegistryAgentDetail, WorkItem } from "@agent-control-stack/work-items";
import {
  NIMBLE_ROUTING_ALGORITHM_VERSION,
  routeActor,
  routeNimbleActor,
  validateNimbleRoutingOptions,
  type ActorRoutingInput,
  type NimbleCandidateResult,
  type NimbleClientOptions,
  type NimbleRoutingStateInput
} from "@agent-control-stack/actor-router";
import type { PolicyEngine } from "@agent-control-stack/policy-gate";

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const DEFAULT_MAX_ACTIVE_ASSIGNMENTS_PER_WORKER = 1;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface NimbleDispatchOptions extends NimbleClientOptions {
  enabled?: boolean;
  agentWorkerBindings?: Readonly<Record<string, string>>;
  heartbeatTtlMs?: number;
  maxActiveAssignmentsPerWorker?: number;
}

export interface SemanticDispatchInput {
  store: WorkItemStore;
  policy: PolicyEngine;
  workItem: WorkItem;
  actorId: string;
  correlationId: string;
  options: NimbleDispatchOptions;
  isWorkerDispatchable: (workerId: string, now: Date) => boolean;
}

export interface SemanticDispatchResult {
  state:
    | "SELECTED"
    | "NO_SEMANTIC_MATCH"
    | "NO_ELIGIBLE_CANDIDATES"
    | "CANDIDATE_LIMIT_EXCEEDED"
    | "MODEL_TIMEOUT"
    | "MODEL_UNAVAILABLE"
    | "MODEL_INVALID_RESPONSE"
    | "REQUEST_TOO_LARGE"
    | "ROUTING_ALREADY_FINALIZED"
    | "ROUTING_DISABLED"
    | "ELIGIBILITY_CHANGED"
    | "ASSIGNMENT_FAILED";
  workItemId: string;
  selectedAgentId?: string;
  selectedWorkerId?: string;
  routingDecisionId?: string;
  failureReason?: string;
  excluded?: Record<string, string[]>;
  candidates?: NimbleCandidateResult[];
}

export function parseAgentWorkerBindings(raw: string | undefined): Readonly<Record<string, string>> {
  if (raw === undefined || raw.trim() === "") return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("ACS_AGENT_WORKER_BINDINGS must be a JSON object mapping agent IDs to worker IDs");
  }
  if (!isRecord(value)) {
    throw new Error("ACS_AGENT_WORKER_BINDINGS must be a JSON object mapping agent IDs to worker IDs");
  }
  const bindings: Record<string, string> = {};
  for (const [agentId, workerId] of Object.entries(value)) {
    if (!identifierPattern.test(agentId) || typeof workerId !== "string" || !identifierPattern.test(workerId)) {
      throw new Error("ACS_AGENT_WORKER_BINDINGS contains an invalid agent or worker ID");
    }
    bindings[agentId] = workerId;
  }
  return Object.freeze(bindings);
}

export function nimbleDispatchOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): NimbleDispatchOptions {
  const threshold = numberEnv(env.ACS_NIMBLE_ROUTING_THRESHOLD, "ACS_NIMBLE_ROUTING_THRESHOLD");
  const timeoutMs = numberEnv(env.ACS_NIMBLE_ROUTING_TIMEOUT_MS, "ACS_NIMBLE_ROUTING_TIMEOUT_MS");
  const maxCandidates = numberEnv(env.ACS_NIMBLE_ROUTING_MAX_CANDIDATES, "ACS_NIMBLE_ROUTING_MAX_CANDIDATES");
  const concurrency = numberEnv(env.ACS_NIMBLE_ROUTING_CONCURRENCY, "ACS_NIMBLE_ROUTING_CONCURRENCY");
  const maxActiveAssignmentsPerWorker = numberEnv(
    env.ACS_NIMBLE_MAX_ACTIVE_ASSIGNMENTS_PER_WORKER,
    "ACS_NIMBLE_MAX_ACTIVE_ASSIGNMENTS_PER_WORKER"
  );
  const options: NimbleDispatchOptions = {
    enabled: env.ACS_NIMBLE_ROUTING_ENABLED === "1",
    ...(env.ACS_NIMBLE_URL?.trim() ? { url: env.ACS_NIMBLE_URL.trim() } : {}),
    ...(env.ACS_NIMBLE_MODEL?.trim() ? { model: env.ACS_NIMBLE_MODEL.trim() } : {}),
    ...(env.ACS_NIMBLE_MODEL_VERSION?.trim() ? { modelVersion: env.ACS_NIMBLE_MODEL_VERSION.trim() } : {}),
    ...(threshold === undefined ? {} : { threshold }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(maxCandidates === undefined ? {} : { maxCandidates }),
    ...(concurrency === undefined ? {} : { concurrency }),
    ...(maxActiveAssignmentsPerWorker === undefined ? {} : { maxActiveAssignmentsPerWorker }),
    agentWorkerBindings: parseAgentWorkerBindings(env.ACS_AGENT_WORKER_BINDINGS)
  };
  validateNimbleRoutingOptions(options);
  const maxAssignments = options.maxActiveAssignmentsPerWorker ?? DEFAULT_MAX_ACTIVE_ASSIGNMENTS_PER_WORKER;
  if (!Number.isInteger(maxAssignments) || maxAssignments < 1 || maxAssignments > 32) {
    throw new Error("ACS_NIMBLE_MAX_ACTIVE_ASSIGNMENTS_PER_WORKER must be an integer between 1 and 32");
  }
  return options;
}

export async function dispatchApprovedWorkItem(input: SemanticDispatchInput): Promise<SemanticDispatchResult> {
  const { store, policy, workItem, actorId, correlationId, options } = input;
  if (options.enabled !== true) return { state: "ROUTING_DISABLED", workItemId: workItem.id };
  if (workItem.status !== "approved") throw new Error("only approved work items can be routed");
  const previousAssignment = store.getWorkItemAssignment(workItem.id);
  if (previousAssignment) return finalizedResult(workItem.id, previousAssignment);

  const config = validateNimbleRoutingOptions(options);
  const now = new Date();
  const agents = store.listRegistryAgents();
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const bindings = options.agentWorkerBindings ?? {};
  const maxActiveAssignments = options.maxActiveAssignmentsPerWorker ?? DEFAULT_MAX_ACTIVE_ASSIGNMENTS_PER_WORKER;
  const targetAgentIds = (workItem.target.services ?? []).filter((serviceId) => byId.has(serviceId));
  const requestedCapabilities = [...new Set(workItem.requestedActions.map((action) => action.kind))].sort();
  const policyEligible = (agent: RegistryAgentDetail): boolean => {
    const workerId = bindings[agent.id];
    if (!workerId) return false;
    return policy.summarize(policy.evaluateWorkItem(workItem, workerId, "claim")).decision === "allow";
  };
  const eligibilityReasons = (agent: RegistryAgentDetail): string[] => {
    const reasons: string[] = [];
    const workerId = bindings[agent.id];
    if (!workerId) reasons.push("missing worker binding");
    else {
      if (!input.isWorkerDispatchable(workerId, now)) reasons.push("worker identity unavailable");
      if (store.countActiveAssignmentsForWorker(workerId) >= maxActiveAssignments) {
        reasons.push("worker assignment capacity exhausted");
      }
    }
    if (targetAgentIds.length > 0 && !targetAgentIds.includes(agent.id)) reasons.push("target agent mismatch");
    return reasons;
  };
  const freeCapacity: Record<string, number> = {};
  for (const agent of agents) {
    const workerId = bindings[agent.id];
    freeCapacity[agent.id] =
      workerId &&
      input.isWorkerDispatchable(workerId, now) &&
      store.countActiveAssignmentsForWorker(workerId) < maxActiveAssignments
        ? 1
        : 0;
  }
  const actorInput: ActorRoutingInput = {
    requiredCapabilities: requestedCapabilities,
    taskType: workItem.requestedActions[0]?.kind,
    now,
    heartbeatTtlMs: options.heartbeatTtlMs,
    freeCapacity,
    policyEligible,
    eligibilityReasons
  };
  store.recordSystemEvent({
    name: "agent.routing.started",
    body: {
      workItemId: workItem.id,
      model: config.model,
      modelVersion: config.modelVersion,
      threshold: config.threshold
    },
    attributes: {
      "work_item.id": workItem.id,
      "routing.model": config.model,
      "routing.model_version": config.modelVersion,
      "routing.threshold": config.threshold,
      "correlation.id": correlationId
    }
  });

  const route = await routeNimbleActor(
    {
      ...actorInput,
      agents,
      stateForAgent: (agent) => routingState(workItem, agent),
      onEligibility: (eligibleAgentIds, excluded) => {
        for (const agent of agents) {
          const reasons = excluded[agent.id];
          if (reasons) {
            store.recordSystemEvent({
              name: "agent.routing.candidate_excluded",
              body: { workItemId: workItem.id, agentId: agent.id, reasons },
              attributes: {
                "work_item.id": workItem.id,
                "agent.id": agent.id,
                "routing.exclusion_reasons": reasons.join(",").slice(0, 512),
                "correlation.id": correlationId
              }
            });
          } else if (eligibleAgentIds.includes(agent.id)) {
            store.recordSystemEvent({
              name: "agent.routing.candidate_eligible",
              body: { workItemId: workItem.id, agentId: agent.id },
              attributes: { "work_item.id": workItem.id, "agent.id": agent.id, "correlation.id": correlationId }
            });
          }
        }
      },
      onCandidate: (candidate) => recordCandidateEvaluation(store, workItem.id, correlationId, config, candidate)
    },
    options
  );

  if (route.state !== "SELECTED" || !route.selectedAgentId) {
    const eventName = route.state === "NO_SEMANTIC_MATCH" ? "agent.routing.no_match" : "agent.routing.degraded";
    store.recordSystemEvent({
      name: eventName,
      body: { workItemId: workItem.id, state: route.state, correlationId },
      attributes: { "work_item.id": workItem.id, "routing.state": route.state, "correlation.id": correlationId }
    });
    return {
      state: route.state,
      workItemId: workItem.id,
      excluded: route.decision.excluded,
      candidates: route.candidates
    };
  }

  const selectedAgentId = route.selectedAgentId;
  const selectedWorkerId = bindings[selectedAgentId];
  if (!selectedWorkerId) return { state: "ELIGIBILITY_CHANGED", workItemId: workItem.id, candidates: route.candidates };
  const selectedCandidate = route.candidates.find(
    (
      candidate
    ): candidate is NimbleCandidateResult & {
      score: number;
      model: string;
      modelVersion: string;
    } =>
      candidate.agentId === selectedAgentId &&
      candidate.score !== undefined &&
      Boolean(candidate.model) &&
      Boolean(candidate.modelVersion)
  );
  if (!selectedCandidate) {
    return { state: "MODEL_INVALID_RESPONSE", workItemId: workItem.id, candidates: route.candidates };
  }
  const candidateScores = Object.fromEntries(
    route.candidates.flatMap((candidate) =>
      candidate.score === undefined ? [] : [[candidate.agentId, candidate.score]]
    )
  );
  try {
    return store.withTransaction(() => {
      const finalized = store.getWorkItemAssignment(workItem.id);
      if (finalized) return finalizedResult(workItem.id, finalized);
      const current = store.get(workItem.id);
      if (!current || current.status !== "approved") {
        throw new Error("work_item_not_assignable");
      }
      const commitTime = new Date();
      const currentAgent = store.getRegistryAgent(selectedAgentId);
      const currentWorkerEligible =
        input.isWorkerDispatchable(selectedWorkerId, commitTime) &&
        store.countActiveAssignmentsForWorker(selectedWorkerId) < maxActiveAssignments;
      const currentEligibility = routeActor(store.listRegistryAgents(), {
        ...actorInput,
        now: commitTime,
        freeCapacity: {
          ...freeCapacity,
          [selectedAgentId]: currentWorkerEligible ? 1 : 0
        }
      });
      if (!currentAgent || !currentEligibility.eligible.includes(selectedAgentId)) {
        return { state: "ELIGIBILITY_CHANGED", workItemId: workItem.id, candidates: route.candidates };
      }
      const persisted = store.recordActorRoutingDecision(
        {
          workItemId: workItem.id,
          selectedActorId: selectedAgentId,
          eligible: route.decision.eligible,
          excluded: route.decision.excluded,
          scores: route.decision.scores,
          idempotencyKey: `nimble-route:${workItem.id}:1`,
          now: commitTime
        },
        { via: "domain_service", actorId }
      );
      if (persisted.selectedActorId !== selectedAgentId) throw new Error("routing_decision_conflict");
      store.assignWorkItem(
        {
          workItemId: workItem.id,
          selectedAgentId,
          selectedWorkerId,
          routingDecisionId: persisted.decisionId,
          assignedByActorId: actorId,
          now: commitTime
        },
        { via: "domain_service", actorId }
      );
      store.recordNimbleRoutingDecisionDetails(
        {
          routingDecisionId: persisted.decisionId,
          workItemId: workItem.id,
          routingGeneration: 1,
          selectedAgentId,
          selectedWorkerId,
          candidateScores,
          eligibleAgentIds: route.decision.eligible,
          excluded: route.decision.excluded,
          modelId: selectedCandidate.model,
          modelVersion: selectedCandidate.modelVersion,
          selectedScore: selectedCandidate.score,
          threshold: config.threshold,
          evaluatedAt: commitTime.toISOString(),
          algorithmVersion: NIMBLE_ROUTING_ALGORITHM_VERSION,
          correlationId
        },
        { via: "domain_service", actorId }
      );
      return {
        state: "SELECTED",
        workItemId: workItem.id,
        selectedAgentId,
        selectedWorkerId,
        routingDecisionId: persisted.decisionId
      };
    });
  } catch (error) {
    store.recordSystemEvent({
      name: "agent.routing.assignment_failed",
      body: { workItemId: workItem.id, agentId: selectedAgentId, reason: safeFailureCode(error), correlationId },
      attributes: {
        "work_item.id": workItem.id,
        "agent.id": selectedAgentId,
        "routing.failure_reason": safeFailureCode(error),
        "correlation.id": correlationId
      }
    });
    return {
      state: "ASSIGNMENT_FAILED",
      workItemId: workItem.id,
      selectedAgentId,
      selectedWorkerId,
      failureReason: safeFailureCode(error),
      candidates: route.candidates
    };
  }
}

function recordCandidateEvaluation(
  store: WorkItemStore,
  workItemId: string,
  correlationId: string,
  config: ReturnType<typeof validateNimbleRoutingOptions>,
  candidate: NimbleCandidateResult
): void {
  store.recordSystemEvent({
    name: "agent.routing.candidate_evaluated",
    body: {
      workItemId,
      agentId: candidate.agentId,
      model: candidate.model ?? config.model,
      modelVersion: candidate.modelVersion ?? config.modelVersion,
      ...(candidate.score === undefined ? {} : { score: candidate.score }),
      threshold: config.threshold,
      match: candidate.status,
      latencyMs: Math.round(candidate.latencyMs),
      ...(candidate.failureReason ? { failureReason: candidate.failureReason } : {}),
      correlationId
    },
    attributes: {
      "work_item.id": workItemId,
      "agent.id": candidate.agentId,
      "routing.model": candidate.model ?? config.model,
      "routing.model_version": candidate.modelVersion ?? config.modelVersion,
      ...(candidate.score === undefined ? {} : { "routing.score": candidate.score }),
      "routing.threshold": config.threshold,
      "routing.match": candidate.status,
      "routing.latency_ms": Math.round(candidate.latencyMs),
      ...(candidate.failureReason ? { "routing.failure_reason": candidate.failureReason } : {}),
      "correlation.id": correlationId
    }
  });
}

function routingState(workItem: WorkItem, agent: RegistryAgentDetail): NimbleRoutingStateInput {
  const actions = workItem.requestedActions;
  return {
    title: workItem.title,
    intent: workItem.intent,
    requestedActionKinds: actions.map((action) => action.kind).slice(0, 16),
    requestedActionDescriptions: actions.map((action) => action.description).slice(0, 16),
    targetServices: (workItem.target.services ?? []).slice(0, 16),
    targetRepositories: workItem.target.repo ? [workItem.target.repo] : [],
    candidateAgentId: agent.id,
    candidateRole: agent.acpRole,
    candidateDescription: `${agent.name} (${agent.kind}); ${agent.capabilities
      .map((capability) => capability.description ?? capability.name)
      .slice(0, 16)
      .join("; ")}`,
    candidateCapabilities: agent.capabilities
      .map((capability) => capability.name)
      .sort()
      .slice(0, 32)
  };
}

function finalizedResult(
  workItemId: string,
  assignment: NonNullable<ReturnType<WorkItemStore["getWorkItemAssignment"]>>
): SemanticDispatchResult {
  return {
    state: "ROUTING_ALREADY_FINALIZED",
    workItemId,
    selectedAgentId: assignment.selectedAgentId,
    selectedWorkerId: assignment.selectedWorkerId,
    routingDecisionId: assignment.routingDecisionId
  };
}

function numberEnv(raw: string | undefined, key: string): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw.trim());
  if (!Number.isFinite(value)) throw new Error(`${key} must be a finite number`);
  return value;
}

function safeFailureCode(error: unknown): string {
  if (error instanceof Error && /^[a-z0-9_:-]{1,64}$/iu.test(error.message)) return error.message;
  return "assignment_failed";
}
