import { stableHash } from "@agent-control-stack/shared";
import {
  graphDefinitionSchema,
  graphJsonBoundsError,
  isCredentialFreeString,
  normalizeGraphDefinition,
  redactGraphValue,
  redactGraphDefinition,
  type GraphDefinition,
  type GraphNodeDefinition,
  type JsonValue,
  type JsonSchemaObject,
  validateJsonSchema
} from "./contract.js";

export type GraphValidationErrorCode =
  | "MALFORMED_GRAPH"
  | "UNSUPPORTED_SCHEMA_VERSION"
  | "DUPLICATE_IDENTIFIER"
  | "UNKNOWN_NODE"
  | "UNKNOWN_PORT"
  | "UNKNOWN_ACCEPTANCE_NODE"
  | "MISSING_REQUIRED_INPUT"
  | "PORT_TYPE_MISMATCH"
  | "CARDINALITY_VIOLATION"
  | "UNSUPPORTED_ADAPTER"
  | "FUNCTION_ADAPTER_MISMATCH"
  | "SIDE_EFFECT_CLASS_DISABLED"
  | "READ_ONLY_POLICY_VIOLATION"
  | "NODE_BUDGET_EXCEEDS_GRAPH"
  | "DEPENDENCY_MISMATCH"
  | "SELF_DEPENDENCY"
  | "INPUT_SCHEMA_MISMATCH"
  | "INVALID_SCHEMA"
  | "CYCLIC_GRAPH"
  | "DEPTH_LIMIT_EXCEEDED";

export class GraphValidationError extends Error {
  constructor(
    public readonly code: GraphValidationErrorCode,
    message: string,
    public readonly details: readonly string[] = []
  ) {
    super(message);
    this.name = "GraphValidationError";
  }
}

export interface GraphValidationOptions {
  allowedAdapters: ReadonlySet<string>;
  /** Only resume paths may validate the ledger's redacted durable projection. */
  allowRedacted?: boolean;
}

export interface ValidatedGraph {
  definition: GraphDefinition;
  graphHash: string;
  topologicalOrder: string[];
  depth: number;
  allowRedacted: boolean;
}

