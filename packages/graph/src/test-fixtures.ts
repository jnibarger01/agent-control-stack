import type { GraphDefinition, GraphNodeDefinition } from "./contract.js";

export function validDiamondGraph(): GraphDefinition {
  const emptyResources: GraphNodeDefinition["resources"] = {
    filesystem: [],
    gitWorktrees: [],
    ports: [],
    browserProfiles: [],
    services: [],
    externalTargets: []
  };
  const node = (
    id: string,
    inputs: GraphNodeDefinition["inputs"],
    outputs: GraphNodeDefinition["outputs"],
    dependencies: string[]
  ): GraphNodeDefinition => ({
    id,
    function_id: "fake",
    dependencies,
    input_schema: schemaForPorts(inputs),
    output_schema: schemaForPorts(outputs),
    timeout: 1_000,
    idempotency_key: `graph-diamond-${id}`,
    risk: "low",
    approval_required: false,
    description: `${id} node`,
    required: true,
    adapter: "fake",
    inputs,
    outputs,
    parameters: {},
    evidenceRequirements: [],
    resources: structuredClone(emptyResources),
    timeoutMs: 1_000,
    retry: { maxAttempts: 1 },
    retry_policy: { max_attempts: 1, backoff_ms: 0 },
    budget: { maxTokens: 0, maxCostUsd: 0, apiSlots: 0 },
    sideEffect: "NONE",
    approval: "NONE"
  });

  return {
    graph_id: "graph_diamond",
    version: "0.1",
    requested_by: { actor_id: "hermes-main", actor_type: "agent" },
    intent: "Run deterministic graph tests",
    risk: "low",
    idempotency_key: "graph-diamond-submission",
    correlation_id: "corr-graph-diamond",
    schemaVersion: "0.1",
    graphId: "graph_diamond",
    objective: "Run deterministic graph tests",
    nodes: [
      node("seed", [], [{ name: "items", type: "acs/items" }], []),
      node(
        "left",
        [{ name: "items", type: "acs/items", cardinality: "ONE", required: true }],
        [{ name: "findings", type: "acs/findings" }],
        ["seed"]
      ),
      node(
        "right",
        [{ name: "items", type: "acs/items", cardinality: "ONE", required: true }],
        [{ name: "findings", type: "acs/findings" }],
        ["seed"]
      ),
      node(
        "merge",
        [{ name: "findings", type: "acs/findings", cardinality: "MANY", required: true }],
        [{ name: "report", type: "acs/report" }],
        ["left", "right"]
      )
    ],
    edges: [
      {
        id: "seed-left",
        from: { nodeId: "seed", port: "items" },
        to: { nodeId: "left", port: "items" },
        required: true
      },
      {
        id: "seed-right",
        from: { nodeId: "seed", port: "items" },
        to: { nodeId: "right", port: "items" },
        required: true
      },
      {
        id: "left-merge",
        from: { nodeId: "left", port: "findings" },
        to: { nodeId: "merge", port: "findings" },
        required: true
      },
      {
        id: "right-merge",
        from: { nodeId: "right", port: "findings" },
        to: { nodeId: "merge", port: "findings" },
        required: true
      }
    ],
    acceptanceTests: [
      {
        id: "report-produced",
        description: "The merge node produces the final report",
        required: true,
        nodeIds: ["merge"]
      }
    ],
    limits: {
      maxWorkers: 2,
      maxDepth: 4,
      wallClockMs: 10_000,
      tokenCeiling: 0,
      dollarCeilingUsd: 0,
      apiConcurrency: 1
    },
    verdictPolicy: {
      requiredFailure: "FAIL",
      optionalFailure: "PARTIAL",
      requiredCoverage: 1
    }
  };
}

function schemaForPorts(ports: readonly GraphNodeDefinition["inputs"][number][]): GraphNodeDefinition["input_schema"];
function schemaForPorts(ports: readonly GraphNodeDefinition["outputs"][number][]): GraphNodeDefinition["output_schema"];
function schemaForPorts(ports: readonly { name: string; type: string }[]): GraphNodeDefinition["input_schema"] {
  const properties: GraphNodeDefinition["input_schema"] = {};
  for (const port of ports) {
    properties[port.name] = {
      type: ["items", "findings"].includes(port.name) ? "array" : "string"
    };
  }
  return {
    type: "object",
    properties,
    required: ports.filter((port) => !("required" in port) || port.required).map((port) => port.name),
    additionalProperties: false
  };
}
