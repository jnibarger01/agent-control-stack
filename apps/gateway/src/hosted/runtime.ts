import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { loadHostedGatewayConfig, type HostedGatewayConfig } from "./config.js";
import {
  hostedApprovalSchema,
  hostedClaimSchema,
  hostedCreateWorkItemSchema,
  hostedListWorkItemsSchema,
  hostedReasonSchema,
  jsonRpcRequestSchema,
  MCP_PROTOCOL_VERSION
} from "./contracts.js";
import { authorizeHostedRequest, hostedWwwAuthenticate, type HostedAuthorizationResult, type HostedIdentity } from "./oauth.js";
import { HostedStore } from "./store.js";

const scopes = [
  "acs:work:create",
  "acs:work:read",
  "acs:work:approve",
  "acs:worker:claim",
  "acs:worker:result"
] as const;
type Scope = (typeof scopes)[number];

const mcpTools = ["create_work_item", "get_work_item", "list_work_items", "unblock_work_item", "reject_work_item", "cancel_work_item"] as const;
type McpTool = (typeof mcpTools)[number];
const idSchema = z.object({ id: z.string().min(1) }).strict();
const toolCallSchema = z.object({ name: z.enum(mcpTools), arguments: z.unknown().optional() }).strict();

export async function createHostedRuntime(): Promise<FastifyInstance> {
  const config = loadHostedGatewayConfig();
  const store = new HostedStore(config);
  await store.migrate();
  const app = Fastify({ logger: true, trustProxy: true, bodyLimit: 256 * 1024 });

  app.get("/livez", async () => ({ ok: true, runtime: "vercel-neon" }));
  app.get("/readyz", async (_request, reply) => ready(store, reply));
  app.get("/health", async (_request, reply) => ready(store, reply));

  const metadata = {
    resource: config.oauthAudience,
    resource_name: "Agent Control Stack MCP Gateway",
    authorization_servers: [config.oauthIssuer],
    scopes_supported: [...scopes],
    bearer_methods_supported: ["header"]
  };
  app.get("/.well-known/oauth-protected-resource", async () => metadata);
  app.get("/.well-known/oauth-protected-resource/mcp", async () => metadata);

  app.post("/mcp", async (request, reply) => handleMcp(request, reply, config, store));

  app.get("/work-items", async (request, reply) => {
    const identity = await requireAuth(request, reply, config, ["acs:work:read"]);
    if (!identity) return;
    const parsed = hostedListWorkItemsSchema.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
    return { workItems: await store.list(parsed.data) };
  });

  app.post("/work-items", async (request, reply) => {
    const identity = await requireAuth(request, reply, config, ["acs:work:create"]);
    if (!identity) return;
    if ((await store.countPending()) >= config.maxPendingWorkItems) return reply.code(429).send({ error: "pending_work_item_limit_reached" });
    const parsed = hostedCreateWorkItemSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
    return reply.code(201).send(await store.create(parsed.data, identity.subject));
  });

  app.get<{ Params: { id: string } }>("/work-items/:id", async (request, reply) => {
    const identity = await requireAuth(request, reply, config, ["acs:work:read"]);
    if (!identity) return;
    const item = await store.get(request.params.id);
    return item ? { workItem: item } : reply.code(404).send({ error: "work_item_not_found" });
  });

  app.post<{ Params: { id: string } }>("/work-items/:id/approve", async (request, reply) => {
    const identity = await requireAuth(request, reply, config, ["acs:work:approve"]);
    if (!identity) return;
    const parsed = hostedApprovalSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
    return domain(reply, () => store.approve(request.params.id, parsed.data, identity.subject));
  });

  app.post<{ Params: { id: string } }>("/work-items/:id/cancel", async (request, reply) => {
    const identity = await requireAuth(request, reply, config, ["acs:work:approve"]);
    if (!identity) return;
    const parsed = hostedReasonSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
    return domain(reply, () => store.terminal(request.params.id, "cancel", parsed.data, identity.subject));
  });

  app.post<{ Params: { id: string } }>("/work-items/:id/reject", async (request, reply) => {
    const identity = await requireAuth(request, reply, config, ["acs:work:approve"]);
    if (!identity) return;
    const parsed = hostedReasonSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
    return domain(reply, () => store.terminal(request.params.id, "reject", parsed.data, identity.subject));
  });

  app.post<{ Params: { id: string } }>("/work-items/:id/unblock", async (request, reply) => {
    const identity = await requireAuth(request, reply, config, ["acs:work:approve"]);
    if (!identity) return;
    return domain(reply, () => store.unblock(request.params.id, identity.subject));
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>("/work-items/:id/audit", async (request, reply) => {
    const identity = await requireAuth(request, reply, config, ["acs:work:read"]);
    if (!identity) return;
    return { events: await store.auditEvents(request.params.id, Number(request.query.limit ?? 100)) };
  });

  app.post("/worker/claim", async (request, reply) => {
    const identity = await requireAuth(request, reply, config, ["acs:worker:claim"]);
    if (!identity) return;
    const parsed = hostedClaimSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
    const claim = await store.claim(parsed.data, identity.subject);
    return claim ? { claim } : reply.code(204).send();
  });

  app.post("/worker/results", async (request, reply) => {
    const identity = await requireAuth(request, reply, config, ["acs:worker:result"]);
    if (!identity) return;
    const leaseToken = one(request.headers["x-acs-lease-token"]);
    if (!leaseToken) return reply.code(401).send({ error: "missing_lease_token" });
    return domain(reply, async () => ({ workItem: await store.submitResult(request.body, identity.subject, leaseToken) }), 201);
  });

  return app;
}

async function handleMcp(request: FastifyRequest, reply: FastifyReply, config: HostedGatewayConfig, store: HostedStore) {
  const rpc = jsonRpcRequestSchema.safeParse(request.body);
  if (!rpc.success) return reply.code(400).send(rpcError(null, -32600, "invalid JSON-RPC request"));
  const { id, method, params } = rpc.data;

  if (method === "initialize" || method === "ping" || method === "tools/list" || method.startsWith("notifications/")) {
    const identity = await requireAuth(request, reply, config, []);
    if (!identity) return;
    if (method.startsWith("notifications/")) return reply.code(202).send();
    if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
    if (method === "initialize") {
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "agent-control-stack-gateway", version: "0.1.0-vercel" }
        }
      };
    }
    return { jsonrpc: "2.0", id, result: { tools: mcpDefinitions() } };
  }

  if (method !== "tools/call") return reply.code(404).send(rpcError(id, -32601, "method not found"));
  const call = toolCallSchema.safeParse(params);
  if (!call.success) return reply.code(400).send(rpcError(id, -32602, "invalid tools/call params"));
  const identity = await requireAuth(request, reply, config, [scopeFor(call.data.name)]);
  if (!identity) return;

  try {
    const result = await callTool(call.data.name, call.data.arguments ?? {}, identity, config, store);
    return {
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: `${call.data.name} completed through the hosted ACS gateway.` }],
        structuredContent: asObject(result)
      }
    };
  } catch (error) {
    const mapped = mapError(error);
    return reply.code(mapped.status).send(rpcError(id, mapped.rpc, mapped.message));
  }
}