export function validateGraph(input: unknown, options: GraphValidationOptions): ValidatedGraph {
  const inputBoundsError = graphJsonBoundsError(input);
  if (inputBoundsError) {
    throw new GraphValidationError("MALFORMED_GRAPH", inputBoundsError);
  }
  assertSupportedVersion(input);
  const parsed = graphDefinitionSchema.safeParse(input);
  if (!parsed.success) {
    throw new GraphValidationError(
      "MALFORMED_GRAPH",
      "graph does not match schema v0.1",
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "graph"}: ${issue.message}`)
    );
  }

  const raw = parsed.data;
  const boundsError = graphJsonBoundsError(raw);
  if (boundsError) {
    throw new GraphValidationError("MALFORMED_GRAPH", boundsError);
  }
  const definition = normalizeGraphDefinition(raw);
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== raw.version) {
    throw new GraphValidationError("UNSUPPORTED_SCHEMA_VERSION", "schemaVersion and version must both be 0.1");
  }
  if (raw.graphId !== undefined && raw.graphId !== raw.graph_id) {
    throw new GraphValidationError("MALFORMED_GRAPH", "graphId and graph_id must identify the same graph");
  }
  if (raw.objective !== undefined && raw.objective !== raw.intent) {
    throw new GraphValidationError("MALFORMED_GRAPH", "objective and intent must describe the same request");
  }
  const nodeIds = uniqueIds(
    definition.nodes.map((node) => node.id),
    "node"
  );
  uniqueIds(
    definition.edges.map((edge) => edge.id),
    "edge"
  );
  uniqueIds(
    definition.acceptanceTests.map((test) => test.id),
    "acceptance test"
  );

  const nodeById = new Map(definition.nodes.map((node) => [node.id, node]));
  const rawById = new Map(raw.nodes.map((node) => [node.id, node]));
  for (const node of definition.nodes) {
    const rawNode = rawById.get(node.id)!;
    if (rawNode.adapter !== undefined && rawNode.adapter !== rawNode.function_id) {
      throw new GraphValidationError(
        "FUNCTION_ADAPTER_MISMATCH",
        `node ${node.id} declares function ${node.function_id} but adapter ${rawNode.adapter}`
      );
    }
    if (rawNode.timeoutMs !== undefined && rawNode.timeoutMs !== rawNode.timeout) {
      throw new GraphValidationError(
        "MALFORMED_GRAPH",
        `node ${node.id} declares conflicting timeout and timeoutMs values`
      );
    }
    if (rawNode.retry !== undefined && rawNode.retry.maxAttempts !== rawNode.retry_policy.max_attempts) {
      throw new GraphValidationError(
        "MALFORMED_GRAPH",
        `node ${node.id} declares conflicting retry and retry_policy values`
      );
    }
    if (!options.allowedAdapters.has(node.adapter)) {
      throw new GraphValidationError(
        "UNSUPPORTED_ADAPTER",
        `node ${node.id} requests unsupported adapter ${node.adapter}`
      );
    }
    validateUniquePorts(node);
    validateDependencies(node, nodeById);
    validateSchemaShape(node.input_schema, `${node.id}.input_schema`);
    validateSchemaShape(node.output_schema, `${node.id}.output_schema`);
    const schemaInput =
      node.dependencies.length === 0
        ? rawNode.input === undefined
          ? assembledInputShape(node)
          : rawNode.input
        : assembledInputShape(node);
    const inputError = validateJsonSchema(node.input_schema, schemaInput, "$", options.allowRedacted ?? false);
    if (inputError) {
      throw new GraphValidationError("INPUT_SCHEMA_MISMATCH", `node ${node.id} input ${inputError}`);
    }
    validateSideEffectPolicy(node);
    validateResourceStrings(node);
    if (
      node.budget.maxTokens > definition.limits.tokenCeiling ||
      node.budget.maxCostUsd > definition.limits.dollarCeilingUsd ||
      node.budget.apiSlots > definition.limits.apiConcurrency
    ) {
      throw new GraphValidationError(
        "NODE_BUDGET_EXCEEDS_GRAPH",
        `node ${node.id} requests a budget larger than the graph ceiling`
      );
    }
  }

  const adjacency = new Map<string, string[]>(definition.nodes.map((node) => [node.id, []]));
  const indegree = new Map<string, number>(definition.nodes.map((node) => [node.id, 0]));
  const incomingByPort = new Map<string, number>();
  const incomingSources = new Map<string, Set<string>>();

  for (const edge of definition.edges) {
    if (edge.from.nodeId === edge.to.nodeId) {
      throw new GraphValidationError("SELF_DEPENDENCY", `edge ${edge.id} self-depends on ${edge.from.nodeId}`);
    }
    const source = nodeById.get(edge.from.nodeId);
    const target = nodeById.get(edge.to.nodeId);
    if (!source) {
      throw new GraphValidationError(
        "UNKNOWN_NODE",
        `edge ${edge.id} references unknown source node ${edge.from.nodeId}`
      );
    }
    if (!target) {
      throw new GraphValidationError(
        "UNKNOWN_NODE",
        `edge ${edge.id} references unknown target node ${edge.to.nodeId}`
      );
    }

    const output = source.outputs.find((port) => port.name === edge.from.port);
    const inputPort = target.inputs.find((port) => port.name === edge.to.port);
    if (!output) {
      throw new GraphValidationError(
        "UNKNOWN_PORT",
        `edge ${edge.id} references unknown output ${source.id}.${edge.from.port}`
      );
    }
    if (!inputPort) {
      throw new GraphValidationError(
        "UNKNOWN_PORT",
        `edge ${edge.id} references unknown input ${target.id}.${edge.to.port}`
      );
    }
    if (output.type !== inputPort.type) {
      throw new GraphValidationError(
        "PORT_TYPE_MISMATCH",
        `edge ${edge.id} connects ${output.type} to ${inputPort.type}`
      );
    }

    const portKey = `${target.id}:${inputPort.name}`;
    const incomingCount = (incomingByPort.get(portKey) ?? 0) + 1;
    incomingByPort.set(portKey, incomingCount);
    if (inputPort.cardinality === "ONE" && incomingCount > 1) {
      throw new GraphValidationError(
        "CARDINALITY_VIOLATION",
        `input ${target.id}.${inputPort.name} accepts one edge but received ${incomingCount}`
      );
    }

    const sources = incomingSources.get(target.id) ?? new Set<string>();
    sources.add(source.id);
    incomingSources.set(target.id, sources);
    adjacency.get(source.id)!.push(target.id);
    indegree.set(target.id, indegree.get(target.id)! + 1);
  }

  for (const node of definition.nodes) {
    for (const inputPort of node.inputs) {
      if (inputPort.required && (incomingByPort.get(`${node.id}:${inputPort.name}`) ?? 0) === 0) {
        throw new GraphValidationError(
          "MISSING_REQUIRED_INPUT",
          `required input ${node.id}.${inputPort.name} has no dependency edge`
        );
      }
    }
  }

  for (const acceptanceTest of definition.acceptanceTests) {
    for (const nodeId of acceptanceTest.nodeIds) {
      if (!nodeIds.has(nodeId)) {
        throw new GraphValidationError(
          "UNKNOWN_ACCEPTANCE_NODE",
          `acceptance test ${acceptanceTest.id} references unknown node ${nodeId}`
        );
      }
    }
  }

  const ready = [...indegree.entries()]
    .filter(([, count]) => count === 0)
    .map(([id]) => id)
    .sort();
  const topologicalOrder: string[] = [];
  const depthByNode = new Map<string, number>(definition.nodes.map((node) => [node.id, 1]));

  while (ready.length > 0) {
    const current = ready.shift()!;
    topologicalOrder.push(current);
    for (const target of adjacency.get(current)!.sort()) {
      depthByNode.set(target, Math.max(depthByNode.get(target)!, depthByNode.get(current)! + 1));
      const remaining = indegree.get(target)! - 1;
      indegree.set(target, remaining);
      if (remaining === 0) {
        ready.push(target);
        ready.sort();
      }
    }
  }

  if (topologicalOrder.length !== definition.nodes.length) {
    throw new GraphValidationError("CYCLIC_GRAPH", "graph v0.1 must be acyclic");
  }

  for (const node of definition.nodes) {
    const sources = incomingSources.get(node.id) ?? new Set<string>();
    for (const dependency of node.dependencies) {
      if (!sources.has(dependency)) {
        throw new GraphValidationError(
          "DEPENDENCY_MISMATCH",
          `node ${node.id} declares dependency ${dependency} without a matching edge`
        );
      }
    }
    for (const source of sources) {
      if (!node.dependencies.includes(source)) {
        throw new GraphValidationError(
          "DEPENDENCY_MISMATCH",
          `node ${node.id} has edge dependency ${source} missing from dependencies`
        );
      }
    }
  }

  const depth = definition.nodes.length === 0 ? 0 : Math.max(...depthByNode.values());
  if (depth > definition.limits.maxDepth) {
    throw new GraphValidationError(
      "DEPTH_LIMIT_EXCEEDED",
      `graph depth ${depth} exceeds declared maximum ${definition.limits.maxDepth}`
    );
  }

  return {
    definition,
    graphHash: stableHash(redactGraphDefinition(definition)),
    topologicalOrder,
    depth,
    allowRedacted: options.allowRedacted ?? false
  };
}

function assertSupportedVersion(input: unknown): void {
  if (!isRecord(input)) return;
  if (Object.hasOwn(input, "version") && input.version !== "0.1") {
    throw new GraphValidationError("UNSUPPORTED_SCHEMA_VERSION", `unsupported graph version ${String(input.version)}`);
  }
  if (Object.hasOwn(input, "schemaVersion") && input.schemaVersion !== "0.1") {
    throw new GraphValidationError(
      "UNSUPPORTED_SCHEMA_VERSION",
      `unsupported legacy schema version ${String(input.schemaVersion)}`
    );
  }
}

function validateDependencies(node: GraphNodeDefinition, nodeById: ReadonlyMap<string, GraphNodeDefinition>): void {
  const seen = new Set<string>();
  for (const dependency of node.dependencies) {
    if (seen.has(dependency)) {
      throw new GraphValidationError("DUPLICATE_IDENTIFIER", `duplicate dependency ${dependency} on node ${node.id}`);
    }
    seen.add(dependency);
    if (dependency === node.id) {
      throw new GraphValidationError("SELF_DEPENDENCY", `node ${node.id} cannot depend on itself`);
    }
    if (!nodeById.has(dependency)) {
      throw new GraphValidationError("UNKNOWN_NODE", `node ${node.id} references unknown dependency ${dependency}`);
    }
  }
}

function validateUniquePorts(node: GraphNodeDefinition): void {
  uniqueIds(
    node.inputs.map((port) => port.name),
    `input port on node ${node.id}`
  );
  uniqueIds(
    node.outputs.map((port) => port.name),
    `output port on node ${node.id}`
  );
}

function validateSideEffectPolicy(node: GraphNodeDefinition): void {
  if (node.sideEffect === "WRITE" || node.sideEffect === "EXTERNAL") {
    throw new GraphValidationError(
      "SIDE_EFFECT_CLASS_DISABLED",
      `node ${node.id} requests ${node.sideEffect}; graph v0.1 admits only NONE and READ_ONLY nodes`
    );
  }
  if (node.resources.filesystem.some((resource) => resource.access === "WRITE")) {
    throw new GraphValidationError(
      "READ_ONLY_POLICY_VIOLATION",
      `node ${node.id} requests a writable filesystem resource in graph v0.1`
    );
  }
}

function validateResourceStrings(node: GraphNodeDefinition): void {
  const values: Array<readonly [string, string]> = [
    ...node.resources.filesystem.map((resource) => [`${node.id}.resources.filesystem.scope`, resource.scope] as const),
    ...node.resources.gitWorktrees.map((value) => [`${node.id}.resources.gitWorktrees`, value] as const),
    ...node.resources.browserProfiles.map((value) => [`${node.id}.resources.browserProfiles`, value] as const),
    ...node.resources.services.map((value) => [`${node.id}.resources.services`, value] as const),
    ...node.resources.externalTargets.map((value) => [`${node.id}.resources.externalTargets`, value] as const)
  ];
  for (const [label, value] of values) {
    if (!isCredentialFreeString(value)) {
      throw new GraphValidationError(
        "MALFORMED_GRAPH",
        `${label} contains credential-like material and cannot be admitted`
      );
    }
  }
}

function assembledInputShape(node: GraphNodeDefinition): Record<string, JsonValue> {
  return Object.fromEntries(node.inputs.map((port) => [port.name, []])) as Record<string, JsonValue>;
}

function validateSchemaShape(schema: JsonSchemaObject, label: string, depth = 0): void {
  if (depth > 32) {
    throw new GraphValidationError("INVALID_SCHEMA", `${label} is nested too deeply`);
  }
  const supportedKeywords = new Set([
    "$comment",
    "$id",
    "$schema",
    "additionalProperties",
    "allOf",
    "anyOf",
    "const",
    "default",
    "description",
    "enum",
    "examples",
    "exclusiveMaximum",
    "exclusiveMinimum",
    "items",
    "maxItems",
    "maxLength",
    "maxProperties",
    "maximum",
    "minItems",
    "minLength",
    "minProperties",
    "minimum",
    "not",
    "oneOf",
    "pattern",
    "properties",
    "required",
    "title",
    "type",
    "uniqueItems"
  ]);
  const unsupported = Object.keys(schema).find((keyword) => !supportedKeywords.has(keyword));
  if (unsupported) {
    throw new GraphValidationError("INVALID_SCHEMA", `${label}.${unsupported} is not supported by graph v0.1`);
  }

  const supportedTypes = new Set(["null", "boolean", "object", "array", "number", "integer", "string"]);
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (
      types.length === 0 ||
      new Set(types).size !== types.length ||
      types.some((type) => typeof type !== "string" || !supportedTypes.has(type))
    ) {
      throw new GraphValidationError("INVALID_SCHEMA", `${label} declares an unsupported JSON-Schema type`);
    }
  }
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
    throw new GraphValidationError("INVALID_SCHEMA", `${label}.enum must be a non-empty array`);
  }
  if (schema.properties !== undefined && !isRecord(schema.properties)) {
    throw new GraphValidationError("INVALID_SCHEMA", `${label}.properties must be an object`);
  }
  for (const keyword of ["$id", "$schema", "pattern"] as const) {
    const value = schema[keyword];
    if (
      value !== undefined &&
      (typeof value !== "string" ||
        (keyword === "$id" || keyword === "$schema"
          ? !isCredentialFreeString(value)
          : redactGraphValue(value) !== value))
    ) {
      throw new GraphValidationError(
        "INVALID_SCHEMA",
        `${label}.${keyword} must be a credential-free structural string`
      );
    }
  }
  if (
    schema.required !== undefined &&
    (!Array.isArray(schema.required) || schema.required.some((item) => typeof item !== "string"))
  ) {
    throw new GraphValidationError("INVALID_SCHEMA", `${label}.required must be an array of property names`);
  }
  if (schema.items !== undefined && !isRecord(schema.items)) {
    throw new GraphValidationError("INVALID_SCHEMA", `${label}.items must be a schema object`);
  }
  if (
    schema.additionalProperties !== undefined &&
    typeof schema.additionalProperties !== "boolean" &&
    !isRecord(schema.additionalProperties)
  ) {
    throw new GraphValidationError("INVALID_SCHEMA", `${label}.additionalProperties must be boolean or schema`);
  }
  for (const keyword of ["exclusiveMaximum", "exclusiveMinimum", "maximum", "minimum"]) {
    const value = schema[keyword];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
      throw new GraphValidationError("INVALID_SCHEMA", `${label}.${keyword} must be a finite number`);
    }
  }
  for (const keyword of ["maxItems", "maxLength", "maxProperties", "minItems", "minLength", "minProperties"]) {
    const value = schema[keyword];
    if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value < 0)) {
      throw new GraphValidationError("INVALID_SCHEMA", `${label}.${keyword} must be a non-negative integer`);
    }
  }
  if (schema.pattern !== undefined) {
    if (typeof schema.pattern !== "string") {
      throw new GraphValidationError("INVALID_SCHEMA", `${label}.pattern must be a string`);
    }
    try {
      new RegExp(schema.pattern, "u");
    } catch {
      throw new GraphValidationError("INVALID_SCHEMA", `${label}.pattern must be a valid regular expression`);
    }
  }
  if (schema.uniqueItems !== undefined && typeof schema.uniqueItems !== "boolean") {
    throw new GraphValidationError("INVALID_SCHEMA", `${label}.uniqueItems must be boolean`);
  }
  for (const keyword of ["allOf", "anyOf", "oneOf"]) {
    const branches = schema[keyword];
    if (
      branches !== undefined &&
      (!Array.isArray(branches) || branches.length === 0 || branches.some((branch) => !isRecord(branch)))
    ) {
      throw new GraphValidationError("INVALID_SCHEMA", `${label}.${keyword} must contain schema objects`);
    }
  }
  if (schema.not !== undefined && !isRecord(schema.not)) {
    throw new GraphValidationError("INVALID_SCHEMA", `${label}.not must be a schema object`);
  }

  for (const [property, child] of Object.entries(isRecord(schema.properties) ? schema.properties : {})) {
    if (redactGraphValue(property) !== property) {
      throw new GraphValidationError("INVALID_SCHEMA", `${label}.properties contains a credential-like property name`);
    }
    if (!isRecord(child)) {
      throw new GraphValidationError("INVALID_SCHEMA", `${label}.properties.${property} must be a schema object`);
    }
    validateSchemaShape(child as JsonSchemaObject, `${label}.properties.${property}`, depth + 1);
  }
  if (Array.isArray(schema.required)) {
    for (const property of schema.required) {
      if (typeof property === "string" && redactGraphValue(property) !== property) {
        throw new GraphValidationError("INVALID_SCHEMA", `${label}.required contains a credential-like property name`);
      }
    }
  }
  if (isRecord(schema.items)) {
    validateSchemaShape(schema.items, `${label}.items`, depth + 1);
  }
  if (isRecord(schema.additionalProperties)) {
    validateSchemaShape(schema.additionalProperties, `${label}.additionalProperties`, depth + 1);
  }
  for (const keyword of ["allOf", "anyOf", "oneOf"]) {
    const branches = schema[keyword];
    if (Array.isArray(branches)) {
      branches.forEach((branch, index) => {
        validateSchemaShape(branch as JsonSchemaObject, `${label}.${keyword}[${index}]`, depth + 1);
      });
    }
  }
  if (isRecord(schema.not)) {
    validateSchemaShape(schema.not, `${label}.not`, depth + 1);
  }
}

function uniqueIds(ids: readonly string[], label: string): Set<string> {
  const unique = new Set<string>();
  for (const id of ids) {
    if (unique.has(id)) {
      throw new GraphValidationError("DUPLICATE_IDENTIFIER", `duplicate ${label} id ${id}`);
    }
    unique.add(id);
  }
  return unique;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
