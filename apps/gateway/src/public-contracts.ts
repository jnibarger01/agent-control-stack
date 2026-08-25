import { directAgentNames } from "@agent-control-stack/machine-controller";
import { workItemToolNames } from "@agent-control-stack/policy-gate";
import {
  acpRoles,
  actionRequestSchema,
  actorTypes,
  createWorkItemSchema,
  listWorkItemsSchema,
  registryStatuses,
  submitWorkResultSchema,
  targetSchema,
  workItemRiskSchema
} from "@agent-control-stack/work-items";
import { z } from "zod";
import { MCP_SCOPES, type McpScope } from "./auth.js";

export { createWorkItemSchema, listWorkItemsSchema, submitWorkResultSchema };

export const PUBLIC_CONTRACT_VERSION = "1.0.0";
export const MCP_PROTOCOL_VERSION = "2024-11-05";

export const approvalBodySchema = z.object({
  reason: z.string().min(1),
  actionHash: z.string().min(1)
});
export const cancelBodySchema = z.object({ reason: z.string().min(1).optional() });
export const unblockBodySchema = z.object({}).passthrough();
export const mcpScopeSchema = z.enum(MCP_SCOPES);
export const connectorBodySchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1).optional(),
  publicKeyPem: z.string().min(1),
  allowedScopes: z.array(mcpScopeSchema).min(1)
});
export const connectorKeyRotationBodySchema = z.object({
  publicKeyPem: z.string().min(1),
  reason: z.string().min(1)
});
export const tunnelSessionBodySchema = z.object({
  tunnelId: z.string().min(1),
  sessionId: z.string().min(1),
  issuedAt: z.string().min(1).optional(),
  expiresAt: z.string().min(1)
});
const acpRoleSchema = z.enum(acpRoles);
const registryStatusSchema = z.enum(registryStatuses);
const optionalStringSchema = z.string().min(1).optional();
const nullableStringSchema = z.string().min(1).nullable().optional();
export const agentBodySchema = z.object({
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
export const agentPatchSchema = z.object({
  name: optionalStringSchema,
  kind: optionalStringSchema,
  acpRole: acpRoleSchema.optional(),
  provider: nullableStringSchema,
  model: nullableStringSchema,
  endpoint: nullableStringSchema,
  status: registryStatusSchema.optional(),
  lastError: nullableStringSchema
});
export const capabilitySchema = z.object({
  name: z.string().min(1),
  description: optionalStringSchema,
  inputSchema: z.record(z.string(), z.unknown()).optional()
});
export const capabilitiesBodySchema = z.object({ capabilities: z.array(capabilitySchema) });
export const actorBodySchema = z.object({
  id: z.string().min(1),
  actorType: z.enum(actorTypes),
  displayName: z.string().min(1),
  externalRef: optionalStringSchema
});
export const heartbeatBodySchema = z.object({
  status: registryStatusSchema,
  currentTask: optionalStringSchema,
  lastError: optionalStringSchema
});
export const eventQuerySchema = z
  .object({
    limit: z.coerce.number().int().positive().optional(),
    afterSequence: z.coerce.number().int().nonnegative().optional()
  })
  .passthrough();
export const sessionLoginBodySchema = z.object({ token: z.string().min(1) });
export const retryBodySchema = z.object({ reason: z.string().min(1).max(2_000) });
export const cloneBodySchema = z.object({
  title: z.string().min(1).max(512).optional(),
  intent: z.string().min(1).max(4_000).optional(),
  target: targetSchema.optional(),
  requestedActions: z.array(actionRequestSchema).max(32).optional(),
  risk: workItemRiskSchema.optional()
});

/**
 * External webhook ingest contract. Strict: unknown fields are rejected so a
 * webhook caller cannot smuggle control-plane fields (requester, status, etc).
 * The gateway DERIVES `requester`/`requesterSubject` server-side from the
 * authenticated caller and the `:source` path segment — never from the body.
 */
export const webhookIngestSchema = z
  .object({
    title: z.string().min(1).max(512),
    intent: z.string().min(1).max(4_000),
    target: targetSchema.optional(),
    requestedActions: z.array(actionRequestSchema).max(32).optional(),
    risk: workItemRiskSchema.optional(),
    correlationId: z.string().min(1).max(512).optional()
  })
  .strict();

export const jsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).default(null),
  method: z.string().min(1),
  params: z.unknown().optional()
});

export const directAgentToolName = "test.agent.run" as const;
export const mcpToolNames = [...workItemToolNames, directAgentToolName] as const;
export type McpToolName = (typeof mcpToolNames)[number];
export const remoteMcpToolNames = workItemToolNames.filter((name) => name !== "approve_work_item");

