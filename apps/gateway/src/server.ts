import { createHmac, timingSafeEqual } from "node:crypto";
import type { ServerResponse } from "node:http";
import {
  acpAdapterConfigFromEnv,
  ReadonlyAcpAdapter,
  type ReadonlyAcpAdapterConfig
} from "@agent-control-stack/acp-adapter";
import { projectAgents, renderDashboard } from "@agent-control-stack/control-ui";
import {
  MachineController,
  loadMachineControllerConfig,
  type DirectAgentRunner
} from "@agent-control-stack/machine-controller";
import { createPolicyEngine, createWorkItemTools, workItemToolNames } from "@agent-control-stack/policy-gate";
import { ControlStackError } from "@agent-control-stack/shared";
import {
  createWorkItemSchema,
  listWorkItemsSchema,
  requesterSchema,
  SqliteWorkItemStore,
  DEFAULT_EVENT_LIMIT,
  MAX_EVENT_LIMIT,
  DEFAULT_HEARTBEAT_TTL_MS,
  isHeartbeatExpired,
  acpRoles,
  actorTypes,
  registryStatuses,
  type ReadEventsOptions,
  type RegistryAgentDetail,
  type RegistryStatus,
  type StoredAuditEvent,
  type WorkItem
} from "@agent-control-stack/work-items";
import { z, ZodError } from "zod";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import {
  authorizeMcpRequest,
  createProtectedResourceMetadata,
  mcpAuthorizationHttpError,
  MCP_SCOPES,
  resolveMcpAuthOptions,
  type McpAuthenticatedRequest,
  type McpAuthOptions,
  type McpOAuthOptions
} from "./auth.js";
import { handleMcpHttpRequest, type AuthenticatedMcpRequestAudit, type GatewayDirectAgentController } from "./mcp.js";
import { registerMoaGateway, type MoaGatewayOverrides } from "./moa/index.js";
import { gatewayListenConfig } from "./runtime-config.js";

const approvalBodySchema = z.object({
  reason: z.string().min(1),
  actionHash: z.string().min(1)
});
const cancelBodySchema = z.object({ reason: z.string().min(1).optional() });
const unblockBodySchema = z.object({}).passthrough();
const mcpScopeSchema = z.enum(MCP_SCOPES);
const connectorBodySchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1).optional(),
  publicKeyPem: z.string().min(1),
  allowedScopes: z.array(mcpScopeSchema).min(1)
});
const connectorKeyRotationBodySchema = z.object({
  publicKeyPem: z.string().min(1),
  reason: z.string().min(1)
});
const tunnelSessionBodySchema = z.object({
  tunnelId: z.string().min(1),
  sessionId: z.string().min(1),
  issuedAt: z.string().min(1).optional(),
  expiresAt: z.string().min(1)
});
const acpRoleSchema = z.enum(acpRoles);
const registryStatusSchema = z.enum(registryStatuses);
const optionalStringSchema = z.string().min(1).optional();
const nullableStringSchema = z.string().min(1).nullable().optional();
const agentBodySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.string().min(1),
  acpRole: acpRoleSchema,
  provider: optionalStringSchema,
  model: optionalStringSchema,
  endpoint: optionalStringSchema,
  status: registryStatusSchema.optional(),
  lastError: optionalStringSchema
});
const agentPatchSchema = z.object({
  name: optionalStringSchema,
  kind: optionalStringSchema,
  acpRole: acpRoleSchema.optional(),
  provider: nullableStringSchema,
  model: nullableStringSchema,
  endpoint: nullableStringSchema,
  status: registryStatusSchema.optional(),
  lastError: nullableStringSchema
});
const capabilitySchema = z.object({
  name: z.string().min(1),
  description: optionalStringSchema,
  inputSchema: z.record(z.string(), z.unknown()).optional()
});
const capabilitiesBodySchema = z.object({ capabilities: z.array(capabilitySchema) });
const actorBodySchema = z.object({
  id: z.string().min(1),
  actorType: z.enum(actorTypes),
  displayName: z.string().min(1),
  externalRef: optionalStringSchema
});
const heartbeatBodySchema = z.object({
  status: registryStatusSchema,
  currentTask: optionalStringSchema,
  lastError: optionalStringSchema
});
const eventQuerySchema = z
  .object({
    limit: z.coerce.number().int().positive().optional(),
    afterSequence: z.coerce.number().int().nonnegative().optional()
  })
  .passthrough();
