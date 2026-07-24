import { z } from "zod";
import { canonicalJson, redactValue, stableHash } from "@agent-control-stack/shared";

const credentialBearingUriPattern =
  /(?:^|[?#&])(?:access[-_]?token|refresh[-_]?token|id[-_]?token|token|api[-_]?key|client[-_]?secret|private[-_]?key|password|secret|authorization)=[^&#\s]+/iu;

export function isCredentialFreeString(value: string): boolean {
  return redactGraphValue(value) === value;
}

const credentialFreeIdentifier = (value: string): boolean => isCredentialFreeString(value);
const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z][A-Za-z0-9._:/-]*$/u, "must be a bounded identifier")
  .refine(credentialFreeIdentifier, "must not contain credential-like material");
const graphIdentifierSchema = z
  .string()
  .min(7)
  .max(128)
  .regex(/^graph_[A-Za-z0-9][A-Za-z0-9._:/-]*$/u, "must start with graph_")
  .refine(credentialFreeIdentifier, "must not contain credential-like material");
const descriptionSchema = z.string().min(1).max(4_000);
const keySchema = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u, "must be a bounded idempotency or correlation key")
  .refine(credentialFreeIdentifier, "must not contain credential-like material");
const riskSchema = z.enum(["low", "medium", "high", "critical"]);
const jsonObjectSchema = z.record(z.string(), z.json());
const emptyResources = {
  filesystem: [] as Array<{ scope: string; access: "READ" | "WRITE" }>,
  gitWorktrees: [] as string[],
  ports: [] as number[],
  browserProfiles: [] as string[],
  services: [] as string[],
  externalTargets: [] as string[]
};

const portSchema = z
  .object({
    name: identifierSchema,
    type: identifierSchema
  })
  .strict();
const inputPortSchema = portSchema
  .extend({
    cardinality: z.enum(["ONE", "MANY"]),
    required: z.boolean()
  })
  .strict();
const filesystemScopeSchema = z
  .string()
  .min(1)
  .max(1_024)
  .regex(
    /^[a-z][a-z0-9+.-]*:\/\/[A-Za-z0-9._~:@+-]+(?:\/[A-Za-z0-9._~:@+-]+)*(?:\/\*\*)?$/u,
    "must be a canonical resource URI with only an optional terminal /** wildcard"
  )
  .refine((scope) => {
    const body = scope.slice(scope.indexOf("://") + 3).replace(/\/\*\*$/u, "");
    return body.split("/").every((segment) => segment !== "." && segment !== "..");
  }, "must not contain dot or dot-dot path segments");
const filesystemResourceSchema = z
  .object({
    scope: filesystemScopeSchema,
    access: z.enum(["READ", "WRITE"])
  })
  .strict();
const resourcesSchema = z
  .object({
    filesystem: z.array(filesystemResourceSchema).max(256),
    gitWorktrees: z.array(z.string().min(1).max(1_024)).max(64),
    ports: z.array(z.number().int().min(1).max(65_535)).max(64),
    browserProfiles: z.array(identifierSchema).max(64),
    services: z.array(identifierSchema).max(64),
    externalTargets: z.array(z.string().min(1).max(1_024)).max(64)
  })
  .strict();

const retryPolicySchema = z
  .object({
    max_attempts: z.number().int().min(1).max(10),
    backoff_ms: z.number().int().min(0).max(86_400_000)
  })
  .strict();
const legacyRetrySchema = z
  .object({
    maxAttempts: z.number().int().min(1).max(10)
  })
  .strict();
const budgetSchema = z
  .object({
    maxTokens: z.number().int().nonnegative(),
    maxCostUsd: z.number().finite().nonnegative(),
    apiSlots: z.number().int().min(0).max(1)
  })
  .strict();

/**
 * Raw v0.1 node boundary. The snake_case fields are the public contract.
 * The camelCase fields remain accepted only as the detailed static-DAG
 * representation used by the first Graph work; validation normalizes both
 * forms into one internal definition and rejects disagreements.
 */