export const toolsCallParamsSchema = z.object({
  name: z.enum(mcpToolNames),
  arguments: z.unknown().optional()
});

const idSchema = z.object({ id: z.string().min(1) });
const reasonSchema = idSchema.extend({ reason: z.string().min(1).optional() });
const directAgentInputSchema = z.object({
  agent: z.enum(directAgentNames),
  prompt: z.string().min(1).max(32_000),
  cwd: z.string().min(1).optional(),
  timeoutSeconds: z.number().int().positive().max(3_600).optional(),
  permissionMode: z.enum(["read-only", "readonly", "read_only"]).default("read-only")
});

export const gatewayMcpInputSchemas = {
  create_work_item: createWorkItemSchema,
  get_work_item: idSchema,
  list_work_items: listWorkItemsSchema,
  approve_work_item: idSchema.merge(approvalBodySchema),
  unblock_work_item: idSchema,
  reject_work_item: reasonSchema,
  cancel_work_item: reasonSchema,
  [directAgentToolName]: directAgentInputSchema
} satisfies Record<McpToolName, z.ZodType>;

export function mcpRequiredScopes(name: McpToolName): McpScope[] {
  if (name === directAgentToolName) return ["acs:work:approve"];
  switch (name) {
    case "create_work_item":
      return ["acs:work:create"];
    case "get_work_item":
    case "list_work_items":
      return ["acs:work:read"];
    case "approve_work_item":
    case "unblock_work_item":
    case "reject_work_item":
    case "cancel_work_item":
      return ["acs:work:approve"];
  }
}

