import type { IncomingHttpHeaders } from "node:http";
import { connectorToolNames, type ConnectorToolHandler, type ConnectorToolName } from "./connector.js";
import { type createWorkItemTools, workItemToolNames } from "@agent-control-stack/policy-gate";
import { ControlStackError } from "@agent-control-stack/shared";
import { ZodError, z } from "zod";
import {
  authorizeMcpRequest,
  mcpAuthorizationHttpError,
  type McpAuthenticatedRequest,
  type McpAuthOptions,
  type McpScope
} from "./auth.js";

const MCP_PROTOCOL_VERSION = "2024-11-05";

type GatewayWorkItemTools = ReturnType<typeof createWorkItemTools>;
type GatewayTools = GatewayWorkItemTools & Partial<Record<ConnectorToolName, ConnectorToolHandler>>;
const mcpToolNames = [...workItemToolNames, ...connectorToolNames] as const;
type McpToolName = (typeof mcpToolNames)[number];
const remoteMcpToolNames = mcpToolNames.filter((name) => name !== "approve_work_item") as McpToolName[];
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

export interface AuthenticatedMcpRequestAudit {
  requestId: string;
  method: string;
  toolName?: string;
  workItemId?: string;
  resolvedActor: string;
  auth: McpAuthenticatedRequest;
}

export type McpHttpResult = {
  statusCode: number;
  body?: JsonRpcSuccess | JsonRpcFailure;
  wwwAuthenticate?: string;
};

const jsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).default(null),
  method: z.string().min(1),
  params: z.unknown().optional()
});

const toolsCallParamsSchema = z.object({
  name: z.enum(mcpToolNames),
  arguments: z.unknown().optional()
});

export async function handleMcpHttpRequest(input: {
  body: unknown;
  headers: IncomingHttpHeaders;
  tools: GatewayTools;
  auth?: McpAuthOptions;
  requireAuthentication?: boolean;
  resourceMetadataUrl?: string;
  requestId?: string;
  remoteAddress?: string;
  auditAuthenticatedRequest?: (event: AuthenticatedMcpRequestAudit) => void;
  resolveActorId?: (auth: McpAuthenticatedRequest) => string | undefined;
}): Promise<McpHttpResult> {
  const request = jsonRpcRequestSchema.safeParse(input.body);
  if (!request.success) {
    return jsonRpcError(null, -32600, "invalid JSON-RPC request", 400);
  }

  if (input.requireAuthentication && isDiscoveryMethod(request.data.method)) {
    const error = await authorizeDiscoveryMethod({
      id: request.data.id,
      headers: input.headers,
      auth: input.auth,
      resourceMetadataUrl: input.resourceMetadataUrl,
      remoteAddress: input.remoteAddress
    });
    if (error) {
      return error;
    }
  }

  if (request.data.method.startsWith("notifications/")) {
    return { statusCode: 202 };
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
    case "ping":
      return jsonRpcResult(request.data.id, {});
    case "tools/list":
      return jsonRpcResult(request.data.id, {
        tools: mcpToolDefinitions(Boolean(input.auth?.oauth))
      });
    case "resources/list":
      return jsonRpcResult(request.data.id, { resources: [] });
    case "tools/call":
      return handleToolsCall({
        id: request.data.id,
        requestId: input.requestId,
        params: request.data.params,
        headers: input.headers,
        auth: input.auth,
        resourceMetadataUrl: input.resourceMetadataUrl,
        tools: input.tools,
        remoteAddress: input.remoteAddress,
        auditAuthenticatedRequest: input.auditAuthenticatedRequest,
        resolveActorId: input.resolveActorId
      });
    default:
      return handleProtectedUnsupportedMethod({
        id: request.data.id,
        requestId: input.requestId,
        method: request.data.method,
        headers: input.headers,
        auth: input.auth,
        resourceMetadataUrl: input.resourceMetadataUrl,
        remoteAddress: input.remoteAddress,
        auditAuthenticatedRequest: input.auditAuthenticatedRequest
      });
  }
}