const sessionLoginBodySchema = z.object({ token: z.string().min(1) });
const sessionCookieName = "acs_session";
const sessionCookieMaxAgeSeconds = 8 * 60 * 60;
const sessionCookiePayloadSchema = z.object({
  v: z.literal(1),
  actor: z.string().min(1),
  actorId: z.string().min(1).optional(),
  iat: z.number().int().nonnegative(),
  exp: z.number().int().nonnegative()
});
export interface GatewayAuthOptions {
  token: string;
  actor: string;
  /** Registry actor ID this credential is bound to; registry mutations fail closed without it. */
  actorId?: string;
}

export interface GatewayOptions {
  dbPath?: string;
  heartbeatTtlMs?: number;
  logger?: boolean;
  auth?: GatewayAuthOptions;
  mcpAuth?: McpAuthOptions;
  mcpOAuth?: McpOAuthOptions;
  mcpAllowedOrigins?: string[];
  machineControllerConfigPath?: string;
  directAgentRunner?: DirectAgentRunner;
  directAgentController?: GatewayDirectAgentController;
  enableTestAgentRunForLocalDevelopment?: boolean;
  acpAdapter?: ReadonlyAcpAdapterConfig | false;
  moa?: MoaGatewayOverrides | false;
}

export function buildGateway(options: GatewayOptions = {}): FastifyInstance {
  const dbPath = options.dbPath ?? process.env.ACS_DB_PATH ?? "storage/local.db";
  const directAgentController = resolveDirectAgentController(options);
  const app = Fastify({ logger: options.logger ?? true });
  const sseClients = new Set<ServerResponse>();
  const workItems = new SqliteWorkItemStore(dbPath, {
    onEvent: broadcast,
    heartbeatTtlMs: options.heartbeatTtlMs
  });
  const policy = createPolicyEngine();
  const tools = createWorkItemTools(workItems, policy);
  const auth = resolveAuth(options);
  const mcpAuth = resolveMcpAuth(options, workItems);
  const mcpAllowedOrigins = resolveMcpAllowedOrigins(options);
  const acpAdapterConfig = options.acpAdapter === undefined ? acpAdapterConfigFromEnv() : options.acpAdapter;
  const acpAdapter = acpAdapterConfig === false || !acpAdapterConfig
    ? undefined
    : new ReadonlyAcpAdapter({ ...acpAdapterConfig, store: workItems });
  const requireRead = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!hasReadAccess(request, auth)) {
      if (request.routeOptions.url === "/" && auth) {
        reply.code(401).type("text/html").send(renderLoginPage());
        return reply;
      }
      sendReadAccessError(reply, auth);
      return reply;
    }
  };
  if (!mcpAuth?.oauth && !mcpAuth?.tunnel && process.env.NODE_ENV === "production") {
    app.log.warn("MCP OAuth/tunnel auth is disabled in production; set OAuth env or ACS_AUTH_MODE=tunnel_id");
  }
  if (options.moa !== false) {
    app.register(async (instance) => {
      await registerMoaGateway(instance, {
        dbPath,
        store: workItems,
        authenticate: async (moaRequest) =>
          auth && (hasBearerAuth(moaRequest, auth) || hasSessionCookie(moaRequest, auth)) ? { actor: auth.actor } : null,
        ...(options.moa ? { overrides: options.moa } : {})
      });
    });
  }

  function broadcast(event: StoredAuditEvent): void {
    const frame = `event: ${event.name}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const client of sseClients) {
      try {
        client.write(frame);
      } catch {
        sseClients.delete(client);
      }
    }
  }

  // Fastify error handlers are instance-wide; preserve the default path for every non-MCP error.
  app.setErrorHandler((error, request, reply) => {
    if (request.url.split("?")[0] === "/mcp" && request.method === "POST" && isJsonParseError(error)) {
      return reply.code(400).send(jsonRpcError(null, -32700, "parse error"));
    }
    return reply.send(error);
  });

  app.get("/livez", async () => ({ ok: true, status: "alive" }));

  const readiness = async (_request: FastifyRequest, reply: FastifyReply) => {
    const initialHealth = workItems.health();
    const dependencyChecks = Object.entries(initialHealth.checks)
      .filter(([name]) => name !== "liveness")
      .map(([, check]) => check);
    if (!dependencyChecks.every((check) => check.ok)) {
      return reply.code(503).send(initialHealth);
    }
    try {
      workItems.reconcileStaleTunnelSessions();
      workItems.reconcileStaleAgents();
    } catch {
      const health = workItems.health();
      return reply.code(503).send({
        ...health,
        ok: false,
        checks: { ...health.checks, liveness: { ok: false, code: "liveness_reconciliation_failed" } }
      });
    }
    const health = workItems.health();
    return reply.code(health.ok ? 200 : 503).send(health);
  };
  app.get("/readyz", readiness);
  app.get("/health", readiness);

  app.post("/session/login", async (request, reply) => {
    try {
      if (!auth) {
        return reply.code(503).send({ error: "dashboard auth is not configured" });
      }
      const body = sessionLoginBodySchema.parse(request.body);
      if (!constantTimeEqual(body.token, auth.token)) {
        return reply.code(401).send({ error: "unauthorized" });
      }
      return reply
        .header("set-cookie", sessionCookie(auth, process.env.NODE_ENV === "production"))
        .code(204)
        .send();
    } catch (error) {
      return sendError(reply, error);
    }
  });

  if (acpAdapter) {
    app.addHook("onReady", async () => {
      try {
        await acpAdapter.start();
      } catch (error) {
        app.log.error({ err: error }, "ACP adapter failed to initialize");
        throw error;
      }
    });
  }

  app.get("/", { preHandler: requireRead }, async (request, reply) => {
    try {
      const workItemList = workItems.list();
      const events = workItems.readEvents(eventReadOptions(request.query));
      reply.type("text/html").send(renderDashboard({
        workItems: workItemList,
        events,
        registeredAgents: workItems.listRegistryAgents(),
        approvalActionHashesByWorkItem: approvalActionHashesByWorkItem(policy, workItemList, auth?.actor)
      }));
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get("/mcp/tools", async (request, reply) => {
    const requiredScopes = ["acs:work:read"] as const;
    const authorization = await authorizeMcpRequest({
      headers: request.headers,
      auth: mcpAuth,
      requiredScopes: [...requiredScopes],
      remoteAddress: request.socket.remoteAddress ?? request.ip
    });
    if (!authorization.ok) {
      const error = mcpAuthorizationHttpError(
        authorization,
        mcpResourceMetadataUrl(request, mcpAuth?.oauth),
        [...requiredScopes]
      );
      if (error.wwwAuthenticate) {
        reply.header("WWW-Authenticate", error.wwwAuthenticate);
      }
      return reply.code(error.statusCode).send({ error: error.error });
    }
    recordAuthenticatedMcpRequest({
      requestId: request.id,
      method: "GET",
      toolName: "tools/list",
      resolvedActor: resolveMcpActorId(workItems, authorization.auth, auth) ?? authorization.auth.subject,
      auth: authorization.auth
    });
    return { tools: workItemToolNames };
  });

  app.post("/connectors", async (request, reply) => {
    try {
      if (!requireMutationActor(request, reply, auth)) {
        return;
      }
      const actorId = requireBoundActorId(request, reply, auth);
      if (!actorId) {
        return;
      }
      const connector = workItems.registerConnector({ ...connectorBodySchema.parse(request.body), actorId });
      return reply.code(201).send({ connector });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/connectors/:id/rotate-key", async (request, reply) => {
    try {
      if (!requireMutationActor(request, reply, auth)) {
        return;
      }
      const actorId = requireBoundActorId(request, reply, auth);
      if (!actorId) {
        return;
      }
      const body = connectorKeyRotationBodySchema.parse(request.body);
      const connector = workItems.rotateConnectorKey({ id: request.params.id, ...body, actorId });
      return { connector };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/connectors/:id/tunnel-sessions", async (request, reply) => {
    try {
      if (!requireMutationActor(request, reply, auth)) {
        return;
      }
      const actorId = requireBoundActorId(request, reply, auth);
      if (!actorId) {
        return;
      }
      const body = tunnelSessionBodySchema.parse(request.body);
      const session = workItems.registerTunnelSession({ ...body, connectorId: request.params.id, actorId });
      return reply.code(201).send({ session });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string; tunnelId: string; sessionId: string } }>(
    "/connectors/:id/tunnels/:tunnelId/sessions/:sessionId/heartbeat",
    async (request, reply) => {
      try {
        if (!requireMutationActor(request, reply, auth)) {
          return;
        }
        const actorId = requireBoundActorId(request, reply, auth);
        if (!actorId) {
          return;
        }
        const session = workItems.heartbeatTunnelSession({
          connectorId: request.params.id,
          tunnelId: request.params.tunnelId,
          sessionId: request.params.sessionId,
          actorId
        });
        return { session };
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  app.post<{ Params: { id: string; tunnelId: string; sessionId: string } }>(
    "/connectors/:id/tunnels/:tunnelId/sessions/:sessionId/revoke",
    async (request, reply) => {
      try {
        if (!requireMutationActor(request, reply, auth)) {
          return;
        }
        const actorId = requireBoundActorId(request, reply, auth);
        if (!actorId) {
          return;
        }
        const session = workItems.revokeTunnelSession({
          connectorId: request.params.id,
          tunnelId: request.params.tunnelId,
          sessionId: request.params.sessionId,
          actorId
        });
        return { session };
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  app.get("/mcp", async (_request, reply) => {
    return reply.header("allow", "POST").code(405).send(jsonRpcError(null, -32000, "method not allowed"));
  });

  app.post("/mcp", async (request, reply) => {
    if (!isAllowedMcpOrigin(request.headers.origin, mcpAllowedOrigins)) {
      return reply.code(403).send(jsonRpcError(null, -32002, "forbidden origin"));
    }
    const resourceMetadataUrl = mcpResourceMetadataUrl(request, mcpAuth?.oauth);
    const localDevelopmentDirectAgentController = isDevelopmentLoopbackRequest(request)
      ? directAgentController
      : undefined;
    const result = await handleMcpHttpRequest({
      body: request.body,
      headers: request.headers,
      tools,
      directAgentController: localDevelopmentDirectAgentController,
      auth: mcpAuth,
      requireAuthentication: requiresMcpAuthentication(request, mcpAuth),
      resourceMetadataUrl,
      requestId: request.id,
      remoteAddress: request.socket.remoteAddress ?? request.ip,
      auditAuthenticatedRequest: recordAuthenticatedMcpRequest,
      resolveActorId: (mcpRequest) => resolveMcpActorId(workItems, mcpRequest, auth)
    });
    if (result.wwwAuthenticate) {
      reply.header("WWW-Authenticate", result.wwwAuthenticate);
    }
    if (result.body === undefined) {
      return reply.code(result.statusCode).send();
    }
    return reply.code(result.statusCode).send(result.body);
  });

  app.get("/.well-known/oauth-protected-resource", async (_request, reply) => {
    const metadata = protectedResourceMetadata(mcpAuth);
    if (!metadata) {
      return reply.code(404).send({ error: "MCP auth is not configured" });
    }
    return metadata;
  });

  app.get("/.well-known/oauth-protected-resource/mcp", async (_request, reply) => {
    const metadata = protectedResourceMetadata(mcpAuth);
    if (!metadata) {
      return reply.code(404).send({ error: "MCP auth is not configured" });
    }
    return metadata;
  });

  app.get("/work-items", { preHandler: requireRead }, async (request, reply) => {
    try {
      return { workItems: tools.list_work_items(listWorkItemsSchema.parse(request.query)) };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  const listActorsHandler = async () => ({ actors: workItems.listActors() });
  app.get("/api/actors", { preHandler: requireRead }, listActorsHandler);
  app.get("/actors", { preHandler: requireRead }, listActorsHandler);

  const registerActorHandler = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      if (!requireMutationActor(request, reply, auth)) {
        return;
      }
      const registeredByActorId = requireBoundActorId(request, reply, auth);
      if (!registeredByActorId) {
        return;
      }
      const actor = workItems.registerActor({ ...actorBodySchema.parse(request.body), registeredByActorId });
      return reply.code(201).send({ actor });
    } catch (error) {
      return sendError(reply, error);
    }
  };
  app.post("/api/actors", registerActorHandler);
  app.post("/actors", registerActorHandler);

  app.get("/api/agents", { preHandler: requireRead }, async () => ({
    agents: workItems.listRegistryAgents().map(projectRegistryFreshness)
  }));

  app.post("/api/agents", async (request, reply) => {
    try {
      if (!requireMutationActor(request, reply, auth)) {
        return;
      }
      const actorId = requireBoundActorId(request, reply, auth);
      if (!actorId) {
        return;
      }
      const agent = workItems.createRegistryAgent({ ...agentBodySchema.parse(request.body), actorId });
      return reply.code(201).send({ agent });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/agents/:id", { preHandler: requireRead }, async (request, reply) => {
    try {
      const agent = workItems.getRegistryAgent(request.params.id);
      if (!agent) {
        return reply.code(404).send({ error: "agent not found" });
      }
      return {
        agent: projectRegistryFreshness(agent),
        adapterStatus: adapterStatusFor(request.params.id),
        events: workItems.readEvents(eventReadOptions(request.query, { agentId: request.params.id }))
      };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.patch<{ Params: { id: string } }>("/api/agents/:id", async (request, reply) => {
    try {
      if (!requireMutationActor(request, reply, auth)) {
        return;
      }
      const actorId = requireBoundActorId(request, reply, auth);
      if (!actorId) {
        return;
      }
      const agent = workItems.updateRegistryAgent(request.params.id, { ...agentPatchSchema.parse(request.body), actorId });
      return { agent };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/agents/:id/capabilities", { preHandler: requireRead }, async (request, reply) => {
    try {
      return { capabilities: workItems.listAgentCapabilities(request.params.id) };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.put<{ Params: { id: string } }>("/api/agents/:id/capabilities", async (request, reply) => {
    try {
      if (!requireMutationActor(request, reply, auth)) {
        return;
      }
      const actorId = requireBoundActorId(request, reply, auth);
      if (!actorId) {
        return;
      }
      const body = capabilitiesBodySchema.parse(request.body);
      const capabilities = workItems.replaceAgentCapabilities(request.params.id, body.capabilities, actorId);
      return { capabilities };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/agents/:id/heartbeat", async (request, reply) => {
    try {
      if (!requireMutationActor(request, reply, auth)) {
        return;
      }
      const actorId = requireBoundActorId(request, reply, auth);
      if (!actorId) {
        return;
      }
      const result = workItems.recordAgentHeartbeat(request.params.id, { ...heartbeatBodySchema.parse(request.body), actorId });
      return reply.code(201).send(result);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get("/agents", { preHandler: requireRead }, async (request, reply) => {
    try {
      const events = workItems.readEvents(eventReadOptions(request.query));
      return { agents: projectAgents(workItems.list(), events, new Date(), workItems.listRegistryAgents()) };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/agents/:id", { preHandler: requireRead }, async (request, reply) => {
    try {
      const events = workItems.readEvents(eventReadOptions(request.query, { agentId: request.params.id }));
      const agent = projectAgents(workItems.list(), events, new Date(), workItems.listRegistryAgents()).find(
        (candidate) => candidate.id === request.params.id
      );
      if (!agent) {
        return reply.code(404).send({ error: "agent not found" });
      }
      return { agent, adapterStatus: adapterStatusFor(request.params.id), events };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/work-items/:id", { preHandler: requireRead }, async (request, reply) => {
    try {
      const workItem = tools.get_work_item({ id: request.params.id });
      if (!workItem) {
        return reply.code(404).send({ error: "work item not found" });
      }
      return { workItem, events: workItems.readEvents(eventReadOptions(request.query, { workItemId: request.params.id })) };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post("/work-items", async (request, reply) => {
    try {
      const actor = requireMutationActor(request, reply, auth);
      if (!actor) {
        return;
      }
      const workItem = tools.create_work_item(
        createWorkItemSchema.parse({ ...requestObject(request.body), requester: actor, requesterSubject: undefined })
      );
      return reply.code(201).send(workItem);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/work-items/:id/approve", async (request, reply) => {
    try {
      const actor = requireMutationActor(request, reply, auth);
      if (!actor) {
        return;
      }
      const bodyObject = requestObject(request.body);
      requireApprovalActionHash(bodyObject);
      const body = approvalBodySchema.parse(bodyObject);
      const workItem = tools.get_work_item({ id: request.params.id });
      if (!workItem) {
        return reply.code(404).send({ error: "work item not found" });
      }
      const result = tools.approve_work_item({ ...body, id: request.params.id, approvedBy: actor });
      return reply.code(result.decision.decision === "deny" ? 403 : 200).send(result);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/work-items/:id/cancel", async (request, reply) => {
    try {
      const actor = requireMutationActor(request, reply, auth);
      if (!actor) {
        return;
      }
      const body = cancelBodySchema.parse(requestObject(request.body));
      const cancelled = tools.cancel_work_item({ ...body, id: request.params.id, actor });
      return { workItem: cancelled };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/work-items/:id/reject", async (request, reply) => {
    try {
      const actor = requireMutationActor(request, reply, auth);
      if (!actor) {
        return;
      }
      const body = cancelBodySchema.parse(requestObject(request.body));
      const rejected = tools.reject_work_item({ ...body, id: request.params.id, actor });
      return { workItem: rejected };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/work-items/:id/unblock", async (request, reply) => {
    try {
      const actor = requireMutationActor(request, reply, auth);
      if (!actor) {
        return;
      }
      unblockBodySchema.parse(requestObject(request.body));
      const result = tools.unblock_work_item({ actor, id: request.params.id });
      return reply.code(result.decision.decision === "deny" ? 403 : 200).send(result);
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/work-items/:id/results", async (request, reply) => {
    return reply.code(501).send({ error: "worker result submission requires a lease-bound worker API" });
  });

  app.get("/events", { preHandler: requireRead }, (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive"
    });
    reply.raw.write(`event: ready\ndata: {}\n\n`);
    sseClients.add(reply.raw);
    request.raw.on("close", () => {
      sseClients.delete(reply.raw);
    });
  });

  app.addHook("onClose", async () => {
    await acpAdapter?.stop();
    workItems.close();
  });

  function recordAuthenticatedMcpRequest(event: AuthenticatedMcpRequestAudit): void {
    workItems.recordConnectorRequest({
      actor: event.resolvedActor,
      source: "mcp",
      route: "/mcp",
      toolName: event.toolName ?? event.method,
      workItemId: event.workItemId,
      requestId: event.requestId,
      authMethod: event.auth.method,
      authSubject: event.auth.subject,
      authIssuer: event.auth.issuer,
      authConnectorId: event.auth.connectorId,
      authTunnelId: event.auth.tunnelId,
      authSessionId: event.auth.sessionId,
      authScopes: event.auth.scopes
    });
  }

  function adapterStatusFor(agentId: string) {
    const status = acpAdapter?.getStatus();
    return status?.agentId === agentId ? status : undefined;
  }

  return app;
}

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof ZodError) {
    return reply.code(400).send({ error: "invalid request" });
  }
  if (error instanceof ControlStackError) {
    const status =
      error.code === "work_item_not_found" || error.code === "agent_not_found"
        ? 404
        : error.code === "actor_not_found" ||
            error.code === "invalid_agent_registration" ||
            error.code === "invalid_event_query" ||
            error.code === "approval_action_hash_required"
          ? 400
          : 409;
    return reply.code(status).send({ error: error.message, code: error.code });
  }
  throw error;
}

function requestObject(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

function requireApprovalActionHash(input: Record<string, unknown>): void {
  if (typeof input.actionHash !== "string" || input.actionHash.trim().length === 0) {
    throw new ControlStackError("approval_action_hash_required", "approval_action_hash_required: actionHash is required");
  }
}

function approvalActionHashesByWorkItem(
  policy: ReturnType<typeof createPolicyEngine>,
  workItems: WorkItem[],
  actor: string | undefined
): Record<string, string[]> {
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
          .map((evaluation) => evaluation.actionHash)
      ])
      .filter(([, hashes]) => hashes.length > 0)
  );
}

function eventReadOptions(query: unknown, filters: Pick<ReadEventsOptions, "workItemId" | "agentId"> = {}): ReadEventsOptions {
  const parsed = eventQuerySchema.parse(query ?? {});
  return {
    ...filters,
    limit: parsed.limit === undefined ? DEFAULT_EVENT_LIMIT : Math.min(parsed.limit, MAX_EVENT_LIMIT),
    ...(parsed.afterSequence === undefined ? {} : { afterSequence: parsed.afterSequence })
  };
}

function projectRegistryFreshness(agent: RegistryAgentDetail): RegistryAgentDetail & {
  effectiveStatus: RegistryStatus;
  heartbeatAgeMs: number | null;
  isStale: boolean;
} {
  const heartbeatTime = agent.lastHeartbeatAt ? Date.parse(agent.lastHeartbeatAt) : Number.NaN;
  const heartbeatAgeMs = Number.isFinite(heartbeatTime) ? Math.max(0, Date.now() - heartbeatTime) : null;
  const freshnessStatus = agent.status === "AVAILABLE" || agent.status === "BUSY" || agent.status === "DEGRADED";
  const isStale = freshnessStatus && isHeartbeatExpired(
    agent.lastHeartbeatAt,
    agent.updatedAt,
    new Date(),
    DEFAULT_HEARTBEAT_TTL_MS
  );
  return {
    ...agent,
    effectiveStatus: isStale ? "OFFLINE" : agent.status,
    heartbeatAgeMs,
    isStale
  };
}

function resolveAuth(options: GatewayOptions): GatewayAuthOptions | undefined {
  if (options.auth) {
    return options.auth;
  }
  const token = process.env.ACS_GATEWAY_TOKEN;
  const actor = requesterSchema.parse(process.env.ACS_GATEWAY_ACTOR ?? "user");
  const actorId = process.env.ACS_GATEWAY_ACTOR_ID;
  return token ? { token, actor, ...(actorId ? { actorId } : {}) } : undefined;
}

function resolveDirectAgentController(options: GatewayOptions): GatewayDirectAgentController | undefined {
  const enabled =
    options.enableTestAgentRunForLocalDevelopment ??
    process.env.ACS_ENABLE_TEST_AGENT_RUN_FOR_LOCAL_DEVELOPMENT === "1";
  if (!enabled) return undefined;
  if (process.env.NODE_ENV === "production") {
    throw new ControlStackError(
      "direct_agent_production_forbidden",
      "test.agent.run local-development opt-in is forbidden in production"
    );
  }
  if (options.directAgentController) return options.directAgentController;
  const configPath = options.machineControllerConfigPath ?? process.env.ACS_MACHINE_CONTROLLER_CONFIG;
  if (!configPath) return undefined;
  return new MachineController(loadMachineControllerConfig(configPath), {
    directAgentRunner: options.directAgentRunner,
    enableTestAgentRunForLocalDevelopment: true
  });
}

function resolveMcpAuth(options: GatewayOptions, workItems: SqliteWorkItemStore): McpAuthOptions | undefined {
  const resolved = resolveMcpAuthOptions({
    localBearerToken: options.mcpAuth?.localBearerToken,
    oauth: options.mcpAuth?.oauth ?? options.mcpOAuth,
    tunnel: options.mcpAuth?.tunnel
  });
  if (resolved?.tunnel && !resolved.tunnel.resolveSession && !resolved.tunnel.connectors?.length) {
    return {
      ...resolved,
      tunnel: {
        ...resolved.tunnel,
        resolveSession: (lookup) => workItems.getTunnelSession(lookup)
      }
    };
  }
  return resolved;
}

function resolveMcpAllowedOrigins(options: GatewayOptions): string[] {
  if (options.mcpAllowedOrigins) {
    return options.mcpAllowedOrigins;
  }
  return (process.env.ACS_MCP_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function isAllowedMcpOrigin(origin: string | undefined, allowedOrigins: string[]): boolean {
  if (!origin) {
    return true;
  }
  return allowedOrigins.includes(origin);
}

function isJsonParseError(error: unknown): boolean {
  return (error as { code?: string }).code === "FST_ERR_CTP_INVALID_JSON_BODY";
}

function jsonRpcError(id: string | number | null, code: number, message: string) {
  return {
    jsonrpc: "2.0" as const,
    id,
    error: { code, message }
  };
}

function resolveMcpActorId(
  workItems: SqliteWorkItemStore,
  request: McpAuthenticatedRequest,
  gatewayAuth: GatewayAuthOptions | undefined
): string | undefined {
  const candidates = [
    request.connectorId,
    request.subject,
    `${request.method}:${request.connectorId ?? request.subject}`,
    request.method === "local_bearer" ? gatewayAuth?.actorId : undefined
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);
  return workItems.resolveActorId(candidates);
}

function mcpResourceMetadataUrl(request: FastifyRequest, oauth: McpOAuthOptions | undefined): string | undefined {
  if (!oauth) return undefined;
  const configured = process.env.ACS_MCP_RESOURCE_METADATA_URL;
  if (configured) return configured;
  const forwardedProto = firstHeader(request.headers["x-forwarded-proto"]);
  const proto = forwardedProto ?? request.protocol;
  const host = firstHeader(request.headers["x-forwarded-host"]) ?? request.headers.host;
  return host ? `${proto}://${host}/.well-known/oauth-protected-resource/mcp` : undefined;
}

