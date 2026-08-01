import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDeterministicEvaluation } from "@agent-control-stack/eval-harness";
import { directAgentNames } from "@agent-control-stack/machine-controller";
import { type createWorkItemTools, workItemToolNames } from "@agent-control-stack/policy-gate";
import { executeSandboxed } from "@agent-control-stack/sandbox";
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

const MCP_PROTOCOL_VERSION = "2024-11-05";
const MCP_TOOL_TIMEOUT_MS = 30_000;
const MCP_TOOL_OUTPUT_BYTES = 256 * 1024;

type GatewayWorkItemTools = ReturnType<typeof createWorkItemTools>;
type GatewayToolName = (typeof workItemToolNames)[number];
const directAgentToolName = "test.agent.run" as const;
type DirectAgentToolName = typeof directAgentToolName;
const dashboardToolNames = ["open_acs_dashboard", "get_execution_detail"] as const;
const publicToolNames = [
  "work_item.create",
  "work_item.list",
  "work_item.get",
  "work_item.approve",
  "tool.execute_approved",
  "audit.query",
  "memory.search",
  "eval.run"
] as const;
const mcpToolNames = [...workItemToolNames, ...dashboardToolNames, ...publicToolNames, directAgentToolName] as const;
type McpToolName = (typeof mcpToolNames)[number];
const remoteMcpToolNames = [
  ...workItemToolNames.filter((name) => name !== "approve_work_item"),
  ...dashboardToolNames,
  ...publicToolNames
];
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
    requiredScopes: requiredScopes(parsed.data.name),
    remoteAddress: input.remoteAddress
  });
  if (!authorization.ok) {
    return mcpAuthError(input.id, authorization, input.resourceMetadataUrl, requiredScopes(parsed.data.name));
  }

  if (parsed.data.name === "approve_work_item" || parsed.data.name === "work_item.approve") {
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
    const result = await withMcpToolLimits(
      callMcpTool({
        tools: input.tools,
        store: input.store,
        directAgentController: input.directAgentController,
        name: parsed.data.name,
        args: parsed.data.arguments ?? {},
        auth: authorization.auth,
        actor
      })
    );
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

async function withMcpToolLimits(resultPromise: Promise<unknown>): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ControlStackError("mcp_tool_timeout", "MCP tool call exceeded its time limit")), MCP_TOOL_TIMEOUT_MS);
    timer.unref();
  });
  try {
    const result = await Promise.race([resultPromise, timeout]);
    const encoded = JSON.stringify(result);
    if (Buffer.byteLength(encoded, "utf8") > MCP_TOOL_OUTPUT_BYTES) {
      throw new ControlStackError("mcp_output_limit", "MCP tool output exceeded its size limit");
    }
    return result;
  } finally {
    if (timer) clearTimeout(timer);
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
  if (input.name === "work_item.create") {
    return callGatewayTool(input.tools, "create_work_item", bindAuthenticatedActor("create_work_item", input.args, input.auth, input.actor), input.auth, input.actor);
  }
  if (input.name === "work_item.list") {
    return callGatewayTool(input.tools, "list_work_items", input.args, input.auth, input.actor);
  }
  if (input.name === "work_item.get") {
    return callGatewayTool(input.tools, "get_work_item", input.args, input.auth, input.actor);
  }
  if (input.name === "work_item.approve") {
    throw new ControlStackError("mcp_approval_forbidden", "MCP identities cannot grant approval");
  }
  if (input.name === "tool.execute_approved") {
    const workerId = z.object({ workerId: z.string().min(1).optional() }).parse(input.args).workerId ?? input.actor;
    const { executeApprovedWorkItem } = await import("./tools/execute-approved.js");
    return executeApprovedWorkItem({ store: input.store, workerId, execute: executeSandboxed });
  }
  if (input.name === "audit.query") {
    const query = z
      .object({ afterSequence: z.number().int().nonnegative().optional(), workItemId: z.string().min(1).optional(), limit: z.number().int().positive().max(500).optional() })
      .strict()
      .parse(input.args);
    return { events: input.store.readEvents(query) };
  }
  if (input.name === "memory.search") {
    const query = z
      .object({ query: z.string().min(1).max(1_000), asOf: z.string().datetime({ offset: true }).optional(), tags: z.array(z.string().min(1).max(128)).max(32).optional(), limit: z.number().int().positive().max(500).optional() })
      .strict()
      .parse(input.args);
    if (!input.store.searchMemory) throw new ControlStackError("memory_not_configured", "temporal memory is not available");
    return { memories: input.store.searchMemory(query.query, query) };
  }
  if (input.name === "eval.run") {
    z.object({}).strict().parse(input.args);
    const root = mkdtempSync(join(tmpdir(), "acs-mcp-eval-"));
    try {
      const result = runDeterministicEvaluation(root);
      return { verdict: result.verdict, cases: result.cases, tamperDetection: result.sqlite.tamperDetection };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
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
      ? [{ type: "oauth2" as const, scopes: requiredScopes(name) }]
      : [{ type: "noauth" as const }];
    return {
      name,
      description: toolDescription(name),
      inputSchema: toolInputSchema(name),
      securitySchemes,
      _meta: {
        securitySchemes,
        ...(name === "open_acs_dashboard" ? { ui: { resourceUri: ACS_DASHBOARD_RESOURCE_URI } } : {})
      },
      annotations: toolAnnotations(name)
    };
  });
}

