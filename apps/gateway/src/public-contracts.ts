import { directAgentNames } from "@agent-control-stack/machine-controller";
import { explainPolicyInputSchema, workItemToolNames } from "@agent-control-stack/policy-gate";
import {
  missionTraceQuerySchema,
  changeSetReviewBodySchema,
  acpRoles,
  actionRequestSchema,
  actorTypes,
  createWorkItemSchema,
  listWorkItemsSchema,
  registryStatuses,
  submitWorkResultSchema,
  submitChangeSetInputSchema,
  issueAutonomousAuthorityBodySchema,
  targetSchema,
  workItemRiskSchema
} from "@agent-control-stack/work-items";
import { z } from "zod";
import { MCP_SCOPES, type McpScope } from "./auth.js";
import {
  portfolioGetRepositoryInputSchema,
  portfolioLimitInputSchema,
  portfolioListRepositoriesInputSchema
} from "./portfolio-client.js";

export { createWorkItemSchema, listWorkItemsSchema, submitWorkResultSchema };
export { issueAutonomousAuthorityBodySchema, changeSetReviewBodySchema, missionTraceQuerySchema };
export const grantAuthorizationBodySchema = z
  .object({
    grantId: z.string().min(1).max(256),
    expectedManifestHash: z.string().regex(/^[a-f0-9]{64}$/u)
  })
  .strict();

export const PUBLIC_CONTRACT_VERSION = "1.0.0";
export const MCP_PROTOCOL_VERSION = "2024-11-05";

export const approvalBodySchema = z.object({
  reason: z.string().min(1),
  actionHash: z.string().min(1)
});
export const changeSetSubmissionBodySchema = submitChangeSetInputSchema.omit({ createdByActorId: true, now: true });
export const changeSetPolicyBodySchema = z
  .object({ expectedManifestHash: z.string().regex(/^[a-f0-9]{64}$/u) })
  .strict();
export const changeSetOperationPermitBodySchema = z.union([
  changeSetPolicyBodySchema.extend({ approvalId: z.string().min(1).max(256) }).strict(),
  changeSetPolicyBodySchema.extend({ authorizationId: z.string().min(1).max(256) }).strict()
]);
export const changeSetApprovalBodySchema = changeSetPolicyBodySchema
  .extend({
    requestId: z.string().min(1).max(128),
    reason: z.string().min(1).max(4_000),
    expiresAt: z.string().datetime({ offset: true }).optional()
  })
  .strict();
export const changeSetRevocationBodySchema = z.object({ reason: z.string().min(1).max(4_000) }).strict();
export const codingMissionCreateBodySchema = z
  .object({
    missionId: z.string().min(1).max(128),
    repository: z.string().min(1).max(256),
    baseRef: z.string().min(1).max(256),
    baseSha: z.string().regex(/^[a-f0-9]{40}$/u),
    summary: z.string().min(1).max(4000)
  })
  .strict();
export const codingMissionApprovalBodySchema = z
  .object({
    expectedChangeSetHash: z.string().regex(/^[a-f0-9]{64}$/u)
  })
  .strict();
export const changeSetQuerySchema = z
  .object({
    revision: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional()
  })
  .strict();
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

/** Edge-to-ACS report that a verified OAuth client connected. Attribution only. */
const claimsSchema = z
  .object({
    name: z.string().max(256).optional(),
    version: z.string().max(256).optional(),
    userAgent: z.string().max(1_024).optional()
  })
  .strict();

export const mcpObservationBodySchema = z
  .object({
    lane: z.enum(["jc", "dc"]),
    clientId: z.string().min(1).max(256),
    subject: z.string().min(1).max(256),
    method: z.enum(["initialize", "tools/list"]),
    claims: claimsSchema.optional()
  })
  .strict();

export const mcpClientLabelBodySchema = z
  .object({
    clientId: z.string().min(1).max(256),
    kind: z.enum(["chatgpt", "muse", "grok", "claude", "gemini", "other"]),
    label: z.string().min(1).max(64),
    note: z.string().max(200).optional()
  })
  .strict();

