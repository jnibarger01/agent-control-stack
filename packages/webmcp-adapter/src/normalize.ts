import { stableHash } from "@agent-control-stack/shared";
import {
  WebMcpError,
  WebMcpErrorCode,
  discoveredToolSchema,
  pageIdentitySchema,
  webmcpAnnotations,
  webmcpInputSchema,
  type DiscoveredTool,
  type PageIdentity,
  type RawToolRecord,
  type WebMcpAnnotations,
  type WebMcpFieldSchema,
  type WebMcpInputSchema
} from "./contracts.js";
import type { JsonValue } from "./json.js";

/**
 * Normalization boundary.
 *
 * Chrome 154's live `getTools()` contract differs from the page-side authoring
 * API in three ways that this module absorbs:
 *   1. `inputSchema` is a JSON *string*, not an object.
 *   2. records carry extra fields (`window`, `origin`, `title`) that are
 *      stripped/kept explicitly rather than spread through.
 *   3. `annotations` may be `null`.
 * Everything here is pure and total: unsupported input becomes a stable
 * `WebMcpError` code, never a best-effort coercion.
 */

const ROOT_KEYS = ["type", "properties", "required", "additionalProperties", "description", "title", "$schema"];
const FIELD_KEYS = ["type", "enum", "description", "title"];
const SCALAR_TYPES = ["string", "number", "integer", "boolean"] as const;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function matchesType(value: unknown, type: WebMcpFieldSchema["type"]): boolean {
  if (type === "integer") return typeof value === "number" && Number.isSafeInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

/**
 * Parse the JSON-string schema Chrome returns. Accepts only the narrow
 * supported subset; anything richer is `schema_unsupported` rather than a
 * silently weakened schema.
 */
export function parseInputSchema(inputSchema: unknown): WebMcpInputSchema {
  if (inputSchema === undefined || inputSchema === null) {
    throw new WebMcpError(WebMcpErrorCode.SchemaUnsupported, "tool has no inputSchema");
  }
  let parsed: unknown = inputSchema;
  if (typeof inputSchema === "string") {
    if (inputSchema.length > 262_144) {
      throw new WebMcpError(WebMcpErrorCode.SchemaInvalid, "inputSchema string is too large");
    }
    try {
      parsed = JSON.parse(inputSchema) as unknown;
    } catch {
      throw new WebMcpError(WebMcpErrorCode.SchemaInvalid, "inputSchema is not valid JSON");
    }
  }
  if (!isRecord(parsed)) {
    throw new WebMcpError(WebMcpErrorCode.SchemaUnsupported, "inputSchema is not an object");
  }
  if (parsed.type !== "object") {
    throw new WebMcpError(WebMcpErrorCode.SchemaUnsupported, "inputSchema root must be type object");
  }
  if (parsed.additionalProperties !== false) {
    throw new WebMcpError(
      WebMcpErrorCode.SchemaUnsupported,
      "inputSchema must set additionalProperties:false"
    );
  }
  if (Object.keys(parsed).some((key) => !ROOT_KEYS.includes(key))) {
    throw new WebMcpError(WebMcpErrorCode.SchemaUnsupported, "inputSchema has unsupported root keywords");
  }
  if (!isRecord(parsed.properties)) {
    throw new WebMcpError(WebMcpErrorCode.SchemaUnsupported, "inputSchema must declare properties");
  }

  const required = parsed.required === undefined ? [] : parsed.required;
  if (!Array.isArray(required) || required.some((key) => typeof key !== "string")) {
    throw new WebMcpError(WebMcpErrorCode.SchemaInvalid, "inputSchema required must be a string array");
  }

  const properties: Record<string, WebMcpFieldSchema> = Object.create(null) as Record<string, WebMcpFieldSchema>;
  for (const [name, rawField] of Object.entries(parsed.properties)) {
    if (!isRecord(rawField)) {
      throw new WebMcpError(WebMcpErrorCode.SchemaUnsupported, `property ${name} is not an object`);
    }
    if (Object.keys(rawField).some((key) => !FIELD_KEYS.includes(key))) {
      throw new WebMcpError(WebMcpErrorCode.SchemaUnsupported, `property ${name} uses unsupported keywords`);
    }
    const type = rawField.type;
    if (typeof type !== "string" || !SCALAR_TYPES.includes(type as (typeof SCALAR_TYPES)[number])) {
      throw new WebMcpError(WebMcpErrorCode.SchemaUnsupported, `property ${name} has an unsupported type`);
    }
    const field: WebMcpFieldSchema = { type: type as WebMcpFieldSchema["type"] };
    if (rawField.enum !== undefined) {
      const values = rawField.enum;
      if (!Array.isArray(values) || values.length === 0) {
        throw new WebMcpError(WebMcpErrorCode.SchemaInvalid, `property ${name} enum must be a non-empty array`);
      }
      if (values.some((value) => !matchesType(value, field.type))) {
        throw new WebMcpError(WebMcpErrorCode.SchemaInvalid, `property ${name} enum values must match its type`);
      }
      field.enum = values as (string | number | boolean)[];
    }
    properties[name] = field;
  }
  if (required.some((name) => !(name in properties))) {
    throw new WebMcpError(WebMcpErrorCode.SchemaInvalid, "inputSchema requires an undeclared property");
  }

  const result = webmcpInputSchema.safeParse({
    type: "object",
    properties,
    required: [...new Set(required)],
    additionalProperties: false
  });
  if (!result.success) {
    throw new WebMcpError(WebMcpErrorCode.SchemaInvalid, "inputSchema failed canonical validation");
  }
  return result.data;
}

/**
 * Normalize annotations. `null`/absent becomes `null` (unknown), never
 * `readOnly`. Unknown keys are rejected so a page cannot smuggle a signal
 * through a field the adapter would ignore.
 */
export function normalizeAnnotations(value: unknown): WebMcpAnnotations | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) {
    throw new WebMcpError(WebMcpErrorCode.AnnotationInvalid, "annotations must be an object or null");
  }
  const names = ["readOnlyHint", "consequentialHint", "untrustedContentHint"] as const;
  if (Object.keys(value).some((key) => !names.includes(key as (typeof names)[number]))) {
    throw new WebMcpError(WebMcpErrorCode.AnnotationInvalid, "annotations contain unsupported keys");
  }
  for (const name of names) {
    if (value[name] !== undefined && typeof value[name] !== "boolean") {
      throw new WebMcpError(WebMcpErrorCode.AnnotationInvalid, `annotation ${name} must be a boolean`);
    }
  }
  return webmcpAnnotations.parse({
    readOnlyHint: value.readOnlyHint === true,
    consequentialHint: value.consequentialHint === true,
    untrustedContentHint: value.untrustedContentHint === true
  });
}