function protectedResourceMetadata(auth: McpAuthOptions | undefined) {
  return auth?.oauth ? createProtectedResourceMetadata(auth.oauth) : undefined;
}

function requiresMcpAuthentication(request: FastifyRequest, auth: McpAuthOptions | undefined): boolean {
  return Boolean(auth) || !isDevelopmentLoopbackRequest(request);
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function requireMutationActor(
  request: FastifyRequest,
  reply: FastifyReply,
  auth: GatewayAuthOptions | undefined
): string | undefined {
  if (!auth) {
    reply.code(503).send({ error: "mutation auth is not configured" });
    return undefined;
  }
  if (!hasBearerAuth(request, auth) && !hasSessionCookie(request, auth)) {
    reply.code(401).send({ error: "unauthorized" });
    return undefined;
  }
  return auth.actor;
}

function hasReadAccess(request: FastifyRequest, auth: GatewayAuthOptions | undefined): boolean {
  if (auth) {
    return hasBearerAuth(request, auth) || hasSessionCookie(request, auth);
  }
  return isDevelopmentLoopbackRequest(request);
}

function sendReadAccessError(reply: FastifyReply, auth: GatewayAuthOptions | undefined): void {
  if (auth) {
    reply.code(401).send({ error: "unauthorized" });
    return;
  }
  reply.code(503).send({ error: "read auth is not configured for production or exposed access" });
}

function requireBoundActorId(
  request: FastifyRequest,
  reply: FastifyReply,
  auth: GatewayAuthOptions | undefined
): string | undefined {
  const boundActorId = auth?.actorId;
  if (!boundActorId) {
    reply.code(503).send({ error: "registry actor binding is not configured; set ACS_GATEWAY_ACTOR_ID" });
    return undefined;
  }
  const claimedActorId = firstHeader(request.headers["x-acs-actor-id"]);
  if (claimedActorId && claimedActorId !== boundActorId) {
    reply.code(403).send({ error: "x-acs-actor-id does not match the credential-bound actor" });
    return undefined;
  }
  return boundActorId;
}

function hasBearerAuth(request: FastifyRequest, auth: GatewayAuthOptions): boolean {
  return request.headers.authorization === `Bearer ${auth.token}`;
}

function hasSessionCookie(request: FastifyRequest, auth: GatewayAuthOptions): boolean {
  const value = cookies(request.headers.cookie)[sessionCookieName];
  return value ? verifySessionCookie(value, auth) : false;
}

function sessionCookie(auth: GatewayAuthOptions, secure: boolean): string {
  const parts = [
    `${sessionCookieName}=${sessionCookieValue(auth)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${sessionCookieMaxAgeSeconds}`
  ];
  if (secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

function sessionCookieValue(auth: GatewayAuthOptions, now = new Date()): string {
  const iat = Math.floor(now.getTime() / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      v: 1,
      actor: auth.actor,
      ...(auth.actorId ? { actorId: auth.actorId } : {}),
      iat,
      exp: iat + sessionCookieMaxAgeSeconds
    })
  ).toString("base64url");
  return `${payload}.${sessionSignature(auth, payload)}`;
}

function verifySessionCookie(value: string, auth: GatewayAuthOptions, now = new Date()): boolean {
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra !== undefined) {
    return false;
  }
  if (!constantTimeEqual(signature, sessionSignature(auth, payload))) {
    return false;
  }
  try {
    const parsed = sessionCookiePayloadSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
    const nowSeconds = Math.floor(now.getTime() / 1000);
    return (
      parsed.actor === auth.actor &&
      (parsed.actorId ?? "") === (auth.actorId ?? "") &&
      parsed.iat <= nowSeconds &&
      parsed.exp > nowSeconds
    );
  } catch {
    return false;
  }
}