export const mcpClientClearBodySchema = z.object({ clientId: z.string().min(1).max(256) }).strict();

export const executionModeBodySchema = z
  .object({
    mode: z.enum(["strict", "admin"]),
    reason: z.string().min(1).max(512).optional()
  })
  .strict();

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

/**
 * Trusted-bridge request for an ACS-issued Desktop Commander capability
 * (POST /dc/capability/issue). The gateway derives requester/actor identity
 * server-side (bearer credential + x-dc-actor header); the body only describes
 * the single tool call to authorize. argsSummary is the truncated/normalized
 * JSON of the arguments - it is mapped to risk through the policy-gate rules
 * and lands in a work-item-backed authorization, never a parallel store.
 */
export const dcCapabilityIssueSchema = z
  .object({
    client_id: z.string().min(1).max(256),
    tool: z.string().min(1).max(128),
    argsSummary: z.string().min(1).max(240_000),
    changeSetPermitId: z.string().min(1).max(256).optional(),
    correlationId: z.string().min(1).max(256).optional()
  })
  .strict();

const dcRuntimeIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/u);
const dcRuntimeChallengeSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const dcRuntimeScopesSchema = z
  .array(z.enum(["fs.read", "fs.write", "process.exec", "process.spawn", "network.read", "network.write"]))
  .min(1)
  .max(6);

/** Managed-runtime bootstrap request: an ACS-issued identity challenge. */
export const dcRuntimeBootstrapSchema = z
  .object({
    runtimeId: dcRuntimeIdSchema,
    identityConfigFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    scopes: dcRuntimeScopesSchema
  })
  .strict();

/** Exact identity proof echoed by the managed DC child in initialize result metadata. */
export const dcRuntimeIdentityProofSchema = z
  .object({
    schemaVersion: z.literal(1),
    runtimeId: dcRuntimeIdSchema,
    challenge: dcRuntimeChallengeSchema,
    scopes: dcRuntimeScopesSchema
  })
  .strict();

export const dcRuntimeBootstrapCompleteSchema = dcRuntimeBootstrapSchema
  .extend({
    challenge: dcRuntimeChallengeSchema,
    runtimeIdentity: dcRuntimeIdentityProofSchema
  })
  .strict();

export const jsonRpcRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).default(null),
  method: z.string().min(1),
  params: z.unknown().optional()
});

export const directAgentToolName = "test.agent.run" as const;
export const dashboardToolNames = ["open_acs_dashboard", "get_execution_detail"] as const;
export const portfolioToolNames = [
  "portfolio.get_summary",
  "portfolio.list_repositories",
  "portfolio.list_attention_required",
  "portfolio.get_repository",
  "portfolio.list_failures",
  "portfolio.list_pending_work",
  "portfolio.list_recent_progress"
] as const;
export const mcpToolNames = [
  ...workItemToolNames,
  ...dashboardToolNames,
  ...portfolioToolNames,
  directAgentToolName
] as const;
export type McpToolName = (typeof mcpToolNames)[number];
export const remoteMcpToolNames = [
  ...workItemToolNames.filter((name) => name !== "approve_work_item"),
  ...dashboardToolNames,
  ...portfolioToolNames
];

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
  explain_policy: explainPolicyInputSchema,
  open_acs_dashboard: z.object({}),
  get_execution_detail: idSchema,
  "portfolio.get_summary": z.object({}).strict(),
  "portfolio.list_repositories": portfolioListRepositoriesInputSchema,
  "portfolio.list_attention_required": portfolioLimitInputSchema,
  "portfolio.get_repository": portfolioGetRepositoryInputSchema,
  "portfolio.list_failures": portfolioLimitInputSchema,
  "portfolio.list_pending_work": portfolioLimitInputSchema,
  "portfolio.list_recent_progress": portfolioLimitInputSchema,
  [directAgentToolName]: directAgentInputSchema
} satisfies Record<McpToolName, z.ZodType>;