export const graphNodeSchema = z
  .object({
    id: identifierSchema,
    function_id: identifierSchema,
    dependencies: z.array(identifierSchema).max(1_000),
    input: z.json().optional(),
    input_schema: jsonObjectSchema,
    output_schema: jsonObjectSchema,
    timeout: z.number().int().min(1).max(86_400_000),
    retry_policy: retryPolicySchema,
    risk: riskSchema,
    approval_required: z.boolean(),
    idempotency_key: keySchema,

    description: descriptionSchema.optional(),
    required: z.boolean().optional(),
    adapter: identifierSchema.optional(),
    inputs: z.array(inputPortSchema).max(256).optional(),
    outputs: z.array(portSchema).max(256).optional(),
    parameters: z.record(z.string(), z.json()).optional(),
    evidenceRequirements: z.array(identifierSchema).max(64).optional(),
    resources: resourcesSchema.optional(),
    timeoutMs: z.number().int().min(1).max(86_400_000).optional(),
    retry: legacyRetrySchema.optional(),
    budget: budgetSchema.optional(),
    sideEffect: z.enum(["NONE", "READ_ONLY", "WRITE", "EXTERNAL"]).optional(),
    approval: z.enum(["NONE", "HUMAN"]).optional()
  })
  .strict();

export const graphEdgeSchema = z
  .object({
    id: identifierSchema,
    from: z.object({ nodeId: identifierSchema, port: identifierSchema }).strict(),
    to: z.object({ nodeId: identifierSchema, port: identifierSchema }).strict(),
    required: z.boolean()
  })
  .strict();

const requestedBySchema = z
  .object({
    actor_id: identifierSchema,
    actor_type: z.enum(["human", "agent", "service", "system"])
  })
  .strict();
const limitsSchema = z
  .object({
    maxWorkers: z.number().int().min(1).max(64),
    maxDepth: z.number().int().min(1).max(128),
    wallClockMs: z.number().int().min(1).max(86_400_000),
    tokenCeiling: z.number().int().nonnegative(),
    dollarCeilingUsd: z.number().finite().nonnegative(),
    apiConcurrency: z.number().int().min(1).max(64)
  })
  .strict();
const verdictPolicySchema = z
  .object({
    requiredFailure: z.enum(["FAIL", "PARTIAL"]),
    optionalFailure: z.enum(["IGNORE", "PARTIAL"]),
    requiredCoverage: z.number().min(0).max(1)
  })
  .strict();

/** Public graph envelope. It intentionally requires the authority and
 * replay-boundary fields before a graph may enter the SQLite ledger. */
export const graphDefinitionSchema = z
  .object({
    graph_id: graphIdentifierSchema,
    version: z.literal("0.1"),
    requested_by: requestedBySchema,
    intent: descriptionSchema,
    nodes: z.array(graphNodeSchema).max(1_000),
    risk: riskSchema,
    idempotency_key: keySchema,
    correlation_id: keySchema,

    schemaVersion: z.literal("0.1").optional(),
    graphId: identifierSchema.optional(),
    objective: descriptionSchema.optional(),
    edges: z.array(graphEdgeSchema).max(10_000).optional(),
    acceptanceTests: z
      .array(
        z
          .object({
            id: identifierSchema,
            description: descriptionSchema,
            required: z.boolean(),
            nodeIds: z.array(identifierSchema).min(1).max(1_000)
          })
          .strict()
      )
      .max(1_000)
      .optional(),
    limits: limitsSchema.optional(),
    verdictPolicy: verdictPolicySchema.optional()
  })
  .strict();

export function graphDefinitionJsonSchema(): Record<string, unknown> {
  const generated = z.toJSONSchema(graphDefinitionSchema, { target: "draft-2020-12" }) as Record<string, unknown>;
  return {
    $id: "https://agent-control-stack.local/schemas/graph-v0.1.schema.json",
    title: "ACS Graph Contract v0.1",
    ...generated
  };
}