async function authorizeDiscoveryMethod(input: {
  id: JsonRpcId;
  headers: IncomingHttpHeaders;
  auth?: McpAuthOptions;
  resourceMetadataUrl?: string;
  remoteAddress?: string;
}): Promise<McpHttpResult | undefined> {
  const authorization = await authorizeMcpRequest({
    headers: input.headers,
    auth: input.auth,
    requiredScopes: [],
    remoteAddress: input.remoteAddress
  });
  return authorization.ok ? undefined : mcpAuthError(input.id, authorization, input.resourceMetadataUrl, []);
}

function isDiscoveryMethod(method: string): boolean {
  return (
    method === "initialize" ||
    method === "ping" ||
    method === "tools/list" ||
    method === "resources/list" ||
    method.startsWith("notifications/")
  );
}

async function handleToolsCall(input: {
  id: JsonRpcId;
  requestId?: string;
  params: unknown;
  headers: IncomingHttpHeaders;
  auth?: McpAuthOptions;
  resourceMetadataUrl?: string;
  tools: GatewayTools;
  remoteAddress?: string;
  auditAuthenticatedRequest?: (event: AuthenticatedMcpRequestAudit) => void;
  resolveActorId?: (auth: McpAuthenticatedRequest) => string | undefined;
}): Promise<McpHttpResult> {
  const parsed = toolsCallParamsSchema.safeParse(input.params);
  if (!parsed.success) {
    return jsonRpcError(input.id, -32602, "invalid tools/call params", 400);
  }

  const authorization = await authorizeMcpRequest({
    headers: input.headers,
    auth: input.auth,
    requiredScopes: requiredScopes(parsed.data.name),
    remoteAddress: input.remoteAddress
  });
  if (!authorization.ok) {
    return mcpAuthError(input.id, authorization, input.resourceMetadataUrl, requiredScopes(parsed.data.name));
  }

  if (parsed.data.name === "approve_work_item") {
    const actor = resolvedMcpActor(authorization.auth);
    input.auditAuthenticatedRequest?.({
      requestId: input.requestId ?? String(input.id ?? ""),
      method: "tools/call",
      toolName: parsed.data.name,
      resolvedActor: actor,
      auth: authorization.auth
    });
    return jsonRpcError(input.id, -32002, "MCP identities cannot grant approval", 403);
  }

  const actor =
    requiresRegistryActor(parsed.data.name) && input.resolveActorId
      ? input.resolveActorId(authorization.auth)
      : resolvedMcpActor(authorization.auth);
  if (!actor) {
    return jsonRpcError(input.id, -32001, "MCP actor is not registered", 403);
  }
  try {
    const result = await callMcpTool({
      tools: input.tools,
      name: parsed.data.name,
      args: parsed.data.arguments ?? {},
      auth: authorization.auth,
      actor
    });
    input.auditAuthenticatedRequest?.({
      requestId: input.requestId ?? String(input.id ?? ""),
      method: "tools/call",
      toolName: parsed.data.name,
      workItemId: workItemIdFromToolResult(result),
      resolvedActor: actor,
      auth: authorization.auth
    });
    return jsonRpcResult(input.id, {
      content: [
        {
          type: "text",
          text: `${parsed.data.name} completed through the gateway MCP path.`
        }
      ],
      structuredContent: asStructuredContent(result)
    });
  } catch (error) {
    input.auditAuthenticatedRequest?.({
      requestId: input.requestId ?? String(input.id ?? ""),
      method: "tools/call",
      toolName: parsed.data.name,
      resolvedActor: actor,
      auth: authorization.auth
    });
    return jsonRpcError(input.id, errorCode(error), errorMessage(error), errorStatus(error));
  }
}

function asStructuredContent(result: unknown): Record<string, unknown> {
  return result !== null && typeof result === "object" && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : { result };
}

async function handleProtectedUnsupportedMethod(input: {
  id: JsonRpcId;
  requestId?: string;
  method: string;
  headers: IncomingHttpHeaders;
  auth?: McpAuthOptions;
  resourceMetadataUrl?: string;
  remoteAddress?: string;
  auditAuthenticatedRequest?: (event: AuthenticatedMcpRequestAudit) => void;
}): Promise<McpHttpResult> {
  const authorization = await authorizeMcpRequest({
    headers: input.headers,
    auth: input.auth,
    requiredScopes: [],
    remoteAddress: input.remoteAddress
  });
  if (!authorization.ok) {
    return mcpAuthError(input.id, authorization, input.resourceMetadataUrl, []);
  }
  input.auditAuthenticatedRequest?.({
    requestId: input.requestId ?? String(input.id ?? ""),
    method: input.method,
    resolvedActor: resolvedMcpActor(authorization.auth),
    auth: authorization.auth
  });
  return jsonRpcError(input.id, -32601, `unsupported MCP method: ${input.method}`, 404);
}

