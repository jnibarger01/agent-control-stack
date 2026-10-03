import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import {
  previewMissionDispatch,
  readMissionDispatches,
  requestMissionDispatch,
  MISSION_DISPATCH_OBSERVED
} from "@agent-control-stack/policy-gate";
import type { WorkItemStore } from "@agent-control-stack/work-items";
import { ControlStackError } from "@agent-control-stack/shared";

export function registerMissionDispatchRoutes(deps: {
  app: FastifyInstance;
  store: WorkItemStore;
  enabled: boolean;
  requireRead: preHandlerAsyncHookHandler;
  requireHumanActor(request: FastifyRequest, reply: FastifyReply): string | undefined;
  sendError(reply: FastifyReply, error: unknown): unknown;
}): void {
  const { app, store } = deps;
  app.get("/api/mission-dispatch", { preHandler: deps.requireRead }, async (_request, reply) => {
    try {
      const requests = readMissionDispatches(store).slice(-50).reverse();
      return {
        enabled: deps.enabled,
        dispatches: requests.map((request) => {
          try {
            const progress = store.getChangeSetProgress(request.missionId, request.expectedManifestHash);
            if (!progress.completion)
              previewMissionDispatch(store, {
                missionId: request.missionId,
                expectedManifestHash: request.expectedManifestHash,
                approvalId: request.approvalId
              });
            const event = store
              .readEvents({ name: MISSION_DISPATCH_OBSERVED, workItemId: request.missionId, limit: 1 })
              .at(-1);
            const observed = event?.body as Record<string, unknown> | undefined;
            const observation =
              observed?.dispatchId === request.dispatchId && typeof observed.status === "string"
                ? { status: observed.status, ...(typeof observed.code === "string" ? { code: observed.code } : {}) }
                : undefined;
            return { ...request, progress, ...(observation ? { observation } : {}) };
          } catch (error) {
            return {
              ...request,
              code: error instanceof ControlStackError ? error.code : "mission_dispatch_progress_unavailable"
            };
          }
        })
      };
    } catch (error) {
      return deps.sendError(reply, error);
    }
  });
  for (const path of ["/api/mission-dispatch/preview", "/api/mission-dispatch"] as const) {
    app.post(path, async (request, reply) => {
      try {
        const actorId = deps.requireHumanActor(request, reply);
        if (!actorId) return;
        if (!deps.enabled)
          return reply
            .code(503)
            .send({ code: "mission_dispatch_disabled", error: "Governed dispatch is not enabled on this gateway" });
        if (path.endsWith("/preview")) return { preview: previewMissionDispatch(store, request.body) };
        const dispatch = requestMissionDispatch(store, request.body, actorId);
        return reply.code(202).send({ dispatch });
      } catch (error) {
        return deps.sendError(reply, error);
      }
    });
  }
}