export type GraphDefinitionInput = z.infer<typeof graphDefinitionSchema>;
export type GraphRisk = z.infer<typeof riskSchema>;
export type RequestedBy = z.infer<typeof requestedBySchema>;
export type JsonSchemaObject = z.infer<typeof jsonObjectSchema>;

export interface GraphNodeDefinition {
  id: string;
  function_id: string;
  dependencies: string[];
  input?: JsonValue | null;
  input_schema: JsonSchemaObject;
  output_schema: JsonSchemaObject;
  timeout: number;
  idempotency_key: string;
  risk: GraphRisk;
  approval_required: boolean;
  description: string;
  required: boolean;
  adapter: string;
  inputs: GraphNodeInputPort[];
  outputs: GraphNodePort[];
  parameters: Record<string, JsonValue>;
  evidenceRequirements: string[];
  resources: GraphResources;
  timeoutMs: number;
  retry: { maxAttempts: number };
  retry_policy: { max_attempts: number; backoff_ms: number };
  budget: { maxTokens: number; maxCostUsd: number; apiSlots: number };
  sideEffect: "NONE" | "READ_ONLY" | "WRITE" | "EXTERNAL";
  approval: "NONE" | "HUMAN";
}

export interface GraphNodePort {
  name: string;
  type: string;
}

export interface GraphNodeInputPort extends GraphNodePort {
  cardinality: "ONE" | "MANY";
  required: boolean;
}

export interface GraphResources {
  filesystem: Array<{ scope: string; access: "READ" | "WRITE" }>;
  gitWorktrees: string[];
  ports: number[];
  browserProfiles: string[];
  services: string[];
  externalTargets: string[];
}

export interface GraphEdgeDefinition {
  id: string;
  from: { nodeId: string; port: string };
  to: { nodeId: string; port: string };
  required: boolean;
}

export interface GraphDefinition {
  graph_id: string;
  version: "0.1";
  requested_by: RequestedBy;
  intent: string;
  risk: GraphRisk;
  idempotency_key: string;
  correlation_id: string;
  schemaVersion: "0.1";
  graphId: string;
  objective: string;
  nodes: GraphNodeDefinition[];
  edges: GraphEdgeDefinition[];
  acceptanceTests: Array<{
    id: string;
    description: string;
    required: boolean;
    nodeIds: string[];
  }>;
  limits: {
    maxWorkers: number;
    maxDepth: number;
    wallClockMs: number;
    tokenCeiling: number;
    dollarCeilingUsd: number;
    apiConcurrency: number;
  };
  verdictPolicy: {
    requiredFailure: "FAIL" | "PARTIAL";
    optionalFailure: "IGNORE" | "PARTIAL";
    requiredCoverage: number;
  };
}

/**
 * Return the durable graph projection. Schema structure and identifiers are
 * preserved, while data-bearing request fields and schema annotations that can
 * contain credentials are redacted before hashing or SQLite persistence.
 */
export function redactGraphDefinition(definition: GraphDefinition): GraphDefinition {
  return {
    ...definition,
    intent: redactText(definition.intent),
    objective: redactText(definition.objective),
    acceptanceTests: definition.acceptanceTests.map((test) => ({
      ...test,
      description: redactText(test.description)
    })),
    nodes: definition.nodes.map((node) => ({
      ...node,
      description: redactText(node.description),
      input: node.input === undefined ? undefined : redactJsonValue(node.input),
      input_schema: redactJsonSchema(node.input_schema),
      output_schema: redactJsonSchema(node.output_schema),
      parameters: redactJsonValue(node.parameters) as Record<string, JsonValue>,
      evidenceRequirements: node.evidenceRequirements.map(redactText),
      resources: structuredClone(node.resources)
    }))
  };
}

