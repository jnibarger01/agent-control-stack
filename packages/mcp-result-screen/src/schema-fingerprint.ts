import { stableHash } from "@agent-control-stack/shared";
import { z } from "zod";

/**
 * Canonical semantic fingerprint of an MCP tool schema.
 *
 * Two schemas that differ only in presentation (key order, `description`,
 * `title`, `$comment`, `examples`, `default`, `$id`) MUST fingerprint the same.
 * A security-significant change MUST change the fingerprint:
 *   - a parameter added or removed
 *   - a parameter type change
 *   - a requiredness change
 *   - a relevant constraint change (min/max, length, pattern, enum, format, …)
 *   - a result-schema change, when ACS relies on the result schema
 *
 * Accepts either a JSON Schema object (as advertised by an upstream MCP
 * `tools/list`) or a Zod schema (as ACS registers the expected argument shape).
 * Both are projected onto ONE canonical vocabulary so an ACS expectation and an
 * upstream advertisement are directly comparable.
 */

export const MCP_TOOL_SCHEMA_FINGERPRINT_DOMAIN = "acs.mcp-tool-schema.v1" as const;

/** JSON Schema keywords that carry meaning for authorization. Everything else is dropped. */
const SEMANTIC_KEYWORDS = new Set<string>([
  "type",
  "properties",
  "required",
  "items",
  "prefixItems",
  "additionalItems",
  "additionalProperties",
  "patternProperties",
  "propertyNames",
  "dependentRequired",
  "enum",
  "const",
  "anyOf",
  "oneOf",
  "allOf",
  "not",
  "$ref",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties"
]);

/** Keywords whose array value has no semantic order — sort by canonical hash. */
const UNORDERED_ARRAY_KEYWORDS = new Set<string>(["anyOf", "oneOf", "allOf", "enum"]);

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Canonicalise a JSON Schema fragment: keep only semantic keywords, recurse,
 * and order-normalise arrays whose order is not meaningful. Object-key ordering
 * is handled downstream by `stableHash`.
 */
export function canonicalJsonSchema(schema: unknown): Json {
  if (Array.isArray(schema)) {
    return schema.map((entry) => canonicalJsonSchema(entry));
  }
  if (!isPlainObject(schema)) {
    return (schema ?? null) as Json;
  }

  const out: Record<string, Json> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!SEMANTIC_KEYWORDS.has(key)) continue;

    if (key === "required" && Array.isArray(value)) {
      out.required = [...value.map(String)].sort();
      continue;
    }
    if (key === "type" && Array.isArray(value)) {
      out.type = [...value.map(String)].sort();
      continue;
    }
    if (key === "properties" && isPlainObject(value)) {
      const props: Record<string, Json> = {};
      for (const [propName, propSchema] of Object.entries(value)) {
        props[propName] = canonicalJsonSchema(propSchema);
      }
      out.properties = props;
      continue;
    }
    if (UNORDERED_ARRAY_KEYWORDS.has(key) && Array.isArray(value)) {
      const canonicalMembers = value.map((entry) => canonicalJsonSchema(entry));
      canonicalMembers.sort((a, b) => stableHash(a).localeCompare(stableHash(b)));
      out[key] = canonicalMembers;
      continue;
    }
    out[key] = canonicalJsonSchema(value);
  }
  return out;
}

/**
 * Project a Zod (v4) schema onto the SAME canonical JSON-Schema vocabulary as
 * `canonicalJsonSchema`, so the ACS-registered expected argument schema and an
 * upstream-advertised JSON Schema produce comparable fingerprints. Only the
 * constructs ACS actually uses for tool arguments are modelled; an unknown
 * construct degrades to its wrapped/inner type (or `{}`) rather than throwing.
 */
function zodDef(schema: z.ZodTypeAny): Record<string, unknown> {
  const s = schema as unknown as { _def?: Record<string, unknown>; def?: Record<string, unknown> };
  return s._def ?? s.def ?? {};
}

function zodChecks(def: Record<string, unknown>): Array<Record<string, unknown>> {
  const raw = (def.checks as Array<{ _zod?: { def?: Record<string, unknown> } }>) ?? [];
  return raw.map((check) => (check._zod?.def ?? (check as Record<string, unknown>)) as Record<string, unknown>);
}

