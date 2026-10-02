import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { ControlStackError } from "@agent-control-stack/shared";
import { MCP_CLIENT_LIVE_WINDOW_MS, McpClientError, type McpClientService, type McpLane } from "./mcp-clients.js";
import { mcpClientClearBodySchema, mcpClientLabelBodySchema, mcpObservationBodySchema } from "./public-contracts.js";

export interface McpClientRouteDeps {
  app: FastifyInstance;
  service: McpClientService;
  requireRead: preHandlerAsyncHookHandler;
  /** Human operator with acs:approve. Replies and returns undefined on failure. */
  requireHumanActor: (request: FastifyRequest, reply: FastifyReply) => string | undefined;
  /** Authenticated bridge identity for the edge. Replies and returns undefined on failure. */
  requireBridge: (request: FastifyRequest, reply: FastifyReply) => string | undefined;
  /** Which lane each bridge identity may report for. */
  laneForBridge: (workerId: string) => McpLane | undefined;
  sendError: (reply: FastifyReply, error: unknown) => unknown;
}

export function registerMcpClientRoutes(deps: McpClientRouteDeps): void {
  const { app, service, requireRead, requireHumanActor, requireBridge, laneForBridge } = deps;
  const limit = (max: number) => ({ rateLimit: { max, timeWindow: "1 minute" } });
  const fail = (reply: FastifyReply, error: unknown) => {
    if (error instanceof McpClientError) {
      return reply
        .code(error.code === "mcp_client_not_found" ? 404 : error.code === "mcp_client_limit" ? 409 : 400)
        .send({ error: error.message, code: error.code });
    }
    return deps.sendError(reply, error);
  };

  app.get("/api/mcp-clients", { preHandler: requireRead, config: limit(120) }, async (_request, reply) => {
    try {
      // `now` and `liveWindowMs` let the browser keep liveness correct between refreshes using the server's clock.
      return {
        now: new Date().toISOString(),
        liveWindowMs: MCP_CLIENT_LIVE_WINDOW_MS,
        summary: service.summary(),
        clients: service.list(),
        legacy: service.legacyCallers()
      };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post("/api/mcp-clients/label", { config: limit(30) }, async (request, reply) => {
    try {
      const actorId = requireHumanActor(request, reply);
      if (!actorId) return;
      const body = mcpClientLabelBodySchema.parse(request.body);
      return { client: service.label({ ...body, actorId }) };
    } catch (error) {
      return fail(reply, error);
    }
  });

  app.post("/api/mcp-clients/label/clear", { config: limit(30) }, async (request, reply) => {
    try {
      const actorId = requireHumanActor(request, reply);
      if (!actorId) return;
      const body = mcpClientClearBodySchema.parse(request.body);
      return { client: service.clearLabel(body.clientId, actorId) };
    } catch (error) {
      return fail(reply, error);
    }
  });

  /**
   * The edge reports that a verified OAuth client connected. Attribution only: it can create a row in the
   * client list but never grants anything, and a bridge may only report for its own lane.
   */
  app.post("/mcp-clients/observe", { config: limit(600) }, async (request, reply) => {
    try {
      const workerId = requireBridge(request, reply);
      if (!workerId) return;
      const body = mcpObservationBodySchema.parse(request.body);
      const lane = laneForBridge(workerId);
      if (!lane || lane !== body.lane) {
        return reply
          .code(403)
          .send({ error: "this bridge identity may not report for that lane", code: "mcp_lane_mismatch" });
      }
      const result = service.observe({
        lane,
        clientId: body.clientId,
        subject: body.subject,
        method: body.method,
        ...(body.claims ? { claims: body.claims } : {})
      });
      return reply.code(202).send(result);
    } catch (error) {
      return fail(reply, error instanceof ControlStackError ? error : error);
    }
  });
}