export function normalizeGraphDefinition(input: GraphDefinitionInput): GraphDefinition {
  const nodes = input.nodes.map((raw) => normalizeNode(raw));
  const edges = (input.edges?.length ?? 0) > 0 ? input.edges! : deriveEdges(nodes);
  const graphId = input.graphId ?? input.graph_id;
  const objective = input.objective ?? input.intent;
  return {
    graph_id: input.graph_id,
    version: input.version,
    requested_by: input.requested_by,
    intent: input.intent,
    risk: input.risk,
    idempotency_key: input.idempotency_key,
    correlation_id: input.correlation_id,
    schemaVersion: input.schemaVersion ?? input.version,
    graphId,
    objective,
    nodes,
    edges,
    acceptanceTests: input.acceptanceTests ?? [],
    limits: input.limits ?? defaultLimits(),
    verdictPolicy: input.verdictPolicy ?? defaultVerdictPolicy()
  };
}

function normalizeNode(raw: GraphDefinitionInput["nodes"][number]): GraphNodeDefinition {
  const inputs =
    (raw.inputs?.length ?? 0) > 0
      ? raw.inputs!
      : raw.dependencies.length > 0
        ? [{ name: "input", type: "json", cardinality: "MANY" as const, required: true }]
        : [];
  const outputs = (raw.outputs?.length ?? 0) > 0 ? raw.outputs! : [{ name: "output", type: "json" }];
  const retry = raw.retry ?? { maxAttempts: raw.retry_policy.max_attempts };
  const timeoutMs = raw.timeoutMs ?? raw.timeout;
  const adapter = raw.adapter ?? raw.function_id;
  const approval = raw.approval ?? (raw.approval_required ? "HUMAN" : "NONE");
  const parameters =
    raw.parameters && Object.keys(raw.parameters).length > 0
      ? raw.parameters
      : isJsonObject(raw.input)
        ? (raw.input as Record<string, JsonValue>)
        : {};
  return {
    id: raw.id,
    function_id: raw.function_id,
    dependencies: [...raw.dependencies],
    input: raw.input,
    input_schema: raw.input_schema,
    output_schema: raw.output_schema,
    timeout: raw.timeout,
    idempotency_key: raw.idempotency_key,
    risk: raw.risk,
    approval_required: raw.approval_required,
    description: raw.description ?? raw.id,
    required: raw.required ?? true,
    adapter,
    inputs,
    outputs,
    parameters,
    evidenceRequirements: raw.evidenceRequirements ?? [],
    resources: raw.resources ?? emptyResources,
    timeoutMs,
    retry,
    retry_policy: raw.retry_policy,
    budget: raw.budget ?? { maxTokens: 0, maxCostUsd: 0, apiSlots: 0 },
    sideEffect: raw.sideEffect ?? "NONE",
    approval
  };
}

function defaultLimits(): GraphDefinition["limits"] {
  return {
    maxWorkers: 1,
    maxDepth: 128,
    wallClockMs: 86_400_000,
    tokenCeiling: 0,
    dollarCeilingUsd: 0,
    apiConcurrency: 1
  };
}

function defaultVerdictPolicy(): GraphDefinition["verdictPolicy"] {
  return {
    requiredFailure: "FAIL",
    optionalFailure: "PARTIAL",
    requiredCoverage: 1
  };
}

function deriveEdges(nodes: readonly GraphNodeDefinition[]): GraphEdgeDefinition[] {
  return nodes.flatMap((node) =>
    node.dependencies.map((dependency) => ({
      id: `edge_${stableHash({ from: dependency, to: node.id, fromPort: "output", toPort: "input" })}`,
      from: { nodeId: dependency, port: "output" },
      to: { nodeId: node.id, port: "input" },
      required: true
    }))
  );
}

