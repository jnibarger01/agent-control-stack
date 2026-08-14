import type { IncomingHttpHeaders } from "node:http";
import { type createWorkItemTools, workItemToolNames } from "@agent-control-stack/policy-gate";
import { ControlStackError } from "@agent-control-stack/shared";
import type { WorkItemStore } from "@agent-control-stack/work-items";
import { ZodError, z } from "zod";
import {
  authorizeMcpRequest,
  mcpAuthorizationHttpError,
  type McpAuthenticatedRequest,
  type McpAuthOptions,
  type McpScope
} from "./auth.js";
import {
  ACS_DASHBOARD_CSP,
  ACS_DASHBOARD_RESOURCE_URI,
  dashboardOverview,
  executionDetail
} from "./chatgpt-dashboard.js";
import { chatgptDashboardWidgetHtml } from "./chatgpt-dashboard-widget.generated.js";
import {
  directAgentToolName,
  gatewayMcpInputSchemas,
  jsonRpcRequestSchema,
  MCP_PROTOCOL_VERSION,
  mcpRequiredScopes,
  mcpToolAnnotations,
  mcpToolDescription,
  remoteMcpToolNames,
  toolsCallParamsSchema,
  type McpToolName
} from "./public-contracts.js";

type GatewayWorkItemTools = ReturnType<typeof createWorkItemTools>;
type GatewayToolName = (typeof workItemToolNames)[number];
type DirectAgentToolName = typeof directAgentToolName;
type JsonRpcId = string | number | null;

export interface GatewayDirectAgentController {
  callTool(name: DirectAgentToolName, args: unknown): Promise<unknown> | unknown;
}

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

export async function handleMcpHttpRequest(input: {
  body: unknown;
  headers: IncomingHttpHeaders;
  tools: GatewayWorkItemTools;
  store: WorkItemStore;
  directAgentController?: GatewayDirectAgentController;
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
        capabilities: { tools: {}, resources: {} },
        serverInfo: {
          name: "agent-control-stack-gateway",
          version: "0.1.0"
        }
      });
    case "ping":
      return jsonRpcResult(request.data.id, {});
    case "tools/list":
      return jsonRpcResult(request.data.id, {
        tools: mcpToolDefinitions(Boolean(input.directAgentController), Boolean(input.auth?.oauth))
      });
    case "resources/list":
      return jsonRpcResult(request.data.id, { resources: [resourceDefinition()] });
    case "resources/read":
      return resourceRead(request.data.id, request.data.params);
    case "tools/call":
      return handleToolsCall({
        id: request.data.id,
        requestId: input.requestId,
        params: request.data.params,
        headers: input.headers,
        auth: input.auth,
        resourceMetadataUrl: input.resourceMetadataUrl,
        tools: input.tools,
        store: input.store,
        directAgentController: input.directAgentController,
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
    method === "resources/read" ||
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
  tools: GatewayWorkItemTools;
  store: WorkItemStore;
  directAgentController?: GatewayDirectAgentController;
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
    requiredScopes: mcpRequiredScopes(parsed.data.name),
    remoteAddress: input.remoteAddress
  });
  if (!authorization.ok) {
    return mcpAuthError(input.id, authorization, input.resourceMetadataUrl, mcpRequiredScopes(parsed.data.name));
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

  const actor = isMutatingTool(parsed.data.name)
    ? input.resolveActorId?.(authorization.auth)
    : resolvedMcpActor(authorization.auth);
  if (!actor) {
    return jsonRpcError(input.id, -32001, "MCP actor is not registered", 403);
  }
  try {
    const result = await callMcpTool({
      tools: input.tools,
      store: input.store,
      directAgentController: input.directAgentController,
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
          text:
            parsed.data.name === "open_acs_dashboard"
              ? "ACS Control Center loaded."
              : `${parsed.data.name} completed through the gateway MCP path.`
        }
      ],
      structuredContent: asStructuredContent(result),
      ...(parsed.data.name === "open_acs_dashboard"
        ? {
            _meta: {
              dashboard: {
                presentation: "inline"
              }
            }
          }
        : {})
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
  tools: GatewayWorkItemTools;
  store: WorkItemStore;
  directAgentController?: GatewayDirectAgentController;
  name: McpToolName;
  args: unknown;
  auth: McpAuthenticatedRequest;
  actor: string;
}): Promise<unknown> {
  if (input.name === directAgentToolName) {
    if (!input.directAgentController) {
      throw new ControlStackError("direct_agent_not_configured", "test.agent.run is not configured on this gateway");
    }
    return await input.directAgentController.callTool(directAgentToolName, input.args);
  }
  if (input.name === "open_acs_dashboard") return dashboardOverview(input.store);
  if (input.name === "get_execution_detail") {
    const id = z.object({ id: z.string().min(1) }).parse(input.args).id;
    const detail = executionDetail(input.store, id);
    if (!detail) throw new ControlStackError("work_item_not_found", "work item not found");
    return detail;
  }

  return callGatewayTool(input.tools, input.name, input.args, input.auth, input.actor);
}

