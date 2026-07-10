import type { ServerResponse } from "node:http";
import { renderDashboard } from "@agent-control-stack/control-ui";
import { ControlStackError } from "@agent-control-stack/shared";
import {
  cancelRequestSchema,
  createWorkItemSchema,
  SqliteWorkItemStore,
  type StoredAuditEvent,
  submitWorkResultSchema
} from "@agent-control-stack/work-items";
import { z, ZodError } from "zod";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { createGatewayWorkItemTools, workItemToolNames } from "./tools/work-items.js";

const mcpProtocolVersion = "2025-06-18";
const mutatingTools = new Set<(typeof workItemToolNames)[number]>([
  "create_work_item",
  "approve_work_item",
  "unblock_work_item",
  "cancel_work_item",
  "submit_work_result"
]);

const approvalBodySchema = z.object({
  reason: z.string().min(1).optional()
});
const jsonRpcIdSchema = z.union([z.string(), z.number(), z.null()]);
const jsonRpcRequestSchema = z
  .object({
    jsonrpc: z.literal("2.0"),
    id: jsonRpcIdSchema.optional(),
    method: z.string().min(1),
    params: z.unknown().optional()
  })
  .strict();
const toolsCallParamsSchema = z.object({
  name: z.enum(workItemToolNames),
  arguments: z.record(z.string(), z.unknown()).default({})
});

type JsonRpcId = z.infer<typeof jsonRpcIdSchema>;
type WorkItemToolName = (typeof workItemToolNames)[number];
type GatewayTools = ReturnType<typeof createGatewayWorkItemTools>;

export interface GatewayAuthOptions {
  token: string;
  actor: string;
}

export interface GatewayOptions {
  dbPath?: string;
  logger?: boolean;
  auth?: GatewayAuthOptions;
}