function isJsonObject(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactText(value: string): string {
  return String(redactGraphValue(value));
}

export function redactJsonValue(value: JsonValue): JsonValue {
  return redactGraphValue(value) as JsonValue;
}

export function redactGraphValue(value: unknown): unknown {
  return redactCredentialBearingUris(redactValue(value));
}

function redactCredentialBearingUris(value: unknown): unknown {
  if (typeof value === "string") {
    return containsCredentialBearingUri(value) ? "[redacted]" : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactCredentialBearingUris(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, redactCredentialBearingUris(entry)])
    );
  }
  return value;
}

function containsCredentialBearingUri(value: string): boolean {
  let candidate = value;
  for (let pass = 0; pass < 4; pass += 1) {
    if (credentialBearingUriPattern.test(candidate)) return true;
    try {
      const decoded = decodeURIComponent(candidate);
      if (decoded === candidate) return false;
      candidate = decoded;
    } catch {
      return false;
    }
  }
  return credentialBearingUriPattern.test(candidate);
}

function redactJsonSchema(schema: JsonSchemaObject): JsonSchemaObject {
  const redacted: Record<string, JsonValue> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "properties" && isJsonObject(value)) {
      redacted[key] = Object.fromEntries(
        Object.entries(value).map(([property, child]) => [
          property,
          isJsonObject(child) ? redactJsonSchema(child as JsonSchemaObject) : redactJsonValue(child)
        ])
      );
    } else if (["items", "additionalProperties", "not"].includes(key) && isJsonObject(value)) {
      redacted[key] = redactJsonSchema(value as JsonSchemaObject);
    } else if (["allOf", "anyOf", "oneOf"].includes(key) && Array.isArray(value)) {
      redacted[key] = value.map((branch) =>
        isJsonObject(branch) ? redactJsonSchema(branch as JsonSchemaObject) : redactJsonValue(branch)
      );
    } else if (["const", "default"].includes(key)) {
      redacted[key] = redactJsonValue(value);
    } else if (["enum", "examples"].includes(key) && Array.isArray(value)) {
      redacted[key] = value.map((entry) => redactJsonValue(entry));
    } else if (["$comment", "description", "title"].includes(key) && typeof value === "string") {
      redacted[key] = redactText(value);
    } else {
      redacted[key] = structuredClone(value);
    }
  }
  return redacted;
}

export const evidenceReferenceSchema = z
  .object({
    kind: identifierSchema,
    uri: z.string().min(1).max(4_096).refine(isCredentialFreeString, "must not contain URI credentials"),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u)
  })
  .strict();

export const nodeExecutionResultSchema = z
  .object({
    status: z.enum(["SUCCEEDED", "FAILED", "BLOCKED"]),
    output: z.record(z.string(), z.json()),
    evidence: z.array(evidenceReferenceSchema).max(1_000),
    assumptions: z.array(z.string().max(4_000)).max(1_000),
    confidence: z.number().min(0).max(1),
    unresolved: z.array(z.string().max(4_000)).max(1_000),
    retryable: z.boolean(),
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
        costUsd: z.number().finite().nonnegative(),
        durationMs: z.number().int().nonnegative()
      })
      .strict()
  })
  .strict();

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type EvidenceReference = z.infer<typeof evidenceReferenceSchema>;
export type NodeExecutionResult = z.infer<typeof nodeExecutionResultSchema>;
export type GraphNodeState =
  "PENDING" | "READY" | "RUNNING" | "SUCCEEDED" | "FAILED" | "BLOCKED" | "SKIPPED" | "CANCELLED";
export type GraphRunState = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "BLOCKED" | "CANCELLED";
export type GraphVerdict = "PASS" | "PARTIAL" | "BLOCK" | "FAIL";

export const GRAPH_JSON_LIMITS = {
  maxBytes: 1_048_576,
  maxDepth: 32,
  maxKeys: 10_000,
  maxStringBytes: 65_536
} as const;

