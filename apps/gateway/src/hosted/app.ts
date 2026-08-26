import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";
import { jsonRpcRequestSchema, MCP_PROTOCOL_VERSION } from "../public-contracts.js";
import { loadHostedGatewayConfig, type HostedGatewayConfig } from "./config.js";
import {
  HostedPostgresStore,
  hostedApprovalSchema,
  hostedClaimSchema,
  hostedCreateWorkItemSchema,
  hostedListWorkItemsSchema,
  hostedReasonSchema,
  type HostedClaim
} from "./postgres-store.js";
import {
  authorizeHostedRequest,
  hostedWwwAuthenticate,
  type HostedAuthorizationResult,
  type HostedIdentity
} from "./oauth.js";

const HOSTED_SCOPES = [
  "acs:work:create",
  "acs:work:read",
  "acs:work:approve",
  "acs:worker:claim",
  "acs:worker:result"
] as const;
type HostedScope = (typeof HOSTED_SCOPES)[number];

const idSchema = z.object({ id: z.string().min(1) }).strict();
const hostedMcpToolNames = [
  "create_work_item",
  "get_work_item",
  "list_work_items",
  "unblock_work_item",
  "reject_work_item",
  "cancel_work_item"
] as const;
type HostedMcpToolName = (typeof hostedMcpToolNames)[number];
const toolsCallSchema = z.object({ name: z.enum(hostedMcpToolNames), arguments: z.unknown().optional() }).strict();

export interface HostedStore {
  migrate(): Promise<void>;
  health(): Promise<{ ok: boolean; auditSequence: number }>;
  create(input: unknown, subject: string): Promise<unknown>;
  get(id: string): Promise<unknown | undefined>;
  list(input?: unknown): Promise<unknown[]>;
  countPending(): Promise<number>;
  approve(id: string, input: unknown, subject: string): Promise<unknown>;
  terminalTransition(id: string, operation: "cancel" | "reject", input: unknown, subject: string): Promise<unknown>;
  unblock(id: string, subject: string): Promise<unknown>;
  claim(input: unknown, workerId: string): Promise<HostedClaim | undefined>;
  submitResult(input: unknown, workerId: string, leaseToken: string): Promise<unknown>;
  auditEvents(workItemId: string, limit?: number): Promise<unknown[]>;
}

export interface BuildHostedGatewayOptions {
  readonly config?: HostedGatewayConfig;
  readonly store?: HostedStore;
  readonly authorize?: (
    request: FastifyRequest,
    config: HostedGatewayConfig,
    scopes: readonly string[]
  ) => Promise<HostedAuthorizationResult>;
  readonly logger?: boolean;
}

