import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  projectAgents,
  renderDashboard,
  renderDashboardFragments,
  toMissionControlAttemptLease,
  toOverviewReadModel,
  type ApprovalActionOption,
  type MissionControlViewModel
} from "@agent-control-stack/control-ui";
import { previewWorkItemPolicy, SUPPORTED_ACTION_KINDS, type PolicyEngine } from "@agent-control-stack/policy-gate";
import {
  DEFAULT_EVENT_LIMIT,
  MAX_DASHBOARD_FINISHED_LIMIT,
  MAX_EVENT_LIMIT,
  type ReadEventsOptions,
  type RegisteredTunnelSession,
  type SqliteExecutionReadStore,
  type SqliteWorkItemStore,
  type WorkItem
} from "@agent-control-stack/work-items";
import type { AdmissionSnapshot } from "@agent-control-stack/execution-admission";
import { eventQuerySchema } from "./public-contracts.js";
import { gatewayCredentialForRequest, requesterForCredential, type GatewayAuthOptions } from "./credentials.js";
import type { GatewayMetrics } from "./metrics.js";
import {
  evaluateSandboxReadyzCheck,
  mergeSandboxReadyzCheck,
  type SandboxReadinessOptions
} from "./sandbox-readiness.js";

export const DASHBOARD_EVENT_PAGE = 50;
/** Most recent policy decisions summarized on the Policy panel. */
export const POLICY_SUMMARY_WINDOW = 500;

export const dashboardQuerySchema = z
  .object({ finished: z.coerce.number().int().min(0).max(MAX_DASHBOARD_FINISHED_LIMIT).optional() })
  .passthrough();

export const dashboardEventsQuerySchema = z.object({
  beforeSequence: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().optional()
});

export function reportedExecutionBackend(): "dry_run" | "desktop_commander" | undefined {
  const raw = process.env.ACS_EXECUTION_BACKEND?.trim();
  if (raw === undefined || raw === "" || raw === "dry_run") return "dry_run";
  if (raw === "desktop_commander") return "desktop_commander";
  return undefined;
}

export function approvalActionsByWorkItem(
  policy: PolicyEngine,
  workItems: WorkItem[],
  actor: string | undefined
): Record<string, ApprovalActionOption[]> {
  if (!actor) {
    return {};
  }
  return Object.fromEntries(
    workItems
      .filter((workItem) => workItem.status === "needs_approval")
      .map((workItem) => [
        workItem.id,
        policy
          .evaluateWorkItem(workItem, actor, "approve")
          .filter((evaluation) => evaluation.decision.decision === "require_approval")
          .map((evaluation) => ({
            actionHash: evaluation.actionHash,
            kind: evaluation.action.kind,
            description: evaluation.action.description
          }))
      ])
      .filter(([, hashes]) => hashes.length > 0)
  );
}

export function eventReadOptions(
  query: unknown,
  filters: Pick<ReadEventsOptions, "workItemId" | "agentId"> = {}
): ReadEventsOptions {
  const parsed = eventQuerySchema.parse(query ?? {});
  return {
    ...filters,
    limit: parsed.limit === undefined ? DEFAULT_EVENT_LIMIT : Math.min(parsed.limit, MAX_EVENT_LIMIT),
    ...(parsed.afterSequence === undefined ? {} : { afterSequence: parsed.afterSequence })
  };
}

export interface DashboardRouteDeps {
  workItems: SqliteWorkItemStore;
  executionReads: SqliteExecutionReadStore;
  policy: PolicyEngine;
  auth: GatewayAuthOptions | undefined;
  metrics: GatewayMetrics;
  heartbeatTtlMs: number;
  sandboxReadiness?: SandboxReadinessOptions;
  getAdmissionSnapshot: () => AdmissionSnapshot;
  getExecutorSummaries: () => unknown[];
  projectTunnelSession: (session: RegisteredTunnelSession, heartbeatTtlMs: number) => { effectiveStatus: string };
  validateRegisteredAgentPromptTarget: (store: SqliteWorkItemStore, input: Record<string, unknown>) => void;
  requireRead: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  sendError: (reply: FastifyReply, error: unknown) => unknown;
}