async function callTool(name: McpTool, args: unknown, identity: HostedIdentity, config: HostedGatewayConfig, store: HostedStore): Promise<unknown> {
  switch (name) {
    case "create_work_item":
      if ((await store.countPending()) >= config.maxPendingWorkItems) throw new Error("pending_work_item_limit_reached");
      return store.create(hostedCreateWorkItemSchema.parse(args), identity.subject);
    case "get_work_item": {
      const { id } = idSchema.parse(args);
      const item = await store.get(id);
      if (!item) throw new Error("work_item_not_found");
      return item;
    }
    case "list_work_items":
      return { workItems: await store.list(hostedListWorkItemsSchema.parse(args)) };
    case "unblock_work_item":
      return store.unblock(idSchema.parse(args).id, identity.subject);
    case "reject_work_item": {
      const parsed = z.object({ id: z.string().min(1), reason: z.string().min(1).max(2_000).optional() }).strict().parse(args);
      return store.terminal(parsed.id, "reject", { reason: parsed.reason }, identity.subject);
    }
    case "cancel_work_item": {
      const parsed = z.object({ id: z.string().min(1), reason: z.string().min(1).max(2_000).optional() }).strict().parse(args);
      return store.terminal(parsed.id, "cancel", { reason: parsed.reason }, identity.subject);
    }
  }
}