function callGatewayTool(
  tools: GatewayWorkItemTools,
  name: GatewayToolName,
  args: unknown,
  auth: McpAuthenticatedRequest,
  actor: string
): unknown {
  const handler = tools[name] as (input: unknown) => unknown;
  return handler(bindAuthenticatedActor(name, args, auth, actor));
}

function bindAuthenticatedActor(
  name: GatewayToolName,
  args: unknown,
  auth: McpAuthenticatedRequest,
  actor: string
): unknown {
  if (name === "create_work_item") {
    // MCP identities are agents; caller-supplied requester/requesterSubject are untrusted.
    return { ...requestObject(args), requester: "agent", requesterSubject: actor };
  }
  if (
    name !== "approve_work_item" &&
    name !== "unblock_work_item" &&
    name !== "reject_work_item" &&
    name !== "cancel_work_item"
  ) {
    return args;
  }
  const record = requestObject(args);
  if (name === "approve_work_item") {
    return { ...record, approvedBy: actor };
  }
  return { ...record, actor };
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

function mcpToolDefinitions(includeDirectAgent: boolean, advertiseOAuth: boolean) {
  const toolNames: McpToolName[] = includeDirectAgent
    ? [...remoteMcpToolNames, directAgentToolName]
    : [...remoteMcpToolNames];
  return toolNames.map((name) => {
    const securitySchemes = advertiseOAuth
      ? [{ type: "oauth2" as const, scopes: mcpRequiredScopes(name) }]
      : [{ type: "noauth" as const }];
    return {
      name,
      description: mcpToolDescription(name),
      inputSchema: z.toJSONSchema(gatewayMcpInputSchemas[name], { target: "draft-7", io: "input" }),
      securitySchemes,
      _meta: {
        securitySchemes,
        ...(name === "open_acs_dashboard" ? { ui: { resourceUri: ACS_DASHBOARD_RESOURCE_URI } } : {})
      },
      annotations: mcpToolAnnotations(name)
    };
  });
}

function isMutatingTool(name: McpToolName): boolean {
  if (name === directAgentToolName) return true;
  return !["get_work_item", "list_work_items", "open_acs_dashboard", "get_execution_detail"].includes(name);
}

function resourceDefinition() {
  return {
    name: "acs-dashboard",
    uri: ACS_DASHBOARD_RESOURCE_URI,
    mimeType: "text/html;profile=mcp-app",
    _meta: { ui: { prefersBorder: true, csp: ACS_DASHBOARD_CSP } }
  };
}
function resourceRead(id: JsonRpcId, params: unknown): McpHttpResult {
  if (!z.object({ uri: z.literal(ACS_DASHBOARD_RESOURCE_URI) }).safeParse(params).success)
    return jsonRpcError(id, -32602, "invalid resources/read params", 400);
  return jsonRpcResult(id, { contents: [{ ...resourceDefinition(), text: chatgptDashboardWidgetHtml }] });
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
