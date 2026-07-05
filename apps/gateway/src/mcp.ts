import { ControlStackError } from "@agent-control-stack/shared";
import { ZodError } from "zod";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { createGatewayWorkItemTools } from "./tools/work-items.js";

const protocolVersion = "2024-11-05";
const serverInfo = { name: "agent-control-stack-gateway", version: "0.1.0" };
const mutationTools = new Set([
  "create_work_item",
  "approve_work_item",
  "unblock_work_item",
  "cancel_work_item",
  "submit_work_result"
]);

export type GatewayWorkItemTools = ReturnType<typeof createGatewayWorkItemTools>;
export type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

interface McpToolDefinition {
  name: keyof GatewayWorkItemTools & string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export function registerMcpRoutes(app: FastifyInstance, tools: GatewayWorkItemTools): void {
  app.get("/mcp", async (request, reply) => {
    if (!isAllowedOrigin(request)) {
      return sendJsonRpcError(reply, null, -32002, "origin not allowed", 403);
    }
    return reply.header("allow", "POST").code(405).send({ error: "SSE transport not implemented" });
  });

  app.post("/mcp", async (request, reply) => {
    if (!isAllowedOrigin(request)) {
      return sendJsonRpcError(reply, null, -32002, "origin not allowed", 403);
    }

    const parsed = parseJsonRpcRequest(request.body);
    if (!parsed.ok) {
      return sendJsonRpcError(reply, parsed.id, -32600, "invalid request", 400);
    }

    const rpc = parsed.request;
    const rpcId = rpc.id;
    if (rpc.method === "notifications/initialized" && rpcId === undefined) {
      return reply.code(202).send();
    }
    if (rpcId === undefined) {
      return sendJsonRpcError(reply, null, -32600, "invalid request", 400);
    }

    switch (rpc.method) {
      case "initialize":
        return sendJsonRpcResult(reply, rpcId, {
          protocolVersion: requestedProtocolVersion(rpc.params),
          capabilities: { tools: {} },
          serverInfo
        });
      case "tools/list":
        return sendJsonRpcResult(reply, rpcId, { tools: mcpTools });
      case "tools/call":
        return handleToolCall(request, reply, rpc, rpcId, tools);
      default:
        return sendJsonRpcError(reply, rpcId, -32601, "method not found", 200);
    }
  });
}

export function isMcpJsonParseError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "statusCode" in error &&
    (error as { statusCode?: number }).statusCode === 400 &&
    "code" in error &&
    String((error as { code?: unknown }).code).includes("FST_ERR_CTP")
  );
}

export function sendMcpParseError(reply: FastifyReply) {
  return sendJsonRpcError(reply, null, -32700, "parse error", 400);
}

async function handleToolCall(
  request: FastifyRequest,
  reply: FastifyReply,
  rpc: JsonRpcRequest,
  id: JsonRpcId,
  tools: GatewayWorkItemTools
) {
  const params = parseToolCallParams(rpc.params);
  if (!params.ok) {
    return sendJsonRpcError(reply, id, -32602, params.message, 200);
  }

  const tool = tools[params.name];
  if (typeof tool !== "function") {
    return sendJsonRpcError(reply, id, -32602, "invalid tool name", 200);
  }
  if (mutationTools.has(params.name) && !hasMutationBearer(request)) {
    return sendJsonRpcError(reply, id, -32001, "mutation requires bearer token", 401);
  }

  try {
    const result = tool(params.arguments);
    return sendJsonRpcResult(reply, id, {
      content: [{ type: "text", text: stringifyToolResult(result) }],
      isError: false
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return sendJsonRpcError(reply, id, -32602, "invalid params", 200);
    }
    if (error instanceof ControlStackError) {
      return sendJsonRpcError(reply, id, -32000, safeControlError(error), 200);
    }
    return sendJsonRpcError(reply, id, -32603, "internal error", 500);
  }
}

function parseJsonRpcRequest(body: unknown): { ok: true; request: JsonRpcRequest } | { ok: false; id: JsonRpcId } {
  if (!isRecord(body) || Array.isArray(body)) {
    return { ok: false, id: null };
  }
  const id = parseJsonRpcId(body.id);
  if (body.id !== undefined && id === undefined) {
    return { ok: false, id: null };
  }
  if (body.jsonrpc !== "2.0" || typeof body.method !== "string" || body.method.length === 0) {
    return { ok: false, id: id ?? null };
  }
  return {
    ok: true,
    request: {
      jsonrpc: "2.0",
      id,
      method: body.method,
      params: body.params
    }
  };
}

function parseToolCallParams(
  params: unknown
): { ok: true; name: keyof GatewayWorkItemTools & string; arguments: unknown } | { ok: false; message: string } {
  if (!isRecord(params) || typeof params.name !== "string") {
    return { ok: false, message: "invalid tool call params" };
  }
  if (!isMcpToolName(params.name)) {
    return { ok: false, message: "invalid tool name" };
  }
  return { ok: true, name: params.name, arguments: params.arguments ?? {} };
}

function parseJsonRpcId(value: unknown): JsonRpcId | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return undefined;
}