/** Strict argument validation against the normalized schema. */
export function validateArguments(args: unknown, schema: WebMcpInputSchema): Record<string, JsonValue> {
  if (!isRecord(args)) {
    throw new WebMcpError(WebMcpErrorCode.ArgumentsInvalid, "arguments must be an object");
  }
  const unknownKeys = Object.keys(args).filter((key) => !(key in schema.properties));
  if (unknownKeys.length > 0) {
    throw new WebMcpError(WebMcpErrorCode.ArgumentsInvalid, "arguments contain undeclared properties");
  }
  for (const name of schema.required) {
    if (!(name in args)) {
      throw new WebMcpError(WebMcpErrorCode.ArgumentsInvalid, `argument ${name} is required`);
    }
  }
  const validated: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const [name, value] of Object.entries(args)) {
    const field = schema.properties[name];
    if (!field || !matchesType(value, field.type)) {
      throw new WebMcpError(WebMcpErrorCode.ArgumentsInvalid, `argument ${name} does not match its schema`);
    }
    if (field.enum && !field.enum.includes(value as string | number | boolean)) {
      throw new WebMcpError(WebMcpErrorCode.ArgumentsInvalid, `argument ${name} is not an allowed value`);
    }
    validated[name] = value as JsonValue;
  }
  return validated;
}

/** Canonical digest of a normalized schema. */
export function schemaHash(schema: WebMcpInputSchema): string {
  return stableHash({ domain: "acs:webmcp-schema:v1", schema });
}

/** Canonical digest of a tool's identity as discovered on the live page. */
export function registrationHash(input: {
  name: string;
  title: string;
  description: string;
  origin: string;
  schema: WebMcpInputSchema;
  annotations: WebMcpAnnotations | null;
}): string {
  return stableHash({
    domain: "acs:webmcp-registration:v1",
    name: input.name,
    title: input.title,
    description: input.description,
    origin: input.origin,
    schema: input.schema,
    annotations: input.annotations
  });
}