export async function buildHostedGateway(options: BuildHostedGatewayOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadHostedGatewayConfig();
  const store = options.store ?? new HostedPostgresStore(config);
  const authorize = options.authorize ?? ((request, cfg, scopes) => authorizeHostedRequest(request.headers, cfg, scopes));
  await store.migrate();

  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 256 * 1024, trustProxy: true });

  app.get("/livez", async () => ({ ok: true, runtime: "vercel-neon" }));
  app.get("/readyz", async (_request, reply) => {
    try {
      const health = await store.health();
      return health.ok ? { ok: true, storage: "postgres", ...health } : reply.code(503).send({ ok: false });
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });
  app.get("/health", async (_request, reply) => {
    try {
      const health = await store.health();
      return health.ok ? { ok: true, storage: "postgres", ...health } : reply.code(503).send({ ok: false });
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });

  const protectedResource = {
    resource: config.oauthAudience,
    resource_name: "Agent Control Stack MCP Gateway",
    authorization_servers: [config.oauthIssuer],
    scopes_supported: [...HOSTED_SCOPES],
    bearer_methods_supported: ["header"]
  };
  app.get("/.well-known/oauth-protected-resource", async () => protectedResource);
  app.get("/.well-known/oauth-protected-resource/mcp", async () => protectedResource);

  app.post("/mcp", async (request, reply) => {
    const rpc = jsonRpcRequestSchema.safeParse(request.body);
    if (!rpc.success) return reply.code(400).send(jsonRpcError(null, -32600, "invalid JSON-RPC request"));
    const { id, method, params } = rpc.data;

    if (method.startsWith("notifications/")) {
      const auth = await authorize(request, config, []);
      if (!auth.ok) return sendAuthorizationError(reply, config, auth);
      return reply.code(202).send();
    }

    if (method === "initialize" || method === "ping" || method === "tools/list") {
      const auth = await authorize(request, config, []);
      if (!auth.ok) return sendAuthorizationError(reply, config, auth);
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
      if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
      return { jsonrpc: "2.0", id, result: { tools: hostedMcpToolDefinitions() } };
    }

    if (method !== "tools/call") return reply.code(404).send(jsonRpcError(id, -32601, "method not found"));
    const call = toolsCallSchema.safeParse(params);
    if (!call.success) return reply.code(400).send(jsonRpcError(id, -32602, "invalid tools/call params"));
    const required = requiredScope(call.data.name);
    const auth = await authorize(request, config, [required]);
    if (!auth.ok) return sendAuthorizationError(reply, config, auth);

    try {
      const result = await callHostedTool(store, config, call.data.name, call.data.arguments ?? {}, auth.identity);
      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: `${call.data.name} completed through the hosted ACS gateway.` }],
          structuredContent: asObject(result)
        }
      };
    } catch (error) {
      const mapped = mapDomainError(error);
      return reply.code(mapped.status).send(jsonRpcError(id, mapped.rpcCode, mapped.message));
    }
  });

  app.get("/work-items", async (request, reply) => {
    const auth = await authorize(request, config, ["acs:work:read"]);
    if (!auth.ok) return sendAuthorizationError(reply, config, auth);
    const query = hostedListWorkItemsSchema.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "invalid_request" });
    return { workItems: await store.list(query.data) };
  });

  app.post("/work-items", async (request, reply) => {
    const auth = await authorize(request, config, ["acs:work:create"]);
    if (!auth.ok) return sendAuthorizationError(reply, config, auth);
    if ((await store.countPending()) >= config.maxPendingWorkItems) {
      return reply.code(429).send({ error: "pending_work_item_limit_reached" });
    }
    const parsed = hostedCreateWorkItemSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
    try {
      return reply.code(201).send(await store.create(parsed.data, auth.identity.subject));
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/work-items/:id", async (request, reply) => {
    const auth = await authorize(request, config, ["acs:work:read"]);
    if (!auth.ok) return sendAuthorizationError(reply, config, auth);
    const parsed = idSchema.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const workItem = await store.get(parsed.data.id);
    return workItem ? { workItem } : reply.code(404).send({ error: "work_item_not_found" });
  });

  app.post<{ Params: { id: string } }>("/work-items/:id/approve", async (request, reply) => {
    const auth = await authorize(request, config, ["acs:work:approve"]);
    if (!auth.ok) return sendAuthorizationError(reply, config, auth);
    const body = hostedApprovalSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "invalid_request", issues: body.error.issues });
    try {
      return { workItem: await store.approve(request.params.id, body.data, auth.identity.subject) };
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  for (const operation of ["cancel", "reject"] as const) {
    app.post<{ Params: { id: string } }>(`/work-items/:id/${operation}`, async (request, reply) => {
      const auth = await authorize(request, config, ["acs:work:approve"]);
      if (!auth.ok) return sendAuthorizationError(reply, config, auth);
      const body = hostedReasonSchema.safeParse(request.body ?? {});
      if (!body.success) return reply.code(400).send({ error: "invalid_request", issues: body.error.issues });
      try {
        return { workItem: await store.terminalTransition(request.params.id, operation, body.data, auth.identity.subject) };
      } catch (error) {
        return sendDomainError(reply, error);
      }
    });
  }

  app.post<{ Params: { id: string } }>("/work-items/:id/unblock", async (request, reply) => {
    const auth = await authorize(request, config, ["acs:work:approve"]);
    if (!auth.ok) return sendAuthorizationError(reply, config, auth);
    try {
      return { workItem: await store.unblock(request.params.id, auth.identity.subject) };
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: number } }>("/work-items/:id/audit", async (request, reply) => {
    const auth = await authorize(request, config, ["acs:work:read"]);
    if (!auth.ok) return sendAuthorizationError(reply, config, auth);
    return { events: await store.auditEvents(request.params.id, Number(request.query.limit ?? 100)) };
  });

  app.post("/worker/claim", async (request, reply) => {
    const auth = await authorize(request, config, ["acs:worker:claim"]);
    if (!auth.ok) return sendAuthorizationError(reply, config, auth);
    const body = hostedClaimSchema.safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid_request", issues: body.error.issues });
    try {
      const claim = await store.claim(body.data, auth.identity.subject);
      return claim ? { claim } : reply.code(204).send();
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  app.post("/worker/results", async (request, reply) => {
    const auth = await authorize(request, config, ["acs:worker:result"]);
    if (!auth.ok) return sendAuthorizationError(reply, config, auth);
    const leaseToken = singleHeader(request.headers["x-acs-lease-token"]);
    if (!leaseToken) return reply.code(401).send({ error: "missing_lease_token" });
    try {
      const workItem = await store.submitResult(request.body, auth.identity.subject, leaseToken);
      return reply.code(201).send({ workItem });
    } catch (error) {
      return sendDomainError(reply, error);
    }
  });

  return app;
}

async function callHostedTool(
  store: HostedStore,
  config: HostedGatewayConfig,
  name: HostedMcpToolName,
  args: unknown,
  identity: HostedIdentity
): Promise<unknown> {
  switch (name) {
    case "create_work_item":
      if ((await store.countPending()) >= config.maxPendingWorkItems) throw new Error("pending_work_item_limit_reached");
      return store.create(args, identity.subject);
    case "get_work_item": {
      const { id } = idSchema.parse(args);
      const item = await store.get(id);
      if (!item) throw new Error("work_item_not_found");
      return item;
    }
    case "list_work_items":
      return { workItems: await store.list(args) };
    case "unblock_work_item": {
      const { id } = idSchema.parse(args);
      return store.unblock(id, identity.subject);
    }
    case "reject_work_item": {
      const { id, ...body } = z.object({ id: z.string().min(1), reason: z.string().min(1).max(2_000).optional() }).parse(args);
      return store.terminalTransition(id, "reject", body, identity.subject);
    }
    case "cancel_work_item": {
      const { id, ...body } = z.object({ id: z.string().min(1), reason: z.string().min(1).max(2_000).optional() }).parse(args);
      return store.terminalTransition(id, "cancel", body, identity.subject);
    }
  }
}

function hostedMcpToolDefinitions(): unknown[] {
  return hostedMcpToolNames.map((name) => ({
    name,
    description: toolDescription(name),
    inputSchema: z.toJSONSchema(toolSchema(name)),
    annotations: toolAnnotations(name)
  }));
}

function toolSchema(name: HostedMcpToolName): z.ZodType {
  switch (name) {
    case "create_work_item":
      return hostedCreateWorkItemSchema;
    case "get_work_item":
    case "unblock_work_item":
      return idSchema;
    case "list_work_items":
      return hostedListWorkItemsSchema;
    case "reject_work_item":
    case "cancel_work_item":
      return z.object({ id: z.string().min(1), reason: z.string().min(1).max(2_000).optional() }).strict();
  }
}

function requiredScope(name: HostedMcpToolName): HostedScope {
  switch (name) {
    case "create_work_item":
      return "acs:work:create";
    case "get_work_item":
    case "list_work_items":
      return "acs:work:read";
    case "unblock_work_item":
    case "reject_work_item":
    case "cancel_work_item":
      return "acs:work:approve";
  }
}

function toolDescription(name: HostedMcpToolName): string {
  switch (name) {
    case "create_work_item":
      return "Create an OAuth-attributed governed work item and evaluate it through ACS policy.";
    case "get_work_item":
      return "Read one governed work item from the hosted ACS control plane.";
    case "list_work_items":
      return "List hosted ACS work items, optionally filtered by status.";
    case "unblock_work_item":
      return "Re-evaluate one blocked work item through ACS policy.";
    case "reject_work_item":
      return "Reject a work item through an explicit terminal state.";
    case "cancel_work_item":
      return "Cancel a work item through an explicit terminal state.";
  }
}

function toolAnnotations(name: HostedMcpToolName): Record<string, boolean> {
  if (name === "get_work_item" || name === "list_work_items") {
    return { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
  }
  return {
    readOnlyHint: false,
    destructiveHint: name === "reject_work_item" || name === "cancel_work_item",
    openWorldHint: false
  };
}

function sendAuthorizationError(
  reply: { code(status: number): { header(name: string, value: string): { send(body: unknown): unknown } } },
  config: HostedGatewayConfig,
  auth: Exclude<HostedAuthorizationResult, { ok: true }>
): unknown {
  return reply
    .code(auth.statusCode)
    .header("WWW-Authenticate", hostedWwwAuthenticate(config, auth))
    .send({ error: auth.error, error_description: auth.message });
}

function sendDomainError(
  reply: { code(status: number): { send(body: unknown): unknown } },
  error: unknown
): unknown {
  const mapped = mapDomainError(error);
  return reply.code(mapped.status).send({ error: mapped.message });
}

function mapDomainError(error: unknown): { status: number; rpcCode: number; message: string } {
  const message = error instanceof Error ? error.message : "internal_error";
  if (message === "work_item_not_found" || message === "lease_not_found") return { status: 404, rpcCode: -32004, message };
  if (message === "pending_work_item_limit_reached") return { status: 429, rpcCode: -32029, message };
  if (
    message.includes("mismatch") ||
    message.includes("terminal") ||
    message.includes("not_running") ||
    message.includes("not_blocked") ||
    message.includes("not_awaiting") ||
    message.includes("already_completed") ||
    message === "lease_expired"
  ) {
    return { status: 409, rpcCode: -32009, message };
  }
  if (error instanceof z.ZodError) return { status: 400, rpcCode: -32602, message: "invalid_request" };
  return { status: 500, rpcCode: -32603, message: "internal_error" };
}

function jsonRpcError(id: string | number | null, code: number, message: string): unknown {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return { result: value };
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