function requestedProtocolVersion(params: unknown): string {
  if (isRecord(params) && typeof params.protocolVersion === "string" && params.protocolVersion.length > 0) {
    return params.protocolVersion;
  }
  return protocolVersion;
}

function sendJsonRpcResult(reply: FastifyReply, id: JsonRpcId, result: unknown) {
  return reply.code(200).send({ jsonrpc: "2.0", id, result });
}

function sendJsonRpcError(reply: FastifyReply, id: JsonRpcId, code: number, message: string, httpStatus: number) {
  return reply.code(httpStatus).send({ jsonrpc: "2.0", id, error: { code, message } });
}

function isAllowedOrigin(request: FastifyRequest): boolean {
  const origin = headerValue(request.headers.origin);
  if (!origin) {
    return true;
  }
  return allowedOrigins().has(origin);
}

function allowedOrigins(): Set<string> {
  const raw = process.env.ACS_MCP_ALLOWED_ORIGINS;
  const origins = raw
    ? raw.split(",").map((origin) => origin.trim()).filter(Boolean)
    : ["http://127.0.0.1:3000", "http://localhost:3000"];
  return new Set(origins.filter((origin) => origin !== "*"));
}

function hasMutationBearer(request: FastifyRequest): boolean {
  const expected = process.env.ACS_GATEWAY_TOKEN;
  const authorization = headerValue(request.headers.authorization);
  return Boolean(expected) && authorization === `Bearer ${expected}`;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMcpToolName(name: string): name is keyof GatewayWorkItemTools & string {
  return mcpTools.some((tool) => tool.name === name);
}

function stringifyToolResult(result: unknown): string {
  return JSON.stringify(result ?? null, null, 2) ?? "null";
}

function safeControlError(error: ControlStackError): string {
  return error.code === "policy_required" ? "policy required" : error.message;
}

const actionRequestSchema = {
  type: "object",
  required: ["kind", "description"],
  additionalProperties: false,
  properties: {
    kind: { type: "string" },
    description: { type: "string" },
    params: { type: "object", additionalProperties: true }
  }
};

const targetSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    repo: { type: "string" },
    cwd: { type: "string" },
    files: { type: "array", items: { type: "string" } },
    services: { type: "array", items: { type: "string" } }
  }
};

const createWorkItemInputSchema = {
  type: "object",
  required: ["title", "requester", "intent"],
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    requester: { enum: ["user", "agent", "system"] },
    status: { enum: ["draft", "pending_policy"] },
    intent: { type: "string" },
    target: targetSchema,
    requestedActions: { type: "array", items: actionRequestSchema },
    risk: { enum: ["low", "medium", "high", "critical"] }
  }
};

const idInputSchema = {
  type: "object",
  required: ["id"],
  additionalProperties: false,
  properties: { id: { type: "string" } }
};

export const mcpTools: McpToolDefinition[] = [
  {
    name: "create_work_item",
    description: "Create a work item and run the existing policy-aware control-plane admission path.",
    inputSchema: createWorkItemInputSchema
  },
  {
    name: "get_work_item",
    description: "Fetch one work item by id.",
    inputSchema: idInputSchema
  },
  {
    name: "list_work_items",
    description: "List work items, optionally filtered by status.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        status: {
          enum: ["draft", "pending_policy", "needs_approval", "approved", "running", "succeeded", "failed", "blocked", "cancelled"]
        }
      }
    }
  },
  {
    name: "approve_work_item",
    description: "Approve a work item action through the existing policy-aware approval path.",
    inputSchema: {
      type: "object",
      required: ["id", "approvedBy"],
      additionalProperties: false,
      properties: {
        id: { type: "string" },
        approvedBy: { type: "string" },
        reason: { type: "string" }
      }
    }
  },
  {
    name: "unblock_work_item",
    description: "Move a blocked work item back to pending policy review.",
    inputSchema: idInputSchema
  },
  {
    name: "cancel_work_item",
    description: "Cancel a work item.",
    inputSchema: {
      type: "object",
      required: ["id"],
      additionalProperties: false,
      properties: { id: { type: "string" }, reason: { type: "string" } }
    }
  },
  {
    name: "submit_work_result",
    description: "Submit a worker result through the existing policy-aware result path.",
    inputSchema: {
      type: "object",
      required: ["id", "status"],
      additionalProperties: false,
      properties: {
        id: { type: "string" },
        status: { enum: ["succeeded", "failed", "blocked"] },
        result: { type: "object", additionalProperties: true }
      }
    }
  }
];