export function normalizeRawTool(raw: RawToolRecord, origin: string): DiscoveredTool {
  if (typeof raw.name !== "string" || raw.name.length === 0) {
    throw new WebMcpError(WebMcpErrorCode.RegistrationInvalid, "tool name must be a non-empty string");
  }
  if (raw.description !== undefined && raw.description !== null && typeof raw.description !== "string") {
    throw new WebMcpError(WebMcpErrorCode.RegistrationInvalid, "tool description must be a string");
  }
  if (raw.title !== undefined && raw.title !== null && typeof raw.title !== "string") {
    throw new WebMcpError(WebMcpErrorCode.RegistrationInvalid, "tool title must be a string");
  }
  const schema = parseInputSchema(raw.inputSchema);
  const annotations = normalizeAnnotations(raw.annotations);
  const candidate = {
    name: raw.name,
    title: typeof raw.title === "string" ? raw.title : "",
    description: typeof raw.description === "string" ? raw.description : "",
    origin,
    inputSchema: schema,
    schemaHash: schemaHash(schema),
    annotations,
    registrationHash: registrationHash({
      name: raw.name,
      title: typeof raw.title === "string" ? raw.title : "",
      description: typeof raw.description === "string" ? raw.description : "",
      origin,
      schema,
      annotations
    })
  };
  const parsed = discoveredToolSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new WebMcpError(WebMcpErrorCode.RegistrationInvalid, "tool record failed canonical validation");
  }
  return parsed.data;
}

/**
 * Derive the opaque discovery handle. Deterministic over the complete binding,
 * so `webmcp.list_tools` output cannot be replayed against a different
 * session/page/navigation/tool/schema.
 */
export function deriveDiscoveryId(identity: PageIdentity, tool: DiscoveredTool): string {
  return stableHash({
    domain: "acs:webmcp-discovery:v1",
    sessionId: identity.sessionId,
    pageId: identity.pageId,
    origin: identity.origin,
    pageUrl: identity.pageUrl,
    navigationId: identity.navigationId,
    toolName: tool.name,
    registrationHash: tool.registrationHash,
    schemaHash: tool.schemaHash
  });
}

/** Canonical digest of one exact prospective call: the approval-bound action. */
export function invocationFingerprint(input: {
  identity: PageIdentity;
  toolName: string;
  registrationHash: string;
  schemaHash: string;
  arguments: Record<string, JsonValue>;
}): string {
  return stableHash({
    domain: "acs:webmcp-invocation:v1",
    sessionId: input.identity.sessionId,
    pageId: input.identity.pageId,
    origin: input.identity.origin,
    pageUrl: input.identity.pageUrl,
    navigationId: input.identity.navigationId,
    toolName: input.toolName,
    registrationHash: input.registrationHash,
    schemaHash: input.schemaHash,
    arguments: input.arguments
  });
}

/**
 * Origin trust for the executor's own browser. Chrome gates WebMCP on a secure
 * context and reports `SecureLocalhost` for loopback; requiring `https:` alone
 * would make the controlled local test page unusable. Schemeless, credentialed,
 * and non-loopback plaintext origins stay rejected.
 */
export function assertTrustedOrigin(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new WebMcpError(WebMcpErrorCode.OriginUntrusted, "origin is not a valid URL");
  }
  if (url.origin !== origin) {
    throw new WebMcpError(WebMcpErrorCode.OriginUntrusted, "origin must be a bare serialized origin");
  }
  if (url.username || url.password) {
    throw new WebMcpError(WebMcpErrorCode.OriginUntrusted, "origin must not carry credentials");
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "localhost";
  if (url.protocol === "https:") return origin;
  if (url.protocol === "http:" && loopback) return origin;
  throw new WebMcpError(WebMcpErrorCode.OriginUntrusted, "origin must be https or loopback");
}

export function assertPageIdentity(value: unknown): PageIdentity {
  const parsed = pageIdentitySchema.safeParse(value);
  if (!parsed.success) {
    throw new WebMcpError(WebMcpErrorCode.DiscoveryInvalid, "page identity failed canonical validation");
  }
  assertTrustedOrigin(parsed.data.origin);
  return parsed.data;
}

/** Hash of the normalized arguments alone (the "args hash" on a binding). */
export function argumentsHash(args: Record<string, JsonValue>): string {
  return stableHash({ kind: "webmcp.arguments", args });
}
