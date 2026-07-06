import type { ServerResponse } from "node:http";
import { renderDashboard } from "@agent-control-stack/control-ui";
import { createPolicyEngine, createWorkItemTools, workItemToolNames } from "@agent-control-stack/policy-gate";
import { ControlStackError } from "@agent-control-stack/shared";
import {
  createWorkItemSchema,
  listWorkItemsSchema,
  requesterSchema,
  SqliteWorkItemStore,
  type StoredAuditEvent
} from "@agent-control-stack/work-items";
import { z, ZodError } from "zod";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import {
  createProtectedResourceMetadata,
  resolveMcpAuthOptions,
  type McpAuthOptions,
  type McpOAuthOptions
} from "./auth.js";
import { handleMcpHttpRequest } from "./mcp.js";

const approvalBodySchema = z.object({
  reason: z.string().min(1),
  actionHash: z.string().min(1).optional()
});
const cancelBodySchema = z.object({ reason: z.string().min(1).optional() });
const unblockBodySchema = z.object({}).passthrough();

export interface GatewayAuthOptions {
  token: string;
  actor: string;
}

export interface GatewayOptions {
  dbPath?: string;
  logger?: boolean;
  auth?: GatewayAuthOptions;
  mcpAuth?: McpAuthOptions;
  mcpOAuth?: McpOAuthOptions;
}

export function buildGateway(options: GatewayOptions = {}): FastifyInstance {
  const dbPath = options.dbPath ?? process.env.ACS_DB_PATH ?? "storage/local.db";
  const app = Fastify({ logger: options.logger ?? true });
  const sseClients = new Set<ServerResponse>();
  const workItems = new SqliteWorkItemStore(dbPath, { onEvent: broadcast });
  const tools = createWorkItemTools(workItems, createPolicyEngine());
  const auth = resolveAuth(options);
  const mcpAuth = resolveMcpAuth(options);

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

  app.get("/", async (_request, reply) => {
    reply.type("text/html").send(renderDashboard(workItems.list()));
  });

  app.get("/mcp/tools", async () => ({ tools: workItemToolNames }));

  app.post("/mcp", async (request, reply) => {
    const resourceMetadataUrl = mcpResourceMetadataUrl(request, mcpAuth?.oauth);
    const result = await handleMcpHttpRequest({
      body: request.body,
      headers: request.headers,
      tools,
      auth: mcpAuth,
      resourceMetadataUrl
    });
    if (result.wwwAuthenticate) {
      reply.header("WWW-Authenticate", result.wwwAuthenticate);
    }
    return reply.code(result.statusCode).send(result.body);
  });

  app.get("/.well-known/oauth-protected-resource", async (_request, reply) => {
    if (!mcpAuth?.oauth) {
      return reply.code(404).send({ error: "MCP OAuth is not configured" });
    }
    return createProtectedResourceMetadata(mcpAuth.oauth);
  });

  app.get("/.well-known/oauth-protected-resource/mcp", async (_request, reply) => {
    if (!mcpAuth?.oauth) {
      return reply.code(404).send({ error: "MCP OAuth is not configured" });
    }
    return createProtectedResourceMetadata(mcpAuth.oauth);
  });

  app.get("/work-items", async (request, reply) => {
    try {
      return { workItems: tools.list_work_items(listWorkItemsSchema.parse(request.query)) };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/work-items/:id", async (request, reply) => {
    const workItem = tools.get_work_item({ id: request.params.id });
    if (!workItem) {
      return reply.code(404).send({ error: "work item not found" });
    }
    return { workItem };
  });

  app.post("/work-items", async (request, reply) => {
    try {
      const actor = requireMutationActor(request, reply, auth);
      if (!actor) {
        return;
      }
      const workItem = tools.create_work_item(createWorkItemSchema.parse({ ...requestObject(request.body), requester: actor }));
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

  app.get("/events", (request, reply) => {
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
    workItems.close();
  });

  return app;
}

function sendError(reply: FastifyReply, error: unknown) {
  if (error instanceof ZodError) {
    return reply.code(400).send({ error: "invalid request" });
  }
  if (error instanceof ControlStackError) {
    const status = error.code === "work_item_not_found" ? 404 : 409;
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
  return token ? { token, actor } : undefined;
}

function resolveMcpAuth(options: GatewayOptions): McpAuthOptions | undefined {
  return resolveMcpAuthOptions({
    localBearerToken: options.mcpAuth?.localBearerToken,
    gatewayBearerToken: options.auth?.token ?? process.env.ACS_GATEWAY_TOKEN,
    oauth: options.mcpAuth?.oauth ?? options.mcpOAuth
  });
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

export async function startGateway(): Promise<FastifyInstance> {
  const app = buildGateway();
  await app.listen({
    host: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? 3000)
  });
  return app;
}