export function graphJsonBoundsError(value: unknown): string | null {
  const seen = new WeakSet<object>();
  let keyCount = 0;

  const visit = (current: unknown, path: string, depth: number): string | null => {
    if (depth > GRAPH_JSON_LIMITS.maxDepth) return `${path} exceeds the maximum JSON depth`;
    if (typeof current === "string") {
      if (new TextEncoder().encode(current).byteLength > GRAPH_JSON_LIMITS.maxStringBytes) {
        return `${path} exceeds the maximum string size`;
      }
      return null;
    }
    if (!current || typeof current !== "object") return null;
    if (seen.has(current)) return `${path} contains a circular value`;
    seen.add(current);
    if (Array.isArray(current)) {
      for (const [index, entry] of current.entries()) {
        const error = visit(entry, `${path}[${index}]`, depth + 1);
        if (error) return error;
      }
    } else {
      for (const [key, entry] of Object.entries(current)) {
        keyCount += 1;
        if (keyCount > GRAPH_JSON_LIMITS.maxKeys) return `graph exceeds ${GRAPH_JSON_LIMITS.maxKeys} object keys`;
        const error = visit(entry, `${path}.${key}`, depth + 1);
        if (error) return error;
      }
    }
    return null;
  };

  const structuralError = visit(value, "$", 0);
  if (structuralError) return structuralError;
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return "graph contains a value that cannot be represented as JSON";
  }
  if (serialized !== undefined && new TextEncoder().encode(serialized).byteLength > GRAPH_JSON_LIMITS.maxBytes) {
    return `graph exceeds the maximum JSON size of ${GRAPH_JSON_LIMITS.maxBytes} bytes`;
  }
  return null;
}

/** Redact untrusted adapter evidence before it becomes durable ledger data. */
export function redactNodeExecutionResult(result: NodeExecutionResult): NodeExecutionResult {
  return redactGraphValue(result) as NodeExecutionResult;
}

