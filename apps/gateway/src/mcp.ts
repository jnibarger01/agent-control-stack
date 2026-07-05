import type { IncomingHttpHeaders } from "node:http";
import { type createWorkItemTools, workItemToolNames } from "@agent-control-stack/policy-gate";
import { ControlStackError } from "@agent-control-stack/shared";
import { ZodError, z } from "zod";

const MCP_PROTOCOL_VERSION = "2024-11-05";

type GatewayWorkItemTools = ReturnType<typeof createWorkItemTools>;
type GatewayToolName = (typeof workItemToolNames)[number];
type JsonRpcId = string | number | null;

type JsonRpcSuccess = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: unknown;
};

type JsonRpcFailure = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
};

export type McpHttpResult = {
  statusCode: number;
  body: JsonRpcSuccess | JsonRpcFailure;
};

const jsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).default(null),
  method: z.string().min(1),
  params: z.unknown().optional()
});

const toolsCallParamsSchema = z.object({
  name: z.enum(workItemToolNames),
  arguments: z.unknown().optional()
});

export function handleMcpHttpRequest(input: {
  body: unknown;
  headers: IncomingHttpHeaders;
  tools: GatewayWorkItemTools;
  bearerToken?: string;
}): McpHttpResult {
  const request = jsonRpcRequestSchema.safeParse(input.body);
  if (!request.success) {
    return jsonRpcError(null, -32600, "invalid JSON-RPC request", 400);
  }

  switch (request.data.method) {
    case "initialize":
      return jsonRpcResult(request.data.id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: {
          name: "agent-control-stack-gateway",
          version: "0.1.0"
        }
      });
    case "tools/list":
      return jsonRpcResult(request.data.id, { tools: mcpToolDefinitions() });
    case "tools/call":
      return handleToolsCall({
        id: request.data.id,
        params: request.data.params,
        headers: input.headers,
        bearerToken: input.bearerToken,
        tools: input.tools
      });
    default:
      return jsonRpcError(request.data.id, -32601, `unsupported MCP method: ${request.data.method}`, 404);
  }
}

function handleToolsCall(input: {
  id: JsonRpcId;
  params: unknown;
  headers: IncomingHttpHeaders;
  bearerToken?: string;
  tools: GatewayWorkItemTools;
}): McpHttpResult {
  if (!isAuthorized(input.headers.authorization, input.bearerToken)) {
    return jsonRpcError(input.id, -32001, "unauthorized MCP tools/call request", 401);
  }

  const parsed = toolsCallParamsSchema.safeParse(input.params);
  if (!parsed.success) {
    return jsonRpcError(input.id, -32602, "invalid tools/call params", 400);
  }

  try {
    const result = callGatewayTool(input.tools, parsed.data.name, parsed.data.arguments ?? {});
    return jsonRpcResult(input.id, {
      content: [
        {
          type: "text",
          text: `${parsed.data.name} completed through the gateway work-item path.`
        }
      ],
      structuredContent: result
    });
  } catch (error) {
    return jsonRpcError(input.id, errorCode(error), errorMessage(error), errorStatus(error));
  }
}

function callGatewayTool(tools: GatewayWorkItemTools, name: GatewayToolName, args: unknown): unknown {
  const handler = tools[name] as (input: unknown) => unknown;
  return handler(args);
}

function isAuthorized(authorization: string | undefined, bearerToken: string | undefined): boolean {
  return Boolean(bearerToken) && authorization === `Bearer ${bearerToken}`;
}

function mcpToolDefinitions() {
  return workItemToolNames.map((name) => ({
    name,
    description: toolDescription(name),
    inputSchema: toolInputSchema(name)
  }));
}

function toolDescription(name: GatewayToolName): string {
  switch (name) {
    case "create_work_item":
      return "Create a governed work item and immediately evaluate it through the policy gate.";
    case "get_work_item":
      return "Read one work item by id.";
    case "list_work_items":
      return "List work items, optionally filtered by status.";
    case "approve_work_item":
      return "Record user approval for the exact policy-evaluated action hash on a work item.";
    case "unblock_work_item":
      return "Move a blocked work item back to pending policy evaluation.";
    case "cancel_work_item":
      return "Cancel a work item through the work-item state machine.";
    case "claim_next_approved_work_item":
      return "Claim the next approved work item through the lease-bound worker path.";
    case "submit_work_result":
      return "Submit a worker result with matching worker id and lease token.";
  }
}

function toolInputSchema(name: GatewayToolName): Record<string, unknown> {
  switch (name) {
    case "create_work_item":
      return {
        type: "object",
        required: ["title", "requester", "intent"],
        properties: {
          title: { type: "string" },
          requester: { type: "string", enum: ["user", "agent", "system"] },
          status: { type: "string", enum: ["draft", "pending_policy"] },
          intent: { type: "string" },
          target: { type: "object" },
          requestedActions: { type: "array", items: { type: "object" } },
          risk: { type: "string", enum: ["low", "medium", "high", "critical"] }
        }
      };
    case "list_work_items":
      return {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["draft", "pending_policy", "needs_approval", "approved", "running", "succeeded", "failed", "blocked", "cancelled"]
          }
        }
      };
    case "approve_work_item":
      return {
        type: "object",
        required: ["id", "approvedBy", "reason"],
        properties: {
          id: { type: "string" },
          approvedBy: { type: "string" },
          reason: { type: "string" },
          actionHash: { type: "string" }
        }
      };
    case "cancel_work_item":
      return {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" },
          actor: { type: "string" },
          reason: { type: "string" }
        }
      };
    case "claim_next_approved_work_item":
      return {
        type: "object",
        required: ["workerId"],
        properties: {
          workerId: { type: "string" },
          leaseMs: { type: "number" }
        }
      };
    case "submit_work_result":
      return {
        type: "object",
        required: ["id", "workerId", "leaseToken", "status"],
        properties: {
          id: { type: "string" },
          workerId: { type: "string" },
          leaseToken: { type: "string" },
          status: { type: "string", enum: ["succeeded", "failed", "blocked"] },
          result: { type: "object" }
        }
      };
    case "get_work_item":
    case "unblock_work_item":
      return {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" },
          actor: { type: "string" }
        }
      };
  }
}

function jsonRpcResult(id: JsonRpcId, result: unknown, statusCode = 200): McpHttpResult {
  return { statusCode, body: { jsonrpc: "2.0", id, result } };
}

function jsonRpcError(id: JsonRpcId, code: number, message: string, statusCode: number, data?: unknown): McpHttpResult {
  return {
    statusCode,
    body: {
      jsonrpc: "2.0",
      id,
      error: {
        code,
        message,
        ...(data === undefined ? {} : { data })
      }
    }
  };
}

function errorCode(error: unknown): number {
  if (error instanceof ZodError) return -32602;
  if (error instanceof ControlStackError) return -32000;
  return -32603;
}

function errorStatus(error: unknown): number {
  if (error instanceof ZodError) return 400;
  if (error instanceof ControlStackError) return error.code === "work_item_not_found" ? 404 : 409;
  return 500;
}

function errorMessage(error: unknown): string {
  if (error instanceof ZodError) return "invalid tool arguments";
  if (error instanceof Error) return error.message;
  return "MCP tool call failed";
}
