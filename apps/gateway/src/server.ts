import type { ServerResponse } from "node:http";
import {
  acpAdapterConfigFromEnv,
  ReadonlyAcpAdapter,
  type ReadonlyAcpAdapterConfig
} from "@agent-control-stack/acp-adapter";
import { projectAgents, renderDashboard } from "@agent-control-stack/control-ui";
import { createPolicyEngine, createWorkItemTools, workItemToolNames } from "@agent-control-stack/policy-gate";
import { ControlStackError } from "@agent-control-stack/shared";
import {
  createWorkItemSchema,
  listWorkItemsSchema,
  requesterSchema,
  SqliteWorkItemStore,
  acpRoles,
  actorTypes,
  registryStatuses,
  type StoredAuditEvent
} from "@agent-control-stack/work-items";
import { z, ZodError } from "zod";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import {
  createProtectedResourceMetadata,
  MCP_SCOPES,
  resolveMcpAuthOptions,
  type McpAuthOptions,
  type McpOAuthOptions
} from "./auth.js";
import { handleMcpHttpRequest, type AuthenticatedMcpRequestAudit } from "./mcp.js";

const approvalBodySchema = z.object({
  reason: z.string().min(1),
  actionHash: z.string().min(1).optional()
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

export interface GatewayAuthOptions {
  token: string;
  actor: string;
  /** Registry actor ID this credential is bound to; registry mutations fail closed without it. */
  actorId?: string;
}

export interface GatewayOptions {
  dbPath?: string;
  logger?: boolean;
  auth?: GatewayAuthOptions;
  mcpAuth?: McpAuthOptions;
  mcpOAuth?: McpOAuthOptions;
  acpAdapter?: ReadonlyAcpAdapterConfig | false;
}

export function buildGateway(options: GatewayOptions = {}): FastifyInstance {
  const dbPath = options.dbPath ?? process.env.ACS_DB_PATH ?? "storage/local.db";
  const app = Fastify({ logger: options.logger ?? true });
  const sseClients = new Set<ServerResponse>();
  const workItems = new SqliteWorkItemStore(dbPath, { onEvent: broadcast });
  const tools = createWorkItemTools(workItems, createPolicyEngine());
  const auth = resolveAuth(options);
  const mcpAuth = resolveMcpAuth(options, workItems);
  const acpAdapterConfig = options.acpAdapter === undefined ? acpAdapterConfigFromEnv() : options.acpAdapter;
  const acpAdapter = acpAdapterConfig === false || !acpAdapterConfig
    ? undefined
    : new ReadonlyAcpAdapter({ ...acpAdapterConfig, store: workItems });
  const requireRead = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!requireReadAccess(request, reply, auth)) {
      return reply;
    }
  };
  if (!mcpAuth?.oauth && !mcpAuth?.tunnel && process.env.NODE_ENV === "production") {
    app.log.warn("MCP OAuth/tunnel auth is disabled in production; set OAuth env or ACS_AUTH_MODE=tunnel_id");
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

  app.get("/health", async () => ({ ok: true }));

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

  app.get("/", { preHandler: requireRead }, async (_request, reply) => {
    const workItemList = workItems.list();
    const events = workItems.readEvents();
    reply.type("text/html").send(renderDashboard({ workItems: workItemList, events, registeredAgents: workItems.listRegistryAgents() }));
  });

  app.get("/mcp/tools", async () => ({ tools: workItemToolNames }));

  app.post("/connectors", async (request, reply) => {
    try {
      if (!requireMutationActor(request, reply, auth)) {
        return;
      }
      const connector = workItems.registerConnector(connectorBodySchema.parse(request.body));
      return reply.code(201).send({ connector });
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/connectors/:id/tunnel-sessions", async (request, reply) => {
    try {
      if (!requireMutationActor(request, reply, auth)) {
        return;
      }
      const body = tunnelSessionBodySchema.parse(request.body);
      const session = workItems.registerTunnelSession({ ...body, connectorId: request.params.id });
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
        const session = workItems.heartbeatTunnelSession({
          connectorId: request.params.id,
          tunnelId: request.params.tunnelId,
          sessionId: request.params.sessionId
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
        const session = workItems.revokeTunnelSession({
          connectorId: request.params.id,
          tunnelId: request.params.tunnelId,
          sessionId: request.params.sessionId
        });
        return { session };
      } catch (error) {
        return sendError(reply, error);
      }
    }
  );

  app.post("/mcp", async (request, reply) => {
    const resourceMetadataUrl = mcpResourceMetadataUrl(request, mcpAuth?.oauth);
    const result = await handleMcpHttpRequest({
      body: request.body,
      headers: request.headers,
      tools,
      auth: mcpAuth,
      resourceMetadataUrl,
      requestId: request.id,
      remoteAddress: request.socket.remoteAddress ?? request.ip,
      auditAuthenticatedRequest: recordAuthenticatedMcpRequest
    });
    if (result.wwwAuthenticate) {
      reply.header("WWW-Authenticate", result.wwwAuthenticate);
    }
    return reply.code(result.statusCode).send(result.body);
  });

  app.get("/.well-known/oauth-protected-resource", async (request, reply) => {
    const metadata = protectedResourceMetadata(request, mcpAuth);
    if (!metadata) {
      return reply.code(404).send({ error: "MCP auth is not configured" });
    }
    return metadata;
  });

  app.get("/.well-known/oauth-protected-resource/mcp", async (request, reply) => {
    const metadata = protectedResourceMetadata(request, mcpAuth);
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
      const actor = workItems.registerActor(actorBodySchema.parse(request.body));
      return reply.code(201).send({ actor });
    } catch (error) {
      return sendError(reply, error);
    }
  };
  app.post("/api/actors", registerActorHandler);
  app.post("/actors", registerActorHandler);

  app.get("/api/agents", { preHandler: requireRead }, async () => ({ agents: workItems.listRegistryAgents() }));

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
    const agent = workItems.getRegistryAgent(request.params.id);
    if (!agent) {
      return reply.code(404).send({ error: "agent not found" });
    }
    return { agent, adapterStatus: adapterStatusFor(request.params.id), events: agentEvents(workItems.readEvents(), request.params.id) };
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

  app.get("/agents", { preHandler: requireRead }, async () => ({
    agents: projectAgents(workItems.list(), workItems.readEvents(), new Date(), workItems.listRegistryAgents())
  }));

  app.get<{ Params: { id: string } }>("/agents/:id", { preHandler: requireRead }, async (request, reply) => {
    const events = workItems.readEvents();
    const agent = projectAgents(workItems.list(), events, new Date(), workItems.listRegistryAgents()).find(
      (candidate) => candidate.id === request.params.id
    );
    if (!agent) {
      return reply.code(404).send({ error: "agent not found" });
    }
    return { agent, adapterStatus: adapterStatusFor(request.params.id), events: agentEvents(events, request.params.id) };
  });

  app.get<{ Params: { id: string } }>("/work-items/:id", { preHandler: requireRead }, async (request, reply) => {
    const workItem = tools.get_work_item({ id: request.params.id });
    if (!workItem) {
      return reply.code(404).send({ error: "work item not found" });
    }
    return { workItem, events: workItemEvents(workItems.readEvents(), request.params.id) };
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
      const body = approvalBodySchema.parse(requestObject(request.body));
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

function workItemEvents(events: StoredAuditEvent[], workItemId: string): StoredAuditEvent[] {
  return events.filter((event) => {
    const body = event.body && typeof event.body === "object" ? (event.body as Record<string, unknown>) : {};
    return event.attributes["work_item.id"] === workItemId || body.id === workItemId || body.workItemId === workItemId;
  });
}

function agentEvents(events: StoredAuditEvent[], agentId: string): StoredAuditEvent[] {
  return events.filter((event) => {
    const body = event.body && typeof event.body === "object" ? (event.body as Record<string, unknown>) : {};
    return (
      event.attributes["worker.id"] === agentId ||
      event.attributes["agent.id"] === agentId ||
      event.attributes["connector.id"] === agentId ||
      event.attributes["auth.connector_id"] === agentId ||
      body.connectorId === agentId ||
      body.workerId === agentId
    );
  });
}

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof ZodError) {
    return reply.code(400).send({ error: "invalid request" });
  }
  if (error instanceof ControlStackError) {
    const status =
      error.code === "work_item_not_found" || error.code === "agent_not_found"
        ? 404
        : error.code === "actor_not_found" || error.code === "invalid_agent_registration"
          ? 400
          : 409;
    return reply.code(status).send({ error: error.message, code: error.code });
  }
  throw error;
}

function requestObject(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
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

function mcpResourceMetadataUrl(request: FastifyRequest, oauth: McpOAuthOptions | undefined): string | undefined {
  if (!oauth) return undefined;
  const configured = process.env.ACS_MCP_RESOURCE_METADATA_URL;
  if (configured) return configured;
  const forwardedProto = firstHeader(request.headers["x-forwarded-proto"]);
  const proto = forwardedProto ?? request.protocol;
  const host = firstHeader(request.headers["x-forwarded-host"]) ?? request.headers.host;
  return host ? `${proto}://${host}/.well-known/oauth-protected-resource/mcp` : undefined;
}

function protectedResourceMetadata(request: FastifyRequest, auth: McpAuthOptions | undefined) {
  if (auth?.oauth) {
    return createProtectedResourceMetadata(auth.oauth);
  }
  const forwardedProto = firstHeader(request.headers["x-forwarded-proto"]);
  const proto = forwardedProto ?? request.protocol;
  const host = firstHeader(request.headers["x-forwarded-host"]) ?? request.headers.host;
  if (!host) {
    return undefined;
  }
  return {
    resource: `${proto}://${host}/mcp`,
    resource_name: "Agent Control Stack MCP Gateway",
    authorization_servers: [],
    scopes_supported: [...MCP_SCOPES],
    bearer_methods_supported: ["header"] as const
  };
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
  const authorization = request.headers.authorization;
  if (authorization !== `Bearer ${auth.token}`) {
    reply.code(401).send({ error: "unauthorized" });
    return undefined;
  }
  return auth.actor;
}

function requireReadAccess(
  request: FastifyRequest,
  reply: FastifyReply,
  auth: GatewayAuthOptions | undefined
): boolean {
  if (auth) {
    if (request.headers.authorization !== `Bearer ${auth.token}`) {
      reply.code(401).send({ error: "unauthorized" });
      return false;
    }
    return true;
  }
  if (isDevelopmentLoopbackRequest(request)) {
    return true;
  }
  reply.code(503).send({ error: "read auth is not configured for production or exposed access" });
  return false;
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

function isDevelopmentLoopbackRequest(request: FastifyRequest): boolean {
  if (process.env.NODE_ENV === "production") {
    return false;
  }
  if (process.env.HOST && !isLoopbackAddress(process.env.HOST)) {
    return false;
  }
  return isLoopbackAddress(request.socket.remoteAddress ?? request.ip);
}

function isLoopbackAddress(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1" || address === "localhost";
}

export async function startGateway(): Promise<FastifyInstance> {
  const app = buildGateway();
  await app.listen({
    host: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? 3000)
  });
  return app;
}
