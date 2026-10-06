import {
  decideAuthoritativeRoute,
  recordAuthoritativeOutcome,
  type AuthoritativeRouteResult,
  type NimbleRoutingConfig,
  type RouteShadowOptions
} from "@agent-control-stack/actor-router";
import type { ClaimedWorkItem, RegistryAgentDetail, WorkItem, WorkItemStore } from "@agent-control-stack/work-items";
import { createWorkItemTools } from "./tools.js";
import type { PolicyEngine } from "./policy.js";

const transition = { via: "domain_service" } as const;

export interface AuthoritativeAdmission {
  acquire(input: {
    requestId: string;
    executorId: string;
    lane: "jc" | "dc";
    actorId: string;
  }): Promise<{ release(): void }>;
}

export type AuthoritativeClaim =
  | {
      claimed: true;
      running: ClaimedWorkItem;
      decision: AuthoritativeRouteResult;
      releaseAdmission: () => void;
    }
  | {
      claimed: false;
      reason: string;
      decision?: AuthoritativeRouteResult;
    };

/**
 * Route every approved, dependency-ready work item, then claim only the persisted executor.
 * Admission runs after the routing decision and before claim.
 */
export async function claimNextAuthoritativeWorkItem(options: {
  store: WorkItemStore;
  policy: PolicyEngine;
  workerId: string;
  config: NimbleRoutingConfig;
  admission?: AuthoritativeAdmission;
  /** ADR 0025 shadow stage: observed after each fresh decision, never read back. */
  routeShadow?: RouteShadowOptions;
  fetchImpl?: typeof fetch;
  now?: Date;
  leaseMs?: number;
}): Promise<AuthoritativeClaim> {
  const items = options.store
    .list({ status: "approved" })
    .slice()
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  const agents = options.store.listRegistryAgents();
  let sawForeignRoute = false;
  for (const item of items) {
    const decision = await decideAuthoritativeRoute({
      agents,
      context: contextFor(options.store, item, agents, options),
      config: options.config,
      store: options.store,
      transition,
      ...(options.routeShadow ? { routeShadow: options.routeShadow } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {})
    });
    if (
      decision.disposition === "completed" ||
      decision.disposition === "reconcile" ||
      decision.decision === "reject"
    ) {
      continue;
    }
    if (!decision.executorId || decision.executorId !== options.workerId) {
      sawForeignRoute = true;
      continue;
    }
    let release: () => void = () => undefined;
    if (options.admission) {
      try {
        const permit = await options.admission.acquire({
          requestId: `${decision.decisionId}:${item.id}`,
          executorId: decision.executorId,
          lane: decision.lane ?? "dc",
          actorId: options.workerId
        });
        release = () => permit.release();
      } catch (error) {
        if (error instanceof Error && error.name === "AdmissionError") {
          return { claimed: false, reason: "admission_blocked", decision };
        }
        throw error;
      }
    }
    const tools = createWorkItemTools(options.store, options.policy);
    const running = tools.claim_approved_work_item_by_id({
      id: item.id,
      workerId: options.workerId,
      ...(options.leaseMs ? { leaseMs: options.leaseMs } : {})
    });
    if (!running || running.status !== "running" || running.workerId !== decision.executorId) {
      release();
      return { claimed: false, reason: "authorization_blocked", decision };
    }
    return { claimed: true, running, decision, releaseAdmission: release };
  }
  return { claimed: false, reason: sawForeignRoute ? "routed_to_other_executor" : "no routed work item" };
}

export function recordAuthoritativeExecutionOutcome(
  store: WorkItemStore,
  decision: AuthoritativeRouteResult,
  input: {
    executorId: string;
    latencyMs: number;
    success: boolean;
    timedOut: boolean;
    verificationResult?: string;
    testsResult?: string;
    retryCount?: number;
    model?: string;
    idempotencyKey: string;
  }
) {
  if (decision.decisionId === "none") return undefined;
  return recordAuthoritativeOutcome(
    store,
    {
      decisionId: decision.decisionId,
      executorId: input.executorId,
      latencyMs: input.latencyMs,
      success: input.success,
      timedOut: input.timedOut,
      retryCount: input.retryCount ?? 0,
      idempotencyKey: input.idempotencyKey,
      ...(input.model ? { model: input.model } : {}),
      ...(input.verificationResult ? { verificationResult: input.verificationResult } : {}),
      ...(input.testsResult ? { testsResult: input.testsResult } : {})
    },
    transition
  );
}

function contextFor(
  store: WorkItemStore,
  item: WorkItem,
  agents: RegistryAgentDetail[],
  options: { config: NimbleRoutingConfig; now?: Date }
) {
  const mode = store.getExecutionMode().mode;
  return {
    missionId: item.id,
    workItemId: item.id,
    operationType: item.requestedActions[0]?.kind ?? "unspecified",
    requiredCapabilities: [...new Set(item.requestedActions.map((action) => action.kind))],
    lane: item.requestedActions.some((action) => action.kind.startsWith("jc.")) ? ("jc" as const) : ("dc" as const),
    retryCount: item.retrySequence ?? 0,
    ...(options.now ? { now: options.now } : {}),
    executionModeAllowed: (agent: RegistryAgentDetail) => mode === "admin" || agent.provider !== "admin-only",
    operatorRestricted: new Set(options.config.operatorDeny),
    unhealthy: new Set(
      agents.filter((agent) => agent.status === "ERROR" || agent.status === "OFFLINE").map((agent) => agent.id)
    )
  };
}
