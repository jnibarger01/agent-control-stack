import { z } from "zod";

/**
 * Canonical WebMCP adapter contracts.
 *
 * WebMCP is an execution surface. Nothing a page reports is ever an authority:
 * no schema, annotation, title, description, origin claim, or result is trusted
 * to permit execution. Every permitted call is bound to an ACS work item and an
 * ACS-issued `WebMcpExecutionAuthorization` (see `execution-authorization.ts`).
 */

/** ACS-owned risk vocabulary. Never derived from page-supplied annotations. */
export const webmcpRiskClasses = ["read_only", "reversible_mutation"] as const;
export type WebMcpRiskClass = (typeof webmcpRiskClasses)[number];

/** The two primitives the live Chrome contract exposes. */
export const webmcpPrimitives = ["getTools", "executeTool"] as const;

const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u, "identifier must be a bounded opaque token");
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u, "expected a sha-256 hex digest");

/** Tool names come from the page, so they are bounded and charset-restricted. */
const toolNameSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z_][A-Za-z0-9_.:-]*$/u, "tool name must be a bounded identifier");

const jsonScalarSchema = z.union([z.string(), z.number(), z.boolean()]);

/**
 * Normalized field schema. The adapter supports a deliberately narrow subset:
 * flat objects of scalars (optionally enumerated). Anything else is
 * `schema_unsupported` rather than "probably fine".
 */
export const webmcpFieldSchema = z
  .object({
    type: z.enum(["string", "number", "integer", "boolean"]),
    enum: z.array(jsonScalarSchema).min(1).max(256).optional()
  })
  .strict();
export type WebMcpFieldSchema = z.infer<typeof webmcpFieldSchema>;

export const webmcpInputSchema = z
  .object({
    type: z.literal("object"),
    properties: z.record(z.string().min(1).max(200), webmcpFieldSchema),
    required: z.array(z.string().min(1).max(200)).max(256),
    additionalProperties: z.literal(false)
  })
  .strict();
export type WebMcpInputSchema = z.infer<typeof webmcpInputSchema>;

/**
 * Chrome normalizes page annotations to this shape. It is advisory only: it can
 * never lower ACS risk (see `normalize.ts` / `policy.ts`).
 */
export const webmcpAnnotations = z
  .object({
    readOnlyHint: z.boolean(),
    consequentialHint: z.boolean(),
    untrustedContentHint: z.boolean()
  })
  .strict();
export type WebMcpAnnotations = z.infer<typeof webmcpAnnotations>;

export const discoveredToolSchema = z
  .object({
    name: toolNameSchema,
    title: z.string().max(512),
    description: z.string().max(4_096),
    origin: z.string().min(1).max(2_048),
    inputSchema: webmcpInputSchema,
    schemaHash: hashSchema,
    annotations: webmcpAnnotations.nullable(),
    registrationHash: hashSchema
  })
  .strict();
export type DiscoveredTool = z.infer<typeof discoveredToolSchema>;

/**
 * Session/page/navigation identity captured at discovery time. A discovery
 * record is only usable while every one of these still matches live state.
 */
export const pageIdentitySchema = z
  .object({
    sessionId: identifierSchema,
    pageId: identifierSchema,
    origin: z.string().min(1).max(2_048),
    pageUrl: z.string().min(1).max(4_096),
    navigationId: identifierSchema
  })
  .strict();
export type PageIdentity = z.infer<typeof pageIdentitySchema>;

/**
 * The opaque handle returned by `webmcp.list_tools` and required by
 * `webmcp.call_tool`. It is a deterministic digest of the full binding, so a
 * caller cannot mint one for a tool it never discovered.
 */
export const discoveryRecordSchema = z
  .object({
    discoveryId: hashSchema,
    sessionId: identifierSchema,
    pageId: identifierSchema,
    origin: z.string().min(1).max(2_048),
    pageUrl: z.string().min(1).max(4_096),
    navigationId: identifierSchema,
    tool: discoveredToolSchema,
    discoveredAt: z.string().min(1)
  })
  .strict();
export type DiscoveryRecord = z.infer<typeof discoveryRecordSchema>;

/** Exact, canonical binding of one prospective call. */
export const webmcpInvocationSchema = z
  .object({
    sessionId: identifierSchema,
    pageId: identifierSchema,
    origin: z.string().min(1).max(2_048),
    pageUrl: z.string().min(1).max(4_096),
    navigationId: identifierSchema,
    toolName: toolNameSchema,
    registrationHash: hashSchema,
    schemaHash: hashSchema,
    arguments: z.record(z.string().max(200), z.unknown())
  })
  .strict();
export type WebMcpInvocation = z.infer<typeof webmcpInvocationSchema>;

export const WEBMCP_CALL_INTENT = "webmcp.call_tool" as const;
export const WEBMCP_LIST_INTENT = "webmcp.list_tools" as const;

/**
 * Stable, non-secret failure codes. These are the only codes the adapter is
 * allowed to surface across the MCP trust boundary.
 */
export const WebMcpErrorCode = {
  GateClosed: "webmcp_live_execution_gate_closed",
  RuntimeUnavailable: "webmcp_runtime_unavailable",
  Unsupported: "webmcp_unsupported",
  DiscoveryInvalid: "webmcp_discovery_invalid",
  SchemaUnsupported: "webmcp_schema_unsupported",
  SchemaInvalid: "webmcp_schema_invalid",
  ArgumentsInvalid: "webmcp_arguments_invalid",
  AnnotationInvalid: "webmcp_annotations_invalid",
  RegistrationInvalid: "webmcp_registration_invalid",
  OriginUntrusted: "webmcp_origin_untrusted",
  StaleDiscovery: "webmcp_stale_discovery",
  SessionChanged: "webmcp_session_changed",
  PageChanged: "webmcp_page_changed",
  NavigationChanged: "webmcp_navigation_changed",
  OriginChanged: "webmcp_origin_changed",
  ToolChanged: "webmcp_tool_changed",
  SchemaChanged: "webmcp_schema_changed",
  ArgumentsChanged: "webmcp_arguments_changed",
  ToolNotFound: "webmcp_tool_not_found",
  ToolDenied: "webmcp_tool_denied",
  ApprovalRequired: "webmcp_approval_required",
  ToolFailed: "webmcp_tool_failed",
  ResultInvalid: "webmcp_result_invalid",
  Cancelled: "webmcp_cancelled",
  ReplayRejected: "webmcp_replay_rejected",
  CdpFailure: "webmcp_cdp_failure"
} as const;
export type WebMcpErrorCode = (typeof WebMcpErrorCode)[keyof typeof WebMcpErrorCode];

/** Raw tool record exactly as the live Chrome `getTools()` contract reports it. */
export interface RawToolRecord {
  readonly name: unknown;
  readonly title?: unknown;
  readonly description?: unknown;
  readonly inputSchema: unknown;
  readonly annotations?: unknown;
}

export class WebMcpError extends Error {
  constructor(
    readonly code: WebMcpErrorCode | string,
    message?: string
  ) {
    super(message ?? code);
    this.name = "WebMcpError";
  }
}