export function mcpToolAnnotations(name: McpToolName): Record<string, boolean> {
  if (name === directAgentToolName) return { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
  switch (name) {
    case "get_work_item":
    case "list_work_items":
      return { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
    case "cancel_work_item":
    case "reject_work_item":
      return { readOnlyHint: false, destructiveHint: true, openWorldHint: false };
    default:
      return { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
  }
}

export function mcpToolDescription(name: McpToolName): string {
  if (name === directAgentToolName) {
    return "Run one allowed agent once from a clean JSON payload through the approval-scoped gateway path.";
  }
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
  }
}

export type PublicHttpOperation = {
  method: "get" | "post" | "put" | "patch";
  path: string;
  operationId: string;
  summary: string;
  requestSchema?: z.ZodType;
};

export const publicHttpOperations: readonly PublicHttpOperation[] = [
  { method: "get", path: "/livez", operationId: "getLiveness", summary: "Read process liveness." },
  { method: "get", path: "/readyz", operationId: "getReadiness", summary: "Read control-plane readiness." },
  { method: "get", path: "/health", operationId: "getHealth", summary: "Read control-plane health." },
  {
    method: "post",
    path: "/session/login",
    operationId: "createSession",
    summary: "Create an authenticated operator session.",
    requestSchema: sessionLoginBodySchema
  },
  { method: "get", path: "/mcp/tools", operationId: "listMcpTools", summary: "List gateway MCP tools." },
  {
    method: "post",
    path: "/connectors",
    operationId: "registerConnector",
    summary: "Register an authenticated connector.",
    requestSchema: connectorBodySchema
  },
  {
    method: "post",
    path: "/connectors/{id}/rotate-key",
    operationId: "rotateConnectorKey",
    summary: "Rotate a connector public key.",
    requestSchema: connectorKeyRotationBodySchema
  },
  {
    method: "post",
    path: "/connectors/{id}/tunnel-sessions",
    operationId: "createTunnelSession",
    summary: "Create a connector tunnel session.",
    requestSchema: tunnelSessionBodySchema
  },
  {
    method: "post",
    path: "/connectors/{id}/tunnel-sessions/{tunnelId}/{sessionId}/revoke",
    operationId: "revokeTunnelSession",
    summary: "Revoke a connector tunnel session."
  },
  {
    method: "post",
    path: "/connectors/{id}/tunnel-sessions/{tunnelId}/{sessionId}/consume",
    operationId: "consumeTunnelSession",
    summary: "Consume a connector tunnel session."
  },
  {
    method: "post",
    path: "/mcp",
    operationId: "callGatewayMcp",
    summary: "Send a JSON-RPC request to the gateway MCP endpoint.",
    requestSchema: jsonRpcRequestSchema
  },
  {
    method: "get",
    path: "/.well-known/oauth-protected-resource",
    operationId: "getOAuthProtectedResource",
    summary: "Read OAuth protected-resource metadata."
  },
  {
    method: "get",
    path: "/.well-known/oauth-protected-resource/mcp",
    operationId: "getMcpOAuthProtectedResource",
    summary: "Read MCP OAuth protected-resource metadata."
  },
  { method: "get", path: "/work-items", operationId: "listWorkItems", summary: "List governed work items." },
  {
    method: "post",
    path: "/work-items",
    operationId: "createWorkItem",
    summary: "Create a governed work item.",
    requestSchema: createWorkItemSchema
  },
  {
    method: "post",
    path: "/webhooks/{source}",
    operationId: "ingestWebhook",
    summary: "Ingest an external webhook as a governed ACS work item.",
    requestSchema: webhookIngestSchema
  },
  { method: "get", path: "/work-items/{id}", operationId: "getWorkItem", summary: "Read a governed work item." },
  {
    method: "post",
    path: "/work-items/{id}/approve",
    operationId: "approveWorkItem",
    summary: "Approve an exact policy-evaluated action.",
    requestSchema: approvalBodySchema
  },
  {
    method: "post",
    path: "/work-items/{id}/cancel",
    operationId: "cancelWorkItem",
    summary: "Cancel a governed work item.",
    requestSchema: cancelBodySchema
  },
  {
    method: "post",
    path: "/work-items/{id}/reject",
    operationId: "rejectWorkItem",
    summary: "Reject a governed work item.",
    requestSchema: cancelBodySchema
  },
  {
    method: "post",
    path: "/work-items/{id}/unblock",
    operationId: "unblockWorkItem",
    summary: "Return a blocked work item to policy evaluation.",
    requestSchema: unblockBodySchema
  },
  {
    method: "post",
    path: "/work-items/{id}/results",
    operationId: "submitWorkResult",
    summary: "Submit an authenticated lease-bound worker result.",
    requestSchema: submitWorkResultSchema
  },
  {
    method: "post",
    path: "/work-items/{id}/retry",
    operationId: "retryWorkItem",
    summary: "Create an immutable retry work item.",
    requestSchema: retryBodySchema
  },
  {
    method: "post",
    path: "/work-items/{id}/clone",
    operationId: "cloneWorkItem",
    summary: "Create an immutable clone work item.",
    requestSchema: cloneBodySchema
  },
  { method: "get", path: "/api/actors", operationId: "listActors", summary: "List registered actors." },
  {
    method: "post",
    path: "/api/actors",
    operationId: "registerActor",
    summary: "Register an actor.",
    requestSchema: actorBodySchema
  },
  { method: "get", path: "/actors", operationId: "listActorsAlias", summary: "List registered actors." },
  {
    method: "post",
    path: "/actors",
    operationId: "registerActorAlias",
    summary: "Register an actor.",
    requestSchema: actorBodySchema
  },
  { method: "get", path: "/api/agents", operationId: "listAgents", summary: "List registered agents." },
  {
    method: "post",
    path: "/api/agents",
    operationId: "registerAgent",
    summary: "Register an agent.",
    requestSchema: agentBodySchema
  },
  { method: "get", path: "/api/agents/{id}", operationId: "getAgent", summary: "Read a registered agent." },
  {
    method: "patch",
    path: "/api/agents/{id}",
    operationId: "updateAgent",
    summary: "Update a registered agent.",
    requestSchema: agentPatchSchema
  },
  {
    method: "get",
    path: "/api/agents/{id}/capabilities",
    operationId: "getAgentCapabilities",
    summary: "Read an agent capability set."
  },
  {
    method: "put",
    path: "/api/agents/{id}/capabilities",
    operationId: "replaceAgentCapabilities",
    summary: "Replace an agent capability set.",
    requestSchema: capabilitiesBodySchema
  },
  {
    method: "post",
    path: "/api/agents/{id}/heartbeat",
    operationId: "recordAgentHeartbeat",
    summary: "Record an agent heartbeat.",
    requestSchema: heartbeatBodySchema
  },
  { method: "get", path: "/agents", operationId: "listAcpAgents", summary: "List agents through the ACP view." },
  {
    method: "get",
    path: "/agents/{id}",
    operationId: "getAcpAgent",
    summary: "Read an agent through the ACP view."
  },
  { method: "get", path: "/events", operationId: "streamEvents", summary: "Stream audit events over SSE." }
] as const;

export const publicContractExamples = {
  createWorkItem: {
    title: "Run repository tests",
    requester: "user",
    intent: "Run the repository test suite.",
    target: { cwd: "/workspace/agent-control-stack" },
    requestedActions: [{ kind: "command", description: "npm test", params: {} }],
    risk: "medium"
  },
  approveWorkItem: {
    reason: "Reviewed against the exact action fingerprint.",
    actionHash: "a".repeat(64)
  },
  listWorkItemsMcp: {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "list_work_items", arguments: { status: "approved" } }
  }
} as const;