export function canonicalZodSchema(schema: z.ZodTypeAny): Json {
  const def = zodDef(schema);
  const type = def.type as string | undefined;

  switch (type) {
    case "object": {
      const shape = (def.shape as Record<string, z.ZodTypeAny>) ?? {};
      const properties: Record<string, Json> = {};
      const required: string[] = [];
      for (const [key, child] of Object.entries(shape)) {
        properties[key] = canonicalZodSchema(child);
        if (!isOptionalZod(child)) required.push(key);
      }
      const catchallType = def.catchall ? (zodDef(def.catchall as z.ZodTypeAny).type as string | undefined) : undefined;
      return {
        type: "object",
        properties,
        required: required.sort(),
        additionalProperties: catchallType === "unknown" ? true : false
      };
    }
    case "string": {
      const node: Record<string, Json> = { type: "string" };
      for (const check of zodChecks(def)) {
        if (check.check === "min_length") node.minLength = check.minimum as number;
        else if (check.check === "max_length") node.maxLength = check.maximum as number;
        else if (check.check === "length_equals") {
          node.minLength = check.length as number;
          node.maxLength = check.length as number;
        } else if (check.check === "string_format") {
          node.format = check.format === "regex" ? `regex:${String((check.pattern as { source?: string })?.source ?? check.pattern)}` : (check.format as string);
        }
      }
      return node;
    }
    case "number":
    case "int": {
      const node: Record<string, Json> = { type: type === "int" ? "integer" : "number" };
      for (const check of zodChecks(def)) {
        if (check.check === "number_format" && (check.format === "safeint" || check.format === "int32")) node.type = "integer";
        else if (check.check === "greater_than") node[check.inclusive ? "minimum" : "exclusiveMinimum"] = check.value as number;
        else if (check.check === "less_than") node[check.inclusive ? "maximum" : "exclusiveMaximum"] = check.value as number;
        else if (check.check === "multiple_of") node.multipleOf = check.value as number;
      }
      return node;
    }
    case "boolean":
      return { type: "boolean" };
    case "literal": {
      const values = (def.values as Json[]) ?? [];
      return values.length === 1 ? { const: values[0] as Json } : { enum: [...values].sort((a, b) => stableHash(a).localeCompare(stableHash(b))) };
    }
    case "enum": {
      const entries = (def.entries as Record<string, string | number>) ?? {};
      return { enum: [...Object.values(entries)].map((v) => v as Json).sort((a, b) => stableHash(a).localeCompare(stableHash(b))) };
    }
    case "array": {
      const node: Record<string, Json> = { type: "array", items: canonicalZodSchema(def.element as z.ZodTypeAny) };
      for (const check of zodChecks(def)) {
        if (check.check === "min_length") node.minItems = check.minimum as number;
        else if (check.check === "max_length") node.maxItems = check.maximum as number;
      }
      return node;
    }
    case "union": {
      const options = (def.options as z.ZodTypeAny[]) ?? [];
      const members = options.map((option) => canonicalZodSchema(option));
      members.sort((a, b) => stableHash(a).localeCompare(stableHash(b)));
      return { anyOf: members };
    }
    case "record":
      return { type: "object", additionalProperties: canonicalZodSchema(def.valueType as z.ZodTypeAny) };
    case "tuple":
      return { type: "array", prefixItems: ((def.items as z.ZodTypeAny[]) ?? []).map((item) => canonicalZodSchema(item)) };
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "catch":
    case "readonly":
    case "nonoptional":
    case "branded":
      return canonicalZodSchema(def.innerType as z.ZodTypeAny);
    case "pipe":
      return canonicalZodSchema((def.in ?? def.out) as z.ZodTypeAny);
    case "lazy":
      return canonicalZodSchema((def.getter as () => z.ZodTypeAny)());
    case "unknown":
    case "any":
      return {};
    default:
      return {};
  }
}

function isOptionalZod(schema: z.ZodTypeAny): boolean {
  const def = zodDef(schema);
  const type = def.type as string | undefined;
  if (type === "optional" || type === "default" || type === "prefault") return true;
  if (type === "nullable" || type === "readonly" || type === "branded" || type === "catch") {
    return isOptionalZod(def.innerType as z.ZodTypeAny);
  }
  if (type === "pipe") return isOptionalZod((def.in ?? def.out) as z.ZodTypeAny);
  return false;
}

export interface ToolSchemaFingerprintInput {
  /** Upstream-advertised JSON Schema, or an ACS Zod schema. */
  inputSchema: unknown;
  /** Result schema, only when ACS relies on it. */
  outputSchema?: unknown;
}

function canonicaliseAny(schema: unknown): Json {
  if (schema instanceof z.ZodType) return canonicalZodSchema(schema);
  return canonicalJsonSchema(schema);
}

/** Deterministic fingerprint over the canonical semantic schema. */
export function toolSchemaFingerprint(input: ToolSchemaFingerprintInput): string {
  return stableHash({
    domain: MCP_TOOL_SCHEMA_FINGERPRINT_DOMAIN,
    input: canonicaliseAny(input.inputSchema),
    output: input.outputSchema === undefined ? null : canonicaliseAny(input.outputSchema)
  });
}