export function registerDashboardRoutes(app: FastifyInstance, deps: DashboardRouteDeps): void {
  const {
    workItems,
    executionReads,
    policy,
    auth,
    metrics,
    heartbeatTtlMs,
    sandboxReadiness,
    getAdmissionSnapshot,
    getExecutorSummaries,
    projectTunnelSession,
    validateRegisteredAgentPromptTarget,
    requireRead,
    sendError
  } = deps;

  function dashboardExecutionMode(): Pick<MissionControlViewModel, "executionMode" | "executionModeProblem"> {
    const { mode, raw } = workItems.getExecutionMode();
    return mode ? { executionMode: mode } : { executionModeProblem: raw ? "corrupt" : "missing" };
  }

  function missionControlViewModel(request: FastifyRequest): MissionControlViewModel {
    const { finished } = dashboardQuerySchema.parse(request.query ?? {});
    const dashboard = workItems.listDashboardWorkItems(finished === undefined ? {} : { finishedLimit: finished });
    const workItemList = [...dashboard.active, ...dashboard.finished];
    const ids = workItemList.map((workItem) => workItem.id);
    const attempts = executionReads.listExecutionAttemptsForWorkItems(ids);
    const leases = executionReads.listAttemptLeasesForWorkItems(ids);
    const now = new Date();
    const events = workItems.readEvents(eventReadOptions(request.query));
    const registeredAgents = workItems.listRegistryAgents();
    const projectedAgents = projectAgents(workItemList, events, now, registeredAgents);
    const executors = getExecutorSummaries() as Array<{ configured: boolean; status: string }>;
    const connectors = workItems.listConnectors();
    const enabledConnectorIds = new Set(
      connectors.filter((connector) => connector.status === "active").map((connector) => connector.id)
    );
    const tunnelSessions = workItems.listTunnelSessions();
    const admission = getAdmissionSnapshot();
    return {
      workItems: workItemList,
      executionPlansByWorkItem: Object.fromEntries(
        ids.flatMap((id) => {
          const plan = workItems.getCurrentExecutionPlan(id);
          return plan ? [[id, plan]] : [];
        })
      ),
      executionPlanAdmissionsByWorkItem: Object.fromEntries(executionReads.listCurrentPlanAdmissionsForWorkItems(ids)),
      statusCounts: dashboard.statusCounts,
      finishedWorkItems: {
        shown: dashboard.finished.length,
        total: dashboard.finishedTotal,
        limit: dashboard.finishedLimit
      },
      events,
      registeredAgents,
      agents: projectedAgents,
      infrastructure: {
        agents: {
          registered: registeredAgents.length,
          online: projectedAgents.filter((agent) => agent.status === "online").length
        },
        executors: {
          total: executors.length,
          configured: executors.filter((executor) => executor.configured).length,
          attestedRuntimes: executors.filter((executor) => executor.status === "active").length
        },
        connectors: {
          registered: connectors.length,
          enabled: enabledConnectorIds.size,
          activeSessions: tunnelSessions.filter(
            (session) =>
              enabledConnectorIds.has(session.connectorId) &&
              projectTunnelSession(session, heartbeatTtlMs).effectiveStatus === "active"
          ).length
        },
        admission: {
          active: admission.global.active,
          capacity: admission.global.capacity,
          queued: admission.global.queued,
          saturated: admission.saturated
        }
      },
      approvalActionsByWorkItem: approvalActionsByWorkItem(
        policy,
        workItemList,
        gatewayCredentialForRequest(request, auth)?.actor
      ),
      executionAttemptsByWorkItem: Object.fromEntries(ids.map((id) => [id, attempts.get(id) ?? []])),
      attemptLeasesByWorkItem: Object.fromEntries(
        ids.map((id) => [id, (leases.get(id) ?? []).map(toMissionControlAttemptLease)])
      ),
      executionBackend: reportedExecutionBackend(),
      executionTelemetry: executionReads.telemetry(now),
      readiness: mergeSandboxReadyzCheck(workItems.readinessHealth(), evaluateSandboxReadyzCheck(sandboxReadiness)),
      composerActionKinds: [...SUPPORTED_ACTION_KINDS],
      policyDecisionEvents: workItems.readEvents({ name: "policy.decided", limit: POLICY_SUMMARY_WINDOW }),
      now,
      ...dashboardExecutionMode()
    };
  }

  app.get("/", { preHandler: requireRead }, async (request, reply) => {
    try {
      reply.type("text/html").send(renderDashboard(missionControlViewModel(request)));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get(
    "/api/mission-control/overview",
    { preHandler: requireRead, config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (request, reply) => {
      try {
        reply.header("cache-control", "no-store");
        return toOverviewReadModel(missionControlViewModel(request));
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  app.get("/dashboard/fragments", { preHandler: requireRead }, async (request, reply) => {
    try {
      reply.header("cache-control", "no-store");
      return { fragments: renderDashboardFragments(missionControlViewModel(request)) };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/dashboard/policy-preview", { preHandler: requireRead }, async (request, reply) => {
    try {
      const credential = gatewayCredentialForRequest(request, auth);
      const payload = (request.body && typeof request.body === "object" ? request.body : {}) as Record<string, unknown>;
      validateRegisteredAgentPromptTarget(workItems, payload);
      reply.header("cache-control", "no-store");
      return previewWorkItemPolicy(policy, {
        ...payload,
        requester: credential ? requesterForCredential(credential) : "user"
      });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get("/dashboard/metrics", { preHandler: requireRead }, async (_request, reply) => {
    metrics.setSqliteReady(workItems.health().ok);
    reply.header("cache-control", "no-store");
    return { at: new Date().toISOString(), metrics: metrics.summary() };
  });

  app.get("/dashboard/events", { preHandler: requireRead }, async (request, reply) => {
    try {
      const { beforeSequence, limit } = dashboardEventsQuerySchema.parse(request.query ?? {});
      reply.header("cache-control", "no-store");
      return {
        events: workItems.readEvents({
          limit: Math.min(limit ?? DASHBOARD_EVENT_PAGE, MAX_EVENT_LIMIT),
          ...(beforeSequence === undefined ? {} : { beforeSequence })
        })
      };
    } catch (error) {
      return sendError(reply, error);
    }
  });
}
