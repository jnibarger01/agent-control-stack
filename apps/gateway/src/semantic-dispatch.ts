import { createId } from "@agent-control-stack/shared";
import type { WorkItemStore, RegistryAgentDetail, WorkItem } from "@agent-control-stack/work-items";
import {
  routeNimbleActor,
  validateNimbleRoutingOptions,
  type NimbleClientOptions,
  type NimbleRoutingState
} from "@agent-control-stack/actor-router";
import type { PolicyEngine } from "@agent-control-stack/policy-gate";

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface NimbleDispatchOptions extends NimbleClientOptions {
  agentWorkerBindings?: Readonly<Record<string, string>>;
  heartbeatTtlMs?: number;
}

export interface SemanticDispatchInput {
  store: WorkItemStore;
  policy: PolicyEngine;
  workItem: WorkItem;
  actorId: string;
  options: NimbleDispatchOptions;
  isWorkerDispatchable: (workerId: string, now: Date) => boolean;
}

export interface SemanticDispatchResult {
  state:
    "SELECTED" | "NO_SEMANTIC_MATCH" | "DEGRADED" | "NO_ELIGIBLE_AGENTS" | "ASSIGNMENT_FAILED" | "ALREADY_ASSIGNED";
  workItemId: string;
  selectedAgentId?: string;
  selectedWorkerId?: string;
  routingDecisionId?: string;
  failureReason?: string;
  excluded?: Record<string, string[]>;
}

export function parseAgentWorkerBindings(raw: string | undefined): Readonly<Record<string, string>> {
  if (raw === undefined || raw.trim() === "") return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("ACS_AGENT_WORKER_BINDINGS must be a JSON object mapping agent IDs to worker IDs");
  }
  if (!isRecord(value))
    throw new Error("ACS_AGENT_WORKER_BINDINGS must be a JSON object mapping agent IDs to worker IDs");
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
  const thresholdText = env.ACS_NIMBLE_ROUTING_THRESHOLD?.trim();
  const threshold = thresholdText ? Number(thresholdText) : undefined;
  const options: NimbleDispatchOptions = {
    ...(env.ACS_NIMBLE_URL?.trim() ? { url: env.ACS_NIMBLE_URL.trim() } : {}),
    ...(env.ACS_NIMBLE_MODEL?.trim() ? { model: env.ACS_NIMBLE_MODEL.trim() } : {}),
    ...(threshold !== undefined ? { threshold } : {}),
    ...(env.ACS_NIMBLE_ROUTING_TIMEOUT_MS?.trim()
      ? { timeoutMs: Number(env.ACS_NIMBLE_ROUTING_TIMEOUT_MS.trim()) }
      : {}),
    agentWorkerBindings: parseAgentWorkerBindings(env.ACS_AGENT_WORKER_BINDINGS)
  };
  validateNimbleRoutingOptions(options);
  return options;
}