async function callMcpTool(input: {
  tools: GatewayTools;
  name: McpToolName;
  args: unknown;
  auth: McpAuthenticatedRequest;
  actor: string;
}): Promise<unknown> {
  return callGatewayTool(input.tools, input.name, input.args, input.auth, input.actor);
}

function callGatewayTool(
  tools: GatewayTools,
  name: McpToolName,
  args: unknown,
  auth: McpAuthenticatedRequest,
  actor: string
): unknown {
  const handler = tools[name] as (input: unknown) => unknown;
  return handler(bindAuthenticatedActor(name, args, auth, actor));
}

function bindAuthenticatedActor(
  name: McpToolName,
  args: unknown,
  auth: McpAuthenticatedRequest,
  actor: string
): unknown {
  if (name === "create_work_item") {
    // MCP identities are agents; caller-supplied requester/requesterSubject are untrusted.
    return { ...requestObject(args), requester: "agent", requesterSubject: actor };
  }
  const record = requestObject(args);
  if (name === "approve_work_item") {
    return { ...record, approvedBy: actor };
  }
  if (name === "unblock_work_item" || name === "reject_work_item" || name === "cancel_work_item") {
    return { ...record, actor };
  }
  if (
    name === "work_item.create" ||
    name === "work_item.get" ||
    name === "work_item.approve" ||
    name === "work_item.reject" ||
    name === "work_item.cancel" ||
    name === "work_item.unblock" ||
    connectorToolNames.includes(name as ConnectorToolName)
  ) {
    return { ...record, actor };
  }
  return args;
}

function resolvedMcpActor(auth: McpAuthenticatedRequest): string {
  return auth.connectorId ?? auth.subject;
}

function requestObject(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
}

function workItemIdFromToolResult(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const record = result as Record<string, unknown>;
  if (typeof record.id === "string") return record.id;
  const workItem = record.workItem;
  if (workItem && typeof workItem === "object" && typeof (workItem as Record<string, unknown>).id === "string") {
    return (workItem as Record<string, string>).id;
  }
  return undefined;
}

function mcpToolDefinitions(advertiseOAuth: boolean) {
  const toolNames: McpToolName[] = [...remoteMcpToolNames];
  return toolNames.map((name) => {
    const securitySchemes = advertiseOAuth
      ? [{ type: "oauth2" as const, scopes: requiredScopes(name) }]
      : [{ type: "noauth" as const }];
    return {
      name,
      description: toolDescription(name),
      inputSchema: toolInputSchema(name),
      securitySchemes,
      _meta: { securitySchemes },
      annotations: toolAnnotations(name)
    };
  });
}

function requiredScopes(name: McpToolName): McpScope[] {
  switch (name) {
    case "create_work_item":
    case "work_item.create":
    case "command.preview":
    case "command.run":
    case "filesystem.read_text":
    case "filesystem.stat":
    case "agent.preview":
    case "agent.run":
    case "service.restart.preview":
    case "service.restart":
    case "config.change.preview":
    case "config.change":
    case "create_directory":
    case "edit_block":
    case "force_terminate":
    case "interact_with_process":
    case "kill_process":
    case "move_file":
    case "set_config_value":
    case "shutdown":
    case "start_process":
    case "write_file":
    case "write_pdf":
    case "get_file_info":
    case "list_directory":
    case "list_processes":
    case "read_file":
    case "read_multiple_files":
    case "read_process_output":
    case "start_search":
      return ["acs:work:create"];
    case "get_work_item":
    case "list_work_items":
    case "work_item.get":
    case "result.get":
    case "evidence.list":
    case "evidence.get":
    case "get_config":
    case "get_more_search_results":
    case "get_prompts":
    case "get_recent_tool_calls":
    case "get_usage_stats":
    case "give_feedback_to_desktop_commander":
    case "list_devices":
    case "list_searches":
    case "list_sessions":
    case "ping":
    case "who_am_i":
      return ["acs:work:read"];
    case "approve_work_item":
    case "unblock_work_item":
    case "reject_work_item":
    case "cancel_work_item":
    case "work_item.approve":
    case "work_item.reject":
    case "work_item.cancel":
    case "work_item.unblock":
    case "stop_search":
      return ["acs:work:approve"];
  }
}