export function buildGateway(options: GatewayOptions = {}): FastifyInstance {
  const dbPath = options.dbPath ?? process.env.ACS_DB_PATH ?? "storage/local.db";
  const app = Fastify({ logger: options.logger ?? true });
  const sseClients = new Set<ServerResponse>();
  const workItems = new SqliteWorkItemStore(dbPath, { onEvent: broadcast });
  const tools = createGatewayWorkItemTools(workItems);
  const auth = resolveAuth(options);

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

  app.setErrorHandler((error, _request, reply) => {
    const statusCode = typeof error === "object" && error && "statusCode" in error ? Number(error.statusCode) : undefined;
    if (statusCode === 400) {
      return reply.code(400).send({ error: "invalid request" });
    }
    throw error;
  });

  app.get("/health", async () => ({ ok: true }));

  app.get("/", async (_request, reply) => {
    reply.type("text/html").send(renderDashboard(workItems.list()));
  });

  app.get("/mcp/tools", async () => ({ tools: workItemToolNames }));

  app.get("/mcp", async (_request, reply) => reply.code(405).send({ error: "method not allowed" }));

  app.post("/mcp", async (request, reply) => {
    if (!isAllowedMcpOrigin(request.headers.origin)) {
      return reply.code(403).send({ error: "forbidden origin" });
    }

    const parsed = jsonRpcRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(jsonRpcError(null, -32600, "invalid request"));
    }

    const rpc = parsed.data;
    if (rpc.method === "notifications/initialized" && rpc.id === undefined) {
      return reply.code(202).send();
    }

    try {
      if (rpc.method === "initialize") {
        return jsonRpcResult(rpc.id, {
          protocolVersion: mcpProtocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "agent-control-stack-gateway", version: "0.1.0" }
        });
      }
      if (rpc.method === "notifications/initialized") {
        return jsonRpcResult(rpc.id, null);
      }
      if (rpc.method === "tools/list") {
        return jsonRpcResult(rpc.id, { tools: mcpToolDefinitions });
      }
      if (rpc.method === "tools/call") {
        const call = toolsCallParamsSchema.safeParse(rpc.params);
        if (!call.success) {
          return reply.code(400).send(jsonRpcError(rpc.id, -32602, "invalid params"));
        }

        const actor = mutatingTools.has(call.data.name) ? authorizeMutation(request, auth) : undefined;
        if (actor && !actor.ok) {
          return reply.code(actor.status).send(jsonRpcError(rpc.id, actor.code, actor.message));
        }

        const result = callTool(tools, call.data.name, prepareToolArguments(call.data.name, call.data.arguments, actor?.actor));
        return jsonRpcResult(rpc.id, { content: [{ type: "text", text: JSON.stringify(result) }] });
      }

      return jsonRpcError(rpc.id, -32601, "method not found");
    } catch (error) {
      return sendMcpError(reply, rpc.id, error);
    }
  });

  app.get("/work-items", async (request, reply) => {
    try {
      return { workItems: tools.list_work_items(request.query) };
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
      const approval = approvalBodySchema.parse(requestObject(request.body));
      const workItem = workItems.get(request.params.id);
      if (!workItem) {
        return reply.code(404).send({ error: "work item not found" });
      }

      const result = tools.approve_work_item({ id: workItem.id, approvedBy: actor, ...approval });
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
      const cancel = cancelRequestSchema.parse(requestObject(request.body));
      const cancelled = tools.cancel_work_item({ id: request.params.id, ...cancel });
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
      const unblocked = tools.unblock_work_item({ id: request.params.id });
      return { workItem: unblocked };
    } catch (error) {
      return sendError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/work-items/:id/results", async (request, reply) => {
    const actor = requireMutationActor(request, reply, auth);
    if (!actor) {
      return;
    }
    const body = request.body && typeof request.body === "object" ? (request.body as Record<string, unknown>) : {};
    const parsed = submitWorkResultSchema.safeParse({ ...body, id: request.params.id });
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid result request" });
    }

    try {
      const completed = tools.submit_work_result(parsed.data);
      return { workItem: completed };
    } catch (error) {
      return sendError(reply, error);
    }
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

const mcpToolDefinitions = workItemToolNames.map((name) => ({
  name,
  description: toolDescription(name),
  inputSchema: toolInputSchema(name)
}));

function toolDescription(name: WorkItemToolName): string {
  return {
    create_work_item: "Create a policy-gated work item.",
    get_work_item: "Read one work item by id.",
    list_work_items: "List work items, optionally filtered by status.",
    approve_work_item: "Approve a work item requiring approval.",
    unblock_work_item: "Retry policy routing for a blocked work item.",
    cancel_work_item: "Cancel a work item.",
    submit_work_result: "Submit a worker result for a running work item."
  }[name];
}

function toolInputSchema(name: WorkItemToolName): Record<string, unknown> {
  const id = { type: "string", minLength: 1 };
  const action = {
    type: "object",
    required: ["kind", "description"],
    properties: {
      kind: { type: "string", minLength: 1 },
      description: { type: "string", minLength: 1 },
      params: { type: "object", additionalProperties: true }
    },
    additionalProperties: false
  };

  if (name === "create_work_item") {
    return {
      type: "object",
      required: ["title", "intent"],
      properties: {
        title: { type: "string", minLength: 1 },
        intent: { type: "string", minLength: 1 },
        target: { type: "object", additionalProperties: true },
        requestedActions: { type: "array", items: action },
        risk: { type: "string", enum: ["low", "medium", "high", "critical"] }
      },
      additionalProperties: false
    };
  }
  if (name === "list_work_items") {
    return {
      type: "object",
      properties: { status: { type: "string", enum: ["draft", "pending_policy", "needs_approval", "approved", "running", "succeeded", "failed", "blocked", "cancelled"] } },
      additionalProperties: false
    };
  }
  if (name === "approve_work_item" || name === "cancel_work_item") {
    return {
      type: "object",
      required: ["id"],
      properties: { id, reason: { type: "string", minLength: 1 } },
      additionalProperties: false
    };
  }
  if (name === "submit_work_result") {
    return {
      type: "object",
      required: ["id", "status"],
      properties: {
        id,
        status: { type: "string", enum: ["succeeded", "failed", "blocked"] },
        result: { type: "object", additionalProperties: true }
      },
      additionalProperties: false
    };
  }
  return { type: "object", required: ["id"], properties: { id }, additionalProperties: false };
}

function callTool(tools: GatewayTools, name: WorkItemToolName, input: unknown): unknown {
  return tools[name](input);
}

function prepareToolArguments(name: WorkItemToolName, input: Record<string, unknown>, actor: string | undefined): unknown {
  if (name === "create_work_item") {
    return { ...input, requester: actor };
  }
  if (name === "approve_work_item") {
    return { ...input, approvedBy: actor };
  }
  return input;
}

function jsonRpcResult(id: JsonRpcId | undefined, result: unknown): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

function jsonRpcError(id: JsonRpcId | undefined, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

function sendMcpError(reply: FastifyReply, id: JsonRpcId | undefined, error: unknown) {
  if (error instanceof ZodError) {
    return reply.code(400).send(jsonRpcError(id, -32602, "invalid params"));
  }
  if (error instanceof ControlStackError) {
    return reply.code(error.code === "work_item_not_found" ? 404 : 409).send(jsonRpcError(id, -32000, error.message));
  }
  throw error;
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
  return token ? { token, actor: process.env.ACS_GATEWAY_ACTOR ?? "user" } : undefined;
}

function authorizeMutation(
  request: FastifyRequest,
  auth: GatewayAuthOptions | undefined
): { ok: true; actor: string } | { ok: false; status: number; code: number; message: string } {
  if (!auth) {
    return { ok: false, status: 503, code: -32001, message: "mutation auth is not configured" };
  }
  if (request.headers.authorization !== `Bearer ${auth.token}`) {
    return { ok: false, status: 401, code: -32001, message: "unauthorized" };
  }
  return { ok: true, actor: auth.actor };
}

function requireMutationActor(
  request: FastifyRequest,
  reply: FastifyReply,
  auth: GatewayAuthOptions | undefined
): string | undefined {
  const result = authorizeMutation(request, auth);
  if (!result.ok) {
    reply.code(result.status).send({ error: result.message });
    return undefined;
  }
  return result.actor;
}

function isAllowedMcpOrigin(origin: string | undefined): boolean {
  if (!origin) {
    return true;
  }
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

export async function startGateway(): Promise<FastifyInstance> {
  const app = buildGateway();
  await app.listen({
    host: process.env.HOST ?? "127.0.0.1",
    port: Number(process.env.PORT ?? 3000)
  });
  return app;
}