export async function dispatchApprovedWorkItem(input: SemanticDispatchInput): Promise<SemanticDispatchResult> {
  const { store, policy, workItem, actorId, options } = input;
  if (workItem.status !== "approved") {
    throw new Error("only approved work items can be routed");
  }
  const existingAssignment = store.getWorkItemAssignment(workItem.id);
  if (existingAssignment) {
    return {
      state: "ALREADY_ASSIGNED",
      workItemId: workItem.id,
      selectedAgentId: existingAssignment.selectedAgentId,
      selectedWorkerId: existingAssignment.selectedWorkerId,
      routingDecisionId: existingAssignment.routingDecisionId
    };
  }

  const config = validateNimbleRoutingOptions(options);
  const now = new Date();
  store.recordSystemEvent({
    name: "agent.routing.started",
    body: { workItemId: workItem.id, model: config.model, threshold: config.threshold },
    attributes: { "work_item.id": workItem.id, "routing.model": config.model, "routing.threshold": config.threshold }
  });
  const agents = store.listRegistryAgents();
  const bindings = options.agentWorkerBindings ?? {};
  const capacity: Record<string, number> = {};
  for (const [agentId, workerId] of Object.entries(bindings)) {
    // Worker concurrency limits are not modeled in the current claim contract.
    // Actor-router uses positive capacity only as an eligibility signal here.
    capacity[agentId] = input.isWorkerDispatchable(workerId, now) ? 1 : 0;
  }
  const requestedCapabilities = [...new Set(workItem.requestedActions.map((action) => action.kind))].sort();
  const route = await routeNimbleActor(
    {
      agents,
      workItemId: workItem.id,
      idempotencyKey: createId("nimble-route"),
      requiredCapabilities: requestedCapabilities,
      taskType: workItem.requestedActions[0]?.kind,
      now,
      heartbeatTtlMs: options.heartbeatTtlMs,
      freeCapacity: capacity,
      policyEligible: (agent) => {
        const workerId = bindings[agent.id];
        if (!workerId || !input.isWorkerDispatchable(workerId, now)) return false;
        const evaluations = policy.evaluateWorkItem(workItem, workerId, "claim");
        return policy.summarize(evaluations).decision === "allow";
      },
      stateForAgent: (agent) => routingState(workItem, agent),
      onCandidate: (candidate) => {
        store.recordSystemEvent({
          name: "agent.routing.candidate_evaluated",
          body: {
            workItemId: workItem.id,
            agentId: candidate.agentId,
            model: candidate.model ?? config.model,
            ...(candidate.score === undefined ? {} : { score: candidate.score }),
            threshold: config.threshold,
            match: candidate.status,
            latencyMs: candidate.latencyMs,
            ...(candidate.failureReason ? { failureReason: candidate.failureReason } : {})
          },
          attributes: {
            "work_item.id": workItem.id,
            "agent.id": candidate.agentId,
            "routing.model": candidate.model ?? config.model,
            ...(candidate.score === undefined ? {} : { "routing.score": candidate.score }),
            "routing.threshold": config.threshold,
            "routing.match": candidate.status,
            "routing.latency_ms": candidate.latencyMs,
            ...(candidate.failureReason ? { "routing.failure_reason": candidate.failureReason } : {})
          }
        });
      }
    },
    options,
    store,
    { via: "domain_service", actorId }
  );

  if (!route.selectedAgentId || !route.persisted) {
    const eventName =
      route.state === "NO_SEMANTIC_MATCH"
        ? "agent.routing.no_match"
        : route.state === "NO_ELIGIBLE_AGENTS"
          ? "agent.routing.no_eligible_agents"
          : "agent.routing.degraded";
    store.recordSystemEvent({
      name: eventName,
      body: { workItemId: workItem.id, state: route.state, routingDecisionId: route.persisted?.decisionId },
      attributes: {
        "work_item.id": workItem.id,
        "routing.state": route.state,
        ...(route.persisted ? { "routing.decision_id": route.persisted.decisionId } : {})
      }
    });
    return {
      state: route.state,
      workItemId: workItem.id,
      excluded: route.decision.excluded,
      ...(route.persisted ? { routingDecisionId: route.persisted.decisionId } : {})
    };
  }

  const selectedAgentId = route.selectedAgentId;
  const selectedWorkerId = bindings[selectedAgentId];
  if (!selectedWorkerId || !input.isWorkerDispatchable(selectedWorkerId, new Date())) {
    store.recordSystemEvent({
      name: "agent.routing.assignment_failed",
      body: { workItemId: workItem.id, selectedAgentId, reason: "worker_path_unavailable" },
      attributes: {
        "work_item.id": workItem.id,
        "agent.id": selectedAgentId,
        "routing.failure_reason": "worker_path_unavailable"
      }
    });
    return {
      state: "ASSIGNMENT_FAILED",
      workItemId: workItem.id,
      selectedAgentId,
      routingDecisionId: route.persisted.decisionId,
      failureReason: "worker_path_unavailable"
    };
  }

  store.recordSystemEvent({
    name: "agent.routing.selected",
    body: {
      workItemId: workItem.id,
      selectedAgentId,
      selectedWorkerId,
      routingDecisionId: route.persisted.decisionId,
      tieBreakReason: "actor-router deterministic fit score, then stable agent ID"
    },
    attributes: {
      "work_item.id": workItem.id,
      "agent.id": selectedAgentId,
      "worker.id": selectedWorkerId,
      "routing.decision_id": route.persisted.decisionId,
      "routing.tie_break_reason": "actor-router deterministic fit score, then stable agent ID"
    }
  });

  try {
    const assignment = store.withTransaction(() => {
      if (store.getWorkItemAssignment(workItem.id)) throw new Error("work_item_already_assigned");
      const current = store.get(workItem.id);
      if (!current || current.status !== "approved") throw new Error("work_item_not_assignable");
      const persisted = store.getActorRoutingDecision(route.persisted!.decisionId);
      if (!persisted || persisted.selectedActorId !== selectedAgentId || persisted.workItemId !== workItem.id) {
        throw new Error("routing_decision_mismatch");
      }
      return store.assignWorkItem(
        {
          workItemId: workItem.id,
          selectedAgentId,
          selectedWorkerId,
          routingDecisionId: persisted.decisionId,
          assignedByActorId: actorId
        },
        { via: "domain_service", actorId }
      );
    });
    store.recordSystemEvent({
      name: "work_item.worker_assigned",
      body: {
        workItemId: assignment.workItemId,
        selectedAgentId,
        selectedWorkerId,
        routingDecisionId: assignment.routingDecisionId
      },
      attributes: {
        "work_item.id": workItem.id,
        "agent.id": selectedAgentId,
        "worker.id": selectedWorkerId,
        ...(assignment.routingDecisionId ? { "routing.decision_id": assignment.routingDecisionId } : {})
      }
    });
    return {
      state: "SELECTED",
      workItemId: workItem.id,
      selectedAgentId,
      selectedWorkerId,
      routingDecisionId: route.persisted.decisionId
    };
  } catch (error) {
    store.recordSystemEvent({
      name: "agent.routing.assignment_failed",
      body: { workItemId: workItem.id, selectedAgentId, reason: safeFailureCode(error) },
      attributes: {
        "work_item.id": workItem.id,
        "agent.id": selectedAgentId,
        "routing.failure_reason": safeFailureCode(error)
      }
    });
    return {
      state: "ASSIGNMENT_FAILED",
      workItemId: workItem.id,
      selectedAgentId,
      selectedWorkerId,
      routingDecisionId: route.persisted.decisionId,
      failureReason: safeFailureCode(error)
    };
  }
}

function routingState(workItem: WorkItem, agent: RegistryAgentDetail): NimbleRoutingState {
  const actions = workItem.requestedActions;
  const targetService = Array.isArray(workItem.target.services) ? workItem.target.services[0] : undefined;
  return {
    work_item_id: workItem.id,
    title: workItem.title,
    instructions: workItem.intent,
    requested_action_kind: actions.map((action) => action.kind).join(", "),
    requested_action_description: actions.map((action) => action.description).join("; "),
    ...(targetService ? { target_service: targetService } : {}),
    candidate_agent: agent.id,
    candidate_role: agent.acpRole,
    candidate_capabilities: agent.capabilities
      .map((capability) => capability.name)
      .sort()
      .slice(0, 32)
  };
}

function safeFailureCode(error: unknown): string {
  if (error instanceof Error && /^[a-z0-9_:-]{1,64}$/iu.test(error.message)) return error.message;
  return "assignment_failed";
}