function requiresRegistryActor(name: McpToolName): boolean {
  return name !== "get_work_item" && name !== "list_work_items";
}

function toolAnnotations(name: McpToolName): Record<string, boolean> {
  switch (name) {
    case "get_work_item":
    case "list_work_items":
    case "work_item.get":
    case "result.get":
    case "evidence.list":
    case "evidence.get":
    case "get_config":
    case "get_more_search_results":
    case "get_prompts":
    case "get_recent_tool_calls":
    case "get_usage_stats":
    case "give_feedback_to_desktop_commander":
    case "list_devices":
    case "list_searches":
    case "list_sessions":
    case "ping":
    case "who_am_i":
      return { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
    case "cancel_work_item":
    case "reject_work_item":
    case "work_item.cancel":
    case "work_item.reject":
    case "service.restart":
    case "config.change":
    case "create_directory":
    case "edit_block":
    case "force_terminate":
    case "interact_with_process":
    case "kill_process":
    case "move_file":
    case "set_config_value":
    case "shutdown":
    case "start_process":
    case "stop_search":
    case "write_file":
    case "write_pdf":
      return { readOnlyHint: false, destructiveHint: true, openWorldHint: false };
    default:
      return { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
  }
}

function toolDescription(name: McpToolName): string {
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
    case "reject_work_item":
      return "Reject a work item through a distinct terminal denial state.";
    case "cancel_work_item":
      return "Cancel a work item through the work-item state machine.";
    case "work_item.create":
      return "Create a work item with a registered ACS action and policy receipt.";
    case "work_item.get":
      return "Read a work item with policy, approval, lease, and evidence metadata.";
    case "work_item.approve":
      return "Approve an exact action hash; only a registered human actor may approve.";
    case "work_item.reject":
      return "Reject a governed work item.";
    case "work_item.cancel":
      return "Cancel a governed work item.";
    case "work_item.unblock":
      return "Return a blocked work item to policy evaluation.";
    case "command.preview":
      return "Preview a fixed, registered read-only diagnostic command through a work item.";
    case "command.run":
      return "Run a fixed, registered read-only diagnostic command through the worker.";
    case "filesystem.read_text":
      return "Read bounded redacted text from a named ACS filesystem root through the worker.";
    case "filesystem.stat":
      return "Read metadata for a file under a named ACS filesystem root through the worker.";
    case "agent.preview":
      return "Preview a bounded Codex read-only dispatch.";
    case "agent.run":
      return "Request a bounded Codex dispatch; execution remains approval- and worker-gated.";
    case "result.get":
      return "Read a governed work-item result.";
    case "evidence.list":
      return "List bounded evidence metadata for a work item.";
    case "evidence.get":
      return "Retrieve one bounded redacted evidence record and audit the access.";
    case "service.restart.preview":
      return "Preview a restart request for a registered ACS-owned service.";
    case "service.restart":
      return "Request an approval-gated restart for a registered ACS-owned service.";
    case "config.change.preview":
      return "Preview a structured change for a registered ACS config target.";
    case "config.change":
      return "Request an approval-gated structured change for a registered ACS config target.";
    case "create_directory":
      return "Request an approval-gated directory creation under the registered ACS filesystem root.";
    case "edit_block":
      return "Request an approval-gated exact find-and-replace edit under the registered ACS filesystem root.";
    case "force_terminate":
      return "Request approval to force-terminate a process previously started by ACS.";
    case "get_config":
      return "Read a redacted ACS compatibility configuration summary.";
    case "get_file_info":
      return "Read bounded metadata for a file under the registered ACS filesystem root.";
    case "get_more_search_results":
      return "Read a bounded page from a completed ACS search session.";
    case "get_prompts":
      return "Retrieve a governed ACS compatibility onboarding prompt.";
    case "get_recent_tool_calls":
      return "Read recent redacted connector request audit events.";
    case "get_usage_stats":
      return "Read bounded ACS work-item, audit, and health usage statistics.";
    case "give_feedback_to_desktop_commander":
      return "Report the ACS limitation for opening an external Desktop Commander feedback form.";
    case "interact_with_process":
      return "Request approval to send bounded input to a process started by ACS.";
    case "kill_process":
      return "Request approval to terminate a process previously started by ACS.";
    case "list_devices":
      return "List the local ACS execution device and its governed capabilities.";
    case "list_directory":
      return "List a bounded directory under the registered ACS filesystem root.";
    case "list_processes":
      return "Request a bounded registered process listing through the ACS worker.";
    case "list_searches":
      return "List ACS-backed search work-item sessions.";
    case "list_sessions":
      return "List active ACS work-item sessions.";
    case "move_file":
      return "Request an approval-gated move inside the registered ACS filesystem root.";
    case "ping":
      return "Check local ACS compatibility-device reachability.";
    case "read_file":
      return "Request a bounded redacted file read under the registered ACS filesystem root.";
    case "read_multiple_files":
      return "Request bounded redacted reads for multiple files under the registered ACS filesystem root.";
    case "read_process_output":
      return "Read bounded output from a process previously started by ACS.";
    case "set_config_value":
      return "Request an approval-gated change to one allowlisted ACS configuration value.";
    case "shutdown":
      return "Request approval for an ACS shutdown action; host shutdown is fail-closed and disabled.";
    case "start_process":
      return "Request approval to start one fixed registered command under ACS worker supervision.";
    case "start_search":
      return "Request a bounded allowlisted ACS filesystem search.";
    case "stop_search":
      return "Cancel an ACS-backed search work item.";
    case "who_am_i":
      return "Resolve the authenticated actor against the ACS registry.";
    case "write_file":
      return "Request an approval-gated bounded file write under the registered ACS filesystem root.";
    case "write_pdf":
      return "Request an approval-gated bounded PDF creation under the registered ACS filesystem root.";
  }
}

function toolInputSchema(name: McpToolName): Record<string, unknown> {
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
            enum: [
              "draft",
              "pending_policy",
              "needs_approval",
              "approved",
              "running",
              "succeeded",
              "failed",
              "blocked",
              "cancelled",
              "rejected"
            ]
          }
        }
      };
    case "approve_work_item":
      return {
        type: "object",
        required: ["id", "reason", "actionHash"],
        properties: {
          id: { type: "string" },
          reason: { type: "string" },
          actionHash: { type: "string" }
        }
      };
    case "reject_work_item":
    case "cancel_work_item":
      return {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" },
          reason: { type: "string" }
        }
      };
    case "get_work_item":
    case "unblock_work_item":
      return {
        type: "object",
        required: ["id"],
        properties: {
          id: { type: "string" }
        }
      };
    case "work_item.create":
      return {
        type: "object",
        required: ["title", "intent", "requestedActions"],
        properties: {
          title: { type: "string" },
          intent: { type: "string" },
          target: { type: "object" },
          requestedActions: { type: "array", items: { type: "object" } },
          risk: { type: "string", enum: ["low", "medium", "high", "critical"] }
        }
      };
    case "work_item.get":
    case "result.get":
    case "evidence.list":
      return { type: "object", required: ["id"], properties: { id: { type: "string" } } };
    case "work_item.approve":
      return {
        type: "object",
        required: ["id", "actionHash"],
        properties: { id: { type: "string" }, actionHash: { type: "string" }, reason: { type: "string" } }
      };
    case "work_item.reject":
    case "work_item.cancel":
    case "work_item.unblock":
      return { type: "object", required: ["id"], properties: { id: { type: "string" } } };
    case "command.preview":
    case "command.run":
      return { type: "object", required: ["commandId"], properties: { commandId: { type: "string" } } };
    case "filesystem.read_text":
      return {
        type: "object",
        required: ["rootId", "relativePath"],
        properties: {
          rootId: { type: "string", enum: ["acs-repo"] },
          relativePath: { type: "string" },
          startLine: { type: "integer", minimum: 1 },
          endLine: { type: "integer", minimum: 1 }
        }
      };
    case "filesystem.stat":
      return {
        type: "object",
        required: ["rootId", "relativePath"],
        properties: { rootId: { type: "string", enum: ["acs-repo"] }, relativePath: { type: "string" } }
      };
    case "agent.preview":
    case "agent.run":
      return {
        type: "object",
        required: ["prompt"],
        properties: {
          agentId: { type: "string", enum: ["codex-cli"] },
          prompt: { type: "string" },
          rootId: { type: "string", enum: ["acs-repo"] },
          timeoutMs: { type: "integer", minimum: 1, maximum: 900000 },
          expectedOutputs: { type: "array", items: { type: "string" } }
        }
      };
    case "evidence.get":
      return {
        type: "object",
        required: ["id", "evidenceId"],
        properties: { id: { type: "string" }, evidenceId: { type: "string" } }
      };
    case "service.restart.preview":
    case "service.restart":
      return {
        type: "object",
        required: ["serviceId", "reason"],
        properties: {
          serviceId: { type: "string", enum: ["acs-gateway", "acs-worker", "acs-tunnel", "acs-connector-test"] },
          reason: { type: "string" }
        }
      };
    case "config.change.preview":
    case "config.change":
      return {
        type: "object",
        required: ["targetId", "patch", "reason"],
        properties: {
          targetId: { type: "string", enum: ["acs-connector-settings"] },
          patch: { type: "array", items: { type: "object" } },
          reason: { type: "string" }
        }
      };
    case "create_directory":
    case "get_file_info":
      return {
        type: "object",
        required: ["path"],
        properties: {
          rootId: { type: "string", enum: ["acs-repo"] },
          path: { type: "string" }
        }
      };
    case "edit_block":
      return {
        type: "object",
        required: ["file_path", "old_string", "new_string"],
        properties: {
          rootId: { type: "string", enum: ["acs-repo"] },
          file_path: { type: "string" },
          old_string: { type: "string" },
          new_string: { type: "string" },
          expected_replacements: { type: "integer", minimum: 1 }
        }
      };
    case "force_terminate":
    case "kill_process":
      return {
        type: "object",
        required: ["pid"],
        properties: { pid: { type: "integer", minimum: 1 }, deviceId: { type: "string" } }
      };
    case "get_config":
    case "list_devices":
    case "list_searches":
    case "list_sessions":
    case "ping":
    case "who_am_i":
    case "give_feedback_to_desktop_commander":
      return { type: "object", properties: {} };
    case "get_more_search_results":
      return {
        type: "object",
        required: ["sessionId"],
        properties: {
          sessionId: { type: "string" },
          offset: { type: "integer", minimum: 0 },
          length: { type: "integer", minimum: 1, maximum: 1_000 }
        }
      };
    case "get_prompts":
      return {
        type: "object",
        required: ["action", "promptId"],
        properties: { action: { type: "string", enum: ["get_prompt"] }, promptId: { type: "string" } }
      };
    case "get_recent_tool_calls":
      return {
        type: "object",
        properties: {
          maxResults: { type: "integer", minimum: 1, maximum: 1_000 },
          since: { type: "string", format: "date-time" }
        }
      };
    case "get_usage_stats":
      return { type: "object", properties: {} };
    case "interact_with_process":
      return {
        type: "object",
        required: ["pid", "input"],
        properties: {
          pid: { type: "integer", minimum: 1 },
          input: { type: "string" },
          timeout_ms: { type: "integer", minimum: 1, maximum: 30_000 },
          wait_for_prompt: { type: "boolean" },
          verbose_timing: { type: "boolean" }
        }
      };
    case "list_directory":
      return {
        type: "object",
        properties: {
          rootId: { type: "string", enum: ["acs-repo"] },
          path: { type: "string" },
          depth: { type: "integer", minimum: 0, maximum: 5 }
        }
      };
    case "list_processes":
      return { type: "object", properties: { deviceId: { type: "string" } } };
    case "move_file":
      return {
        type: "object",
        required: ["source", "destination"],
        properties: {
          rootId: { type: "string", enum: ["acs-repo"] },
          source: { type: "string" },
          destination: { type: "string" },
          overwrite: { type: "boolean" }
        }
      };
    case "read_file":
      return {
        type: "object",
        required: ["path"],
        properties: {
          rootId: { type: "string", enum: ["acs-repo"] },
          path: { type: "string" },
          offset: { type: "integer" },
          length: { type: "integer", minimum: 1, maximum: 1_000 }
        }
      };
    case "read_multiple_files":
      return {
        type: "object",
        required: ["paths"],
        properties: {
          rootId: { type: "string", enum: ["acs-repo"] },
          paths: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 100 },
          offset: { type: "integer" },
          length: { type: "integer", minimum: 1, maximum: 1_000 }
        }
      };
    case "read_process_output":
      return {
        type: "object",
        required: ["pid"],
        properties: {
          pid: { type: "integer", minimum: 1 },
          offset: { type: "integer", minimum: 0 },
          length: { type: "integer", minimum: 1, maximum: 1_000 },
          timeout_ms: { type: "integer", minimum: 1, maximum: 30_000 },
          verbose_timing: { type: "boolean" }
        }
      };
    case "set_config_value":
      return {
        type: "object",
        required: ["key", "value"],
        properties: {
          key: { type: "string", enum: ["worker_poll_interval_ms", "max_evidence_bytes"] },
          value: {},
          reason: { type: "string" }
        }
      };
    case "shutdown":
      return { type: "object", properties: { deviceId: { type: "string" } } };
    case "start_process":
      return {
        type: "object",
        required: ["command", "timeout_ms"],
        properties: {
          command: { type: "string" },
          timeout_ms: { type: "integer", minimum: 1, maximum: 120_000 },
          shell: { type: "string" },
          verbose_timing: { type: "boolean" }
        }
      };
    case "start_search":
      return {
        type: "object",
        required: ["pattern"],
        properties: {
          rootId: { type: "string", enum: ["acs-repo"] },
          path: { type: "string" },
          pattern: { type: "string" },
          searchType: { type: "string", enum: ["files", "content"] },
          filePattern: { type: "string" },
          ignoreCase: { type: "boolean" },
          maxResults: { type: "integer", minimum: 1, maximum: 200 },
          includeHidden: { type: "boolean" },
          contextLines: { type: "integer", minimum: 0, maximum: 20 },
          timeout_ms: { type: "integer", minimum: 1, maximum: 120_000 },
          literalSearch: { type: "boolean" }
        }
      };
    case "stop_search":
      return { type: "object", required: ["sessionId"], properties: { sessionId: { type: "string" } } };
    case "write_file":
      return {
        type: "object",
        required: ["path", "content"],
        properties: {
          rootId: { type: "string", enum: ["acs-repo"] },
          path: { type: "string" },
          content: { type: "string" },
          mode: { type: "string", enum: ["rewrite", "append"] }
        }
      };
    case "write_pdf":
      return {
        type: "object",
        required: ["path", "content"],
        properties: {
          rootId: { type: "string", enum: ["acs-repo"] },
          path: { type: "string" },
          outputPath: { type: "string" },
          content: { anyOf: [{ type: "string" }, { type: "array" }] }
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

function mcpAuthError(
  id: JsonRpcId,
  authorization: Exclude<Awaited<ReturnType<typeof authorizeMcpRequest>>, { ok: true }>,
  resourceMetadataUrl: string | undefined,
  scopes: McpScope[]
): McpHttpResult {
  const sharedError = mcpAuthorizationHttpError(authorization, resourceMetadataUrl, scopes);
  return {
    statusCode: authorization.statusCode,
    ...(sharedError.wwwAuthenticate ? { wwwAuthenticate: sharedError.wwwAuthenticate } : {}),
    body: {
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text: `Authentication required: ${authorization.message}.` }],
        structuredContent: {
          authError: authorization.error,
          requiredScopes: scopes
        },
        ...(sharedError.wwwAuthenticate ? { _meta: { "mcp/www_authenticate": [sharedError.wwwAuthenticate] } } : {}),
        isError: true
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