function requiredScopes(name: McpToolName): McpScope[] {
  if (name === directAgentToolName) return ["acs:work:approve"];
  switch (name) {
    case "work_item.create":
      return ["acs:work:create"];
    case "work_item.list":
    case "work_item.get":
    case "audit.query":
    case "memory.search":
      return ["acs:work:read"];
    case "work_item.approve":
    case "tool.execute_approved":
      return ["acs:work:approve"];
    case "eval.run":
      return ["acs:work:read"];
    case "create_work_item":
      return ["acs:work:create"];
    case "get_work_item":
    case "list_work_items":
    case "open_acs_dashboard":
    case "get_execution_detail":
      return ["acs:work:read"];
    case "approve_work_item":
    case "unblock_work_item":
    case "reject_work_item":
    case "cancel_work_item":
      return ["acs:work:approve"];
  }
}

function isMutatingTool(name: McpToolName): boolean {
  if (name === directAgentToolName) return true;
  return ![
    "get_work_item",
    "list_work_items",
    "open_acs_dashboard",
    "get_execution_detail",
    "work_item.list",
    "work_item.get",
    "audit.query",
    "memory.search",
    "eval.run"
  ].includes(name);
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

function toolAnnotations(name: McpToolName): Record<string, boolean> {
  if (name === directAgentToolName) return { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
  switch (name) {
    case "work_item.list":
    case "work_item.get":
    case "audit.query":
    case "memory.search":
    case "get_work_item":
    case "list_work_items":
    case "open_acs_dashboard":
    case "get_execution_detail":
      return { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
    case "cancel_work_item":
    case "reject_work_item":
      return { readOnlyHint: false, destructiveHint: true, openWorldHint: false };
    default:
      return { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
  }
}

function toolDescription(name: McpToolName): string {
  if (name === directAgentToolName) {
    return "Run one allowed agent once from a clean JSON payload through the approval-scoped gateway path.";
  }
  switch (name) {
    case "work_item.create":
      return "Create a governed work item through policy evaluation.";
    case "work_item.list":
      return "List governed work items.";
    case "work_item.get":
      return "Read one governed work item.";
    case "work_item.approve":
      return "Request approval for an exact action; MCP callers cannot grant approval.";
    case "tool.execute_approved":
      return "Execute one already-approved work item through the worker and sandbox boundary.";
    case "audit.query":
      return "Query redacted, hash-chained ACS audit events.";
    case "memory.search":
      return "Search source-backed temporal memory with citations.";
    case "eval.run":
      return "Run the deterministic ACS evaluation corpus.";
    case "open_acs_dashboard":
      return "Open the read-only ACS Control Center with current health, executions, approvals, and operational findings.";
    case "get_execution_detail":
      return "Read authoritative detail and recent audit events for one ACS execution.";
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
  }
}

function toolInputSchema(name: McpToolName): Record<string, unknown> {
  if (name === directAgentToolName) {
    return {
      type: "object",
      required: ["agent", "prompt"],
      additionalProperties: true,
      properties: {
        agent: { type: "string", enum: [...directAgentNames] },
        prompt: { type: "string", minLength: 1 },
        cwd: { type: "string" },
        timeoutSeconds: { type: "integer", minimum: 1 },
        permissionMode: { type: "string", enum: ["read-only", "readonly", "read_only"], default: "read-only" }
      }
    };
  }
  switch (name) {
    case "work_item.create":
      return {
        type: "object",
        required: ["title", "intent"],
        properties: {
          title: { type: "string" },
          intent: { type: "string" },
          target: { type: "object" },
          requestedActions: { type: "array", items: { type: "object" } },
          risk: { type: "string", enum: ["low", "medium", "high", "critical"] }
        }
      };
    case "work_item.list":
      return { type: "object", properties: { status: { type: "string" } } };
    case "work_item.get":
      return { type: "object", required: ["id"], properties: { id: { type: "string" } } };
    case "work_item.approve":
      return {
        type: "object",
        required: ["id", "reason", "actionHash"],
        properties: { id: { type: "string" }, reason: { type: "string" }, actionHash: { type: "string" } }
      };
    case "tool.execute_approved":
      return { type: "object", properties: { workerId: { type: "string" } } };
    case "audit.query":
      return {
        type: "object",
        properties: {
          afterSequence: { type: "integer", minimum: 0 },
          workItemId: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 500 }
        }
      };
    case "memory.search":
      return {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string" },
          asOf: { type: "string", format: "date-time" },
          tags: { type: "array", items: { type: "string" } },
          limit: { type: "integer", minimum: 1, maximum: 500 }
        }
      };
    case "eval.run":
      return { type: "object", properties: {} };
  }
  switch (name) {
    case "open_acs_dashboard":
      return { type: "object", properties: {} };
    case "get_execution_detail":
      return { type: "object", required: ["id"], properties: { id: { type: "string" } } };
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