export function mcpRequiredScopes(name: McpToolName): McpScope[] {
  if (name === directAgentToolName) return ["acs:work:approve"];
  switch (name) {
    case "create_work_item":
      return ["acs:work:create"];
    case "get_work_item":
    case "list_work_items":
    case "explain_policy":
    case "open_acs_dashboard":
    case "get_execution_detail":
    case "portfolio.get_summary":
    case "portfolio.list_repositories":
    case "portfolio.list_attention_required":
    case "portfolio.get_repository":
    case "portfolio.list_failures":
    case "portfolio.list_pending_work":
    case "portfolio.list_recent_progress":
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
    case "explain_policy":
    case "open_acs_dashboard":
    case "get_execution_detail":
    case "portfolio.get_summary":
    case "portfolio.list_repositories":
    case "portfolio.list_attention_required":
    case "portfolio.get_repository":
    case "portfolio.list_failures":
    case "portfolio.list_pending_work":
    case "portfolio.list_recent_progress":
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
    case "open_acs_dashboard":
      return "Open the read-only ACS Control Center with current health, executions, approvals, and operational findings.";
    case "get_execution_detail":
      return "Read authoritative detail and recent audit events for one ACS execution.";
    case "create_work_item":
      return "Create a governed work item and immediately evaluate it through the policy gate.";
    case "get_work_item":
      return "Read one work item by id.";
    case "list_work_items":
      return "List work items, optionally filtered by status. Page size defaults to 100 and is hard-capped at 500.";
    case "approve_work_item":
      return "Record user approval for the exact policy-evaluated action hash on a work item.";
    case "unblock_work_item":
      return "Move a blocked work item back to pending policy evaluation.";
    case "reject_work_item":
      return "Reject a work item through a distinct terminal denial state.";
    case "cancel_work_item":
      return "Cancel a work item through the work-item state machine.";
    case "explain_policy":
      return "Read-only policy explain for a candidate action: decision, matched rule ids, and action hash. Does not execute or record.";
    case "portfolio.get_summary":
      return "Read the Visualizer GitHub portfolio summary. This never mutates GitHub.";
    case "portfolio.list_repositories":
      return "List persisted GitHub portfolio repositories from Visualizer. This never mutates GitHub.";
    case "portfolio.list_attention_required":
      return "List ranked GitHub portfolio attention items from Visualizer. This never mutates GitHub.";
    case "portfolio.get_repository":
      return "Read one persisted GitHub portfolio repository from Visualizer. This never mutates GitHub.";
    case "portfolio.list_failures":
      return "List recent GitHub portfolio CI failures from Visualizer. This never mutates GitHub.";
    case "portfolio.list_pending_work":
      return "List pending GitHub pull requests and issues from Visualizer. This never mutates GitHub.";
    case "portfolio.list_recent_progress":
      return "List recent GitHub portfolio progress events from Visualizer. This never mutates GitHub.";
  }
}

export type PublicHttpOperation = {
  method: "get" | "post" | "put" | "patch";
  path: string;
  operationId: string;
  summary: string;
  requestSchema?: z.ZodType;
  querySchema?: z.ZodType;
  /**
   * The status code the gateway actually sends on success. Defaults to 200
   * when omitted - only set this when the runtime handler in server.ts
   * sends something else (e.g. 201 for a resource-creating POST), so the
   * generated OpenAPI document keeps matching the real response.
   */
  successStatus?: number;
  /**
   * Statuses this operation can return beyond the 400/401/403 set every route
   * shares. Set this whenever server.ts introduces a status a client is
   * expected to branch on, so the generated OpenAPI document keeps describing
   * every response a caller can actually observe.
   */
  additionalResponses?: Readonly<Record<string, { description: string }>>;
};