/** Validate the JSON-Schema subset used by v0.1 input/output contracts. */
export function validateJsonSchema(
  schema: JsonSchemaObject,
  value: unknown,
  path = "$",
  allowRedacted = false
): string | null {
  if (allowRedacted && value === "[redacted]") {
    return null;
  }
  const containsRedacted = allowRedacted && hasRedactedMarker(value);
  const anyOf = schema.anyOf;
  if (Array.isArray(anyOf) && !containsRedacted) {
    const matches = anyOf
      .filter((candidate) => isJsonObject(candidate))
      .filter((candidate) => validateJsonSchema(candidate, value, path, allowRedacted) === null);
    if (matches.length === 0) {
      return `${path} does not match anyOf`;
    }
  }
  const allOf = schema.allOf;
  if (Array.isArray(allOf)) {
    for (const candidate of allOf) {
      if (isJsonObject(candidate)) {
        const error = validateJsonSchema(candidate, value, path, allowRedacted);
        if (error) return `${path} violates allOf: ${error}`;
      }
    }
  }
  const oneOf = schema.oneOf;
  if (Array.isArray(oneOf) && !containsRedacted) {
    const matches = oneOf
      .filter((candidate) => isJsonObject(candidate))
      .filter((candidate) => validateJsonSchema(candidate, value, path, allowRedacted) === null);
    if (matches.length !== 1) {
      return `${path} must match exactly one oneOf branch`;
    }
  }
  if (
    !containsRedacted &&
    isJsonObject(schema.not) &&
    validateJsonSchema(schema.not, value, path, allowRedacted) === null
  ) {
    return `${path} matches a prohibited not schema`;
  }
  if (
    !containsRedacted &&
    Object.prototype.hasOwnProperty.call(schema, "const") &&
    !jsonValuesEqual(schema.const, value)
  ) {
    return `${path} does not equal the declared const value`;
  }
  const enumValues = schema.enum;
  if (
    !containsRedacted &&
    Array.isArray(enumValues) &&
    !enumValues.some((candidate) => jsonValuesEqual(candidate, value))
  ) {
    return `${path} is not one of the declared enum values`;
  }
  const type = schema.type;
  if (typeof type === "string" && !matchesJsonType(type, value)) {
    return `${path} must be a ${type}`;
  }
  if (
    Array.isArray(type) &&
    !type.some((candidate) => typeof candidate === "string" && matchesJsonType(candidate, value))
  ) {
    return `${path} has an unsupported JSON type`;
  }
  const allowsObject = typeAllows(type, "object");
  const allowsArray = typeAllows(type, "array");
  if (allowsObject && isJsonObject(value)) {
    const required = Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === "string")
      : [];
    for (const key of required) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) {
        return `${path}.${key} is required`;
      }
    }
    const properties = isJsonObject(schema.properties) ? schema.properties : {};
    if (typeof schema.minProperties === "number" && Object.keys(value).length < schema.minProperties) {
      return `${path} has fewer than minProperties`;
    }
    if (typeof schema.maxProperties === "number" && Object.keys(value).length > schema.maxProperties) {
      return `${path} has more than maxProperties`;
    }
    for (const [key, child] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(value, key) && isJsonObject(child)) {
        const error = validateJsonSchema(child, value[key], `${path}.${key}`, allowRedacted);
        if (error) return error;
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) {
          return `${path}.${key} is not permitted`;
        }
      }
    } else if (isJsonObject(schema.additionalProperties)) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(properties, key)) {
          const error = validateJsonSchema(schema.additionalProperties, value[key], `${path}.${key}`, allowRedacted);
          if (error) return error;
        }
      }
    }
  }
  if (allowsArray && Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      return `${path} has fewer than minItems`;
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      return `${path} has more than maxItems`;
    }
    if (schema.uniqueItems === true && !containsRedacted) {
      const seen = new Set(value.map((item) => canonicalJson(item)));
      if (seen.size !== value.length) {
        return `${path} contains duplicate items`;
      }
    }
    if (isJsonObject(schema.items)) {
      for (const [index, item] of value.entries()) {
        const error = validateJsonSchema(schema.items, item, `${path}[${index}]`, allowRedacted);
        if (error) return error;
      }
    }
  }
  if (typeof value === "string" && typeof schema.minLength === "number" && value.length < schema.minLength) {
    return `${path} is shorter than minLength`;
  }
  if (typeof value === "string" && typeof schema.maxLength === "number" && value.length > schema.maxLength) {
    return `${path} is longer than maxLength`;
  }
  if (typeof value === "string" && typeof schema.pattern === "string") {
    let pattern: RegExp;
    try {
      pattern = new RegExp(schema.pattern, "u");
    } catch {
      return `${path} declares an invalid pattern`;
    }
    if (!pattern.test(value)) {
      return `${path} does not match pattern`;
    }
  }
  if (typeof value === "number" && typeof schema.minimum === "number" && value < schema.minimum) {
    return `${path} is below minimum`;
  }
  if (typeof value === "number" && typeof schema.maximum === "number" && value > schema.maximum) {
    return `${path} is above maximum`;
  }
  if (typeof value === "number" && typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) {
    return `${path} is not above exclusiveMinimum`;
  }
  if (typeof value === "number" && typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) {
    return `${path} is not below exclusiveMaximum`;
  }
  return null;
}

function hasRedactedMarker(value: unknown): boolean {
  if (value === "[redacted]") return true;
  if (Array.isArray(value)) return value.some(hasRedactedMarker);
  if (isJsonObject(value)) return Object.values(value).some(hasRedactedMarker);
  return false;
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function typeAllows(type: JsonSchemaObject["type"], expected: string): boolean {
  return type === undefined || type === expected || (Array.isArray(type) && type.includes(expected));
}

function matchesJsonType(type: string, value: unknown): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isJsonObject(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  if (type === "boolean") return typeof value === "boolean";
  if (type === "string") return typeof value === "string";
  return true;
}