async function requireAuth(request: FastifyRequest, reply: FastifyReply, config: HostedGatewayConfig, required: readonly Scope[]): Promise<HostedIdentity | undefined> {
  const result = await authorizeHostedRequest(request.headers, config, required);
  if (result.ok) return result.identity;
  reply.code(result.statusCode).header("WWW-Authenticate", hostedWwwAuthenticate(config, result)).send({
    error: result.error,
    error_description: result.message
  });
  return undefined;
}

async function ready(store: HostedStore, reply: FastifyReply) {
  try {
    return { ...(await store.health()), storage: "postgres" };
  } catch {
    return reply.code(503).send({ ok: false });
  }
}

async function domain(reply: FastifyReply, operation: () => Promise<unknown>, success = 200) {
  try {
    return reply.code(success).send(await operation());
  } catch (error) {
    const mapped = mapError(error);
    return reply.code(mapped.status).send({ error: mapped.message });
  }
}

function mapError(error: unknown): { status: number; rpc: number; message: string } {
  if (error instanceof z.ZodError) return { status: 400, rpc: -32602, message: "invalid_request" };
  const message = error instanceof Error ? error.message : "internal_error";
  if (["work_item_not_found", "lease_not_found"].includes(message)) return { status: 404, rpc: -32004, message };
  if (message === "pending_work_item_limit_reached") return { status: 429, rpc: -32029, message };
  if (
    message.includes("mismatch") || message.includes("terminal") || message.includes("not_running") ||
    message.includes("not_blocked") || message.includes("not_awaiting") || message.includes("already_completed") ||
    message === "lease_expired"
  ) return { status: 409, rpc: -32009, message };
  return { status: 500, rpc: -32603, message: "internal_error" };
}

function scopeFor(name: McpTool): Scope {
  if (name === "create_work_item") return "acs:work:create";
  if (name === "get_work_item" || name === "list_work_items") return "acs:work:read";
  return "acs:work:approve";
}

function mcpDefinitions() {
  return mcpTools.map((name) => ({
    name,
    description: description(name),
    inputSchema: z.toJSONSchema(schemaFor(name)),
    annotations: name === "get_work_item" || name === "list_work_items"
      ? { readOnlyHint: true, destructiveHint: false, openWorldHint: false }
      : { readOnlyHint: false, destructiveHint: name === "reject_work_item" || name === "cancel_work_item", openWorldHint: false }
  }));
}

function schemaFor(name: McpTool): z.ZodType {
  if (name === "create_work_item") return hostedCreateWorkItemSchema;
  if (name === "get_work_item" || name === "unblock_work_item") return idSchema;
  if (name === "list_work_items") return hostedListWorkItemsSchema;
  return z.object({ id: z.string().min(1), reason: z.string().min(1).max(2_000).optional() }).strict();
}

function description(name: McpTool): string {
  const values: Record<McpTool, string> = {
    create_work_item: "Create an OAuth-attributed governed work item and evaluate it through ACS admission policy.",
    get_work_item: "Read one governed work item from the hosted ACS control plane.",
    list_work_items: "List hosted ACS work items, optionally filtered by status.",
    unblock_work_item: "Re-evaluate one blocked work item through ACS admission policy.",
    reject_work_item: "Reject a work item through an explicit terminal state.",
    cancel_work_item: "Cancel a work item through an explicit terminal state."
  };
  return values[name];
}

function rpcError(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : { result: value };
}

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