export const publicHttpOperations: readonly PublicHttpOperation[] = [
  {
    method: "post",
    path: "/work-items/{id}/authority-grants",
    operationId: "issueAutonomousAuthority",
    summary: "Human operator issues immutable mission-scoped autonomous authority.",
    requestSchema: issueAutonomousAuthorityBodySchema,
    successStatus: 201,
    additionalResponses: { "409": { description: "Mission, input binding or grant conflict." } }
  },
  {
    method: "get",
    path: "/work-items/{id}/authority-grants/{grantId}",
    operationId: "getAutonomousAuthority",
    summary: "Read verified grant provenance and current validity.",
    additionalResponses: {
      "404": { description: "Grant not found." },
      "409": { description: "Grant integrity failure." }
    }
  },
  {
    method: "post",
    path: "/work-items/{id}/authority-grants/{grantId}/revoke",
    operationId: "revokeAutonomousAuthority",
    summary: "Human operator revokes mission authority without erasing history.",
    requestSchema: changeSetRevocationBodySchema,
    additionalResponses: {
      "404": { description: "Grant not found." },
      "409": { description: "Grant integrity failure." }
    }
  },
  {
    method: "post",
    path: "/work-items/{id}/change-sets/authorize",
    operationId: "authorizeChangeSetWithGrant",
    summary: "Bind a current immutable snapshot and deterministic policy to a human-issued grant.",
    requestSchema: grantAuthorizationBodySchema,
    successStatus: 201,
    additionalResponses: { "409": { description: "Grant, policy or snapshot does not authorize this Change Set." } }
  },
  {
    method: "get",
    path: "/work-items/{id}/change-set-authorizations/{authorizationId}",
    operationId: "getGrantAuthorization",
    summary: "Read exact-snapshot grant authorization and current validity.",
    additionalResponses: {
      "404": { description: "Authorization not found." },
      "409": { description: "Authorization integrity failure." }
    }
  },
  {
    method: "post",
    path: "/work-items/{id}/change-sets/operations/{operationId}/permit",
    operationId: "permitChangeSetOperation",
    summary: "Bind an approved operation to canonical governed execution.",
    requestSchema: changeSetOperationPermitBodySchema,
    successStatus: 201
  },
  {
    method: "post",
    path: "/work-items/{id}/change-sets/approve",
    operationId: "approveChangeSet",
    summary: "Record human approval of the exact current Change Set after deterministic policy reevaluation.",
    requestSchema: changeSetApprovalBodySchema,
    successStatus: 201,
    additionalResponses: {
      "404": { description: "Mission not found." },
      "409": { description: "Policy, authority or snapshot conflict." }
    }
  },
  {
    method: "get",
    path: "/work-items/{id}/change-set-approvals/{approvalId}",
    operationId: "getChangeSetApproval",
    summary: "Read immutable approval evidence and current validity.",
    additionalResponses: {
      "404": { description: "Approval not found." },
      "409": { description: "Approval integrity mismatch." }
    }
  },
  {
    method: "post",
    path: "/work-items/{id}/change-set-approvals/{approvalId}/revoke",
    operationId: "revokeChangeSetApproval",
    summary: "Revoke an immutable bundle approval with human authority.",
    requestSchema: changeSetRevocationBodySchema,
    additionalResponses: {
      "404": { description: "Approval not found." },
      "409": { description: "Approval integrity mismatch." }
    }
  },
  {
    method: "post",
    path: "/work-items/{id}/change-sets/policy",
    operationId: "evaluateChangeSetPolicy",
    summary: "Evaluate the current immutable snapshot using canonical runtime facts without issuing authority.",
    requestSchema: changeSetPolicyBodySchema,
    additionalResponses: {
      "404": { description: "Mission not found." },
      "409": { description: "Snapshot or runtime binding conflict." }
    }
  },
  { method: "get", path: "/livez", operationId: "getLiveness", summary: "Read process liveness." },
  { method: "get", path: "/readyz", operationId: "getReadiness", summary: "Read control-plane readiness." },
  { method: "get", path: "/health", operationId: "getHealth", summary: "Read control-plane health." },
  {
    method: "get",
    path: "/authority",
    operationId: "getAuthority",
    summary: "Read the canonical execution mode and managed authority observation."
  },
  {
    method: "get",
    path: "/execution-mode",
    operationId: "getExecutionMode",
    summary: "Read the canonical strict/admin execution mode."
  },
  {
    method: "post",
    path: "/execution-mode",
    operationId: "setExecutionMode",
    summary: "Set the canonical strict/admin execution mode.",
    requestSchema: executionModeBodySchema
  },
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
    requestSchema: connectorBodySchema,
    successStatus: 201
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
    requestSchema: tunnelSessionBodySchema,
    successStatus: 201
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
    path: "/policy/explain",
    operationId: "explainPolicy",
    summary: "Explain a candidate policy decision without executing it.",
    requestSchema: explainPolicyInputSchema
  },
  {
    method: "post",
    path: "/work-items",
    operationId: "createWorkItem",
    summary: "Create a governed work item.",
    requestSchema: createWorkItemSchema,
    successStatus: 201
  },
  {
    method: "post",
    path: "/webhooks/{source}",
    operationId: "ingestWebhook",
    summary: "Ingest an external webhook as a governed ACS work item.",
    requestSchema: webhookIngestSchema,
    successStatus: 201
  },
  { method: "get", path: "/work-items/{id}", operationId: "getWorkItem", summary: "Read a governed work item." },
  {
    method: "post",
    path: "/work-items/{id}/change-sets",
    operationId: "submitChangeSet",
    summary: "Submit an immutable mission execution proposal without granting authority.",
    requestSchema: changeSetSubmissionBodySchema,
    successStatus: 201,
    additionalResponses: {
      "404": { description: "Mission not found." },
      "409": { description: "Mission, revision, submission or integrity conflict." }
    }
  },
  {
    method: "get",
    path: "/work-items/{id}/change-sets",
    operationId: "getChangeSet",
    summary: "Read the current or a historical immutable mission execution snapshot.",
    additionalResponses: {
      "404": { description: "Mission or revision not found." },
      "409": { description: "Snapshot integrity mismatch." }
    }
  },
  {
    method: "get",
    path: "/work-items/{id}/change-sets/progress",
    operationId: "getChangeSetProgress",
    summary: "Reconstruct operation progress and verified completion from canonical persisted evidence.",
    additionalResponses: {
      "404": { description: "Mission or Change Set not found." },
      "409": { description: "Revision or persisted execution integrity mismatch." }
    }
  },
  {
    method: "get",
    path: "/work-items/{id}/mission-trace",
    operationId: "getMissionTrace",
    querySchema: missionTraceQuerySchema,
    summary:
      "Read a paginated hash-verified mission audit projection spanning parent, children and execution evidence.",
    additionalResponses: { "409": { description: "Persisted mission or audit integrity mismatch." } }
  },
  {
    method: "get",
    path: "/work-items/{id}/change-set-review",
    operationId: "getChangeSetReviewContext",
    summary: "Read canonical result, evidence, requirements and reviews for independent assessment.",
    additionalResponses: { "409": { description: "No observed result or invalid persisted execution evidence." } }
  },
  {
    method: "post",
    path: "/work-items/{id}/change-set-review",
    operationId: "reviewChangeSetOperation",
    summary: "Record an independently authenticated review bound to persisted execution evidence.",
    requestSchema: changeSetReviewBodySchema,
    additionalResponses: {
      "403": { description: "Independent reviewer authority required." },
      "409": { description: "Result, evidence, reviewer or replay binding conflict." }
    }
  },
  {
    method: "post",
    path: "/work-items/{id}/change-sets/complete",
    operationId: "completeChangeSetMission",
    summary:
      "Close the bound mission only after all operation results and required evidence are independently validated.",
    requestSchema: changeSetOperationPermitBodySchema,
    additionalResponses: {
      "409": { description: "Authority, revision, result, verification or mission state prevents completion." }
    }
  },
  {
    method: "post",
    path: "/coding-missions",
    operationId: "createCodingMission",
    summary: "Create a coding mission and run autonomous preparation until the approval boundary.",
    requestSchema: codingMissionCreateBodySchema,
    successStatus: 201,
    additionalResponses: {
      "503": { description: "Coding mission ports are not configured." },
      "409": { description: "Mission identity, plan, or persisted state conflict." }
    }
  },
  {
    method: "get",
    path: "/coding-missions",
    operationId: "listCodingMissions",
    summary: "List recent coding missions, including those waiting for change-set approval.",
    additionalResponses: {
      "503": { description: "Coding mission ports are not configured." }
    }
  },
  {
    method: "get",
    path: "/coding-missions/{id}",
    operationId: "getCodingMission",
    summary: "Read the approval-oriented coding mission view, including Change Set identity and execution progress.",
    additionalResponses: {
      "503": { description: "Coding mission ports are not configured." },
      "409": { description: "Mission is missing or its persisted state conflicts." }
    }
  },
  {
    method: "post",
    path: "/coding-missions/{id}/approve",
    operationId: "approveCodingChangeSet",
    summary: "Approve one immutable coding Change Set and continue governed execution without another confirmation.",
    requestSchema: codingMissionApprovalBodySchema,
    additionalResponses: {
      "503": { description: "Coding mission ports are not configured." },
      "409": {
        description: "Approval does not match the immutable Change Set or the mission is not awaiting approval."
      }
    }
  },
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
    requestSchema: submitWorkResultSchema,
    successStatus: 201
  },
  {
    method: "post",
    path: "/work-items/{id}/retry",
    operationId: "retryWorkItem",
    summary: "Create an immutable retry work item.",
    requestSchema: retryBodySchema,
    successStatus: 201
  },
  {
    method: "post",
    path: "/work-items/{id}/clone",
    operationId: "cloneWorkItem",
    summary: "Create an immutable clone work item.",
    requestSchema: cloneBodySchema,
    successStatus: 201
  },
  { method: "get", path: "/api/actors", operationId: "listActors", summary: "List registered actors." },
  {
    method: "post",
    path: "/api/actors",
    operationId: "registerActor",
    summary: "Register an actor.",
    requestSchema: actorBodySchema,
    successStatus: 201
  },
  { method: "get", path: "/actors", operationId: "listActorsAlias", summary: "List registered actors." },
  {
    method: "post",
    path: "/actors",
    operationId: "registerActorAlias",
    summary: "Register an actor.",
    requestSchema: actorBodySchema,
    successStatus: 201
  },
  { method: "get", path: "/api/agents", operationId: "listAgents", summary: "List registered agents." },
  {
    method: "post",
    path: "/api/agents",
    operationId: "registerAgent",
    summary: "Register an agent.",
    requestSchema: agentBodySchema,
    successStatus: 201
  },
  {
    method: "get",
    path: "/api/mcp-clients",
    operationId: "listMcpClients",
    summary: "List the MCP clients seen on the Jace/Desktop Commander edge lanes with their operator labels."
  },
  {
    method: "post",
    path: "/api/mcp-clients/label",
    operationId: "labelMcpClient",
    summary: "Label a seen MCP client (human operator only).",
    requestSchema: mcpClientLabelBodySchema
  },
  {
    method: "post",
    path: "/api/mcp-clients/label/clear",
    operationId: "clearMcpClientLabel",
    summary: "Remove an MCP client label (human operator only).",
    requestSchema: mcpClientClearBodySchema
  },
  {
    method: "post",
    path: "/mcp-clients/observe",
    operationId: "observeMcpClient",
    summary: "Edge bridge reports a verified client connection (bridge identity only).",
    requestSchema: mcpObservationBodySchema,
    successStatus: 202
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
    requestSchema: heartbeatBodySchema,
    successStatus: 201
  },
  { method: "get", path: "/agents", operationId: "listAcpAgents", summary: "List agents through the ACP view." },
  {
    method: "get",
    path: "/agents/{id}",
    operationId: "getAcpAgent",
    summary: "Read an agent through the ACP view."
  },
  {
    method: "get",
    path: "/events",
    operationId: "streamEvents",
    summary: "Stream audit events over SSE.",
    additionalResponses: {
      "503": {
        description:
          "Event stream capacity reached, globally or for this principal. Body carries code sse_capacity_reached; retry-after indicates when to retry."
      }
    }
  }
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