function sessionSignature(auth: GatewayAuthOptions, payload: string): string {
  return createHmac("sha256", auth.token).update(`acs-session-v2:${payload}`).digest("base64url");
}

function cookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  return Object.fromEntries(
    header
      .split(";")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const index = entry.indexOf("=");
        return index === -1 ? [entry, ""] : [entry.slice(0, index), entry.slice(index + 1)];
      })
  );
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function renderLoginPage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>AgentOS Mission Control Login</title>
    <style>
      :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #071019; color: #d7e0ea; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #071019; }
      form { width: min(360px, calc(100vw - 32px)); display: grid; gap: 12px; border: 1px solid #17283a; background: #0a1522; padding: 18px; border-radius: 8px; }
      h1 { margin: 0 0 4px; font-size: 20px; }
      label { display: grid; gap: 6px; color: #91a6bd; font-size: 13px; }
      input { background: #07111d; color: #dbeafe; border: 1px solid #1c3148; border-radius: 8px; padding: 10px; }
      button { background: #2563eb; color: white; border: 0; border-radius: 8px; padding: 10px 12px; font-weight: 700; cursor: pointer; }
      output { min-height: 20px; color: #fca5a5; }
    </style>
  </head>
  <body>
    <form id="login-form">
      <h1>Mission Control</h1>
      <label>Operator token<input name="token" type="password" autocomplete="off" autofocus /></label>
      <button type="submit">Sign in</button>
      <output></output>
    </form>
    <script>
      document.querySelector('#login-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const res = await fetch('/session/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: String(form.get('token') || '') })
        });
        if (res.ok) location.assign('/');
        else document.querySelector('output').textContent = 'Unauthorized';
      });
    </script>
  </body>
</html>`;
}

function isDevelopmentLoopbackRequest(request: FastifyRequest): boolean {
  if (process.env.NODE_ENV === "production") {
    return false;
  }
  if (process.env.HOST && !isLoopbackAddress(process.env.HOST)) {
    return false;
  }
  return (
    isLoopbackAddress(request.socket.remoteAddress ?? request.ip) &&
    isLoopbackHost(request.headers["x-forwarded-host"] ?? request.headers.host)
  );
}

function isLoopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1" || address === "localhost";
}

function isLoopbackHost(value: string | string[] | undefined): boolean {
  const host = firstHeader(value);
  if (!host) {
    return false;
  }
  try {
    const hostname = new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, "");
    return isLoopbackAddress(hostname);
  } catch {
    return false;
  }
}

export async function startGateway(): Promise<FastifyInstance> {
  const listen = gatewayListenConfig();
  const app = buildGateway();
  await app.listen(listen);
  return app;
}
