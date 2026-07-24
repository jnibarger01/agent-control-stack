import { describe, expect, it } from "vitest";
import { GRAPH_JSON_LIMITS, GraphValidationError, validateGraph } from "./index.js";
import { validDiamondGraph } from "./test-fixtures.js";

describe("graph v0.1 validator", () => {
  it("accepts a valid static diamond with a deterministic hash and order", () => {
    const validated = validateGraph(validDiamondGraph(), { allowedAdapters: new Set(["fake"]) });

    expect(validated.definition.graphId).toBe("graph_diamond");
    expect(validated.graphHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(validated.topologicalOrder[0]).toBe("seed");
    expect(validated.topologicalOrder.at(-1)).toBe("merge");
    expect(new Set(validated.topologicalOrder)).toEqual(new Set(["seed", "left", "right", "merge"]));
  });

  it("validates dependency schemas against assembled ports, not local node parameters", () => {
    const graph = validDiamondGraph();
    graph.nodes.find((node) => node.id === "left")!.input = { localParameter: "fixture" };

    expect(() => validateGraph(graph, { allowedAdapters: new Set(["fake"]) })).not.toThrow();
  });

  it("uses the assembled input shape for optional root ports when root input is omitted", () => {
    const graph = validDiamondGraph();
    const seed = graph.nodes.find((node) => node.id === "seed")!;
    seed.inputs = [{ name: "optional", type: "acs/items", cardinality: "ONE", required: false }];
    seed.input_schema = {
      type: "object",
      properties: { optional: { type: "array" } },
      additionalProperties: false
    };

    expect(() => validateGraph(graph, { allowedAdapters: new Set(["fake"]) })).not.toThrow();
  });

  it("rejects a missing required dependency before execution", () => {
    const graph = validDiamondGraph();
    graph.edges = graph.edges.filter((edge) => edge.id !== "seed-left");

    expect(() => validateGraph(graph, { allowedAdapters: new Set(["fake"]) })).toThrowError(
      expect.objectContaining<Partial<GraphValidationError>>({ code: "MISSING_REQUIRED_INPUT" })
    );
  });

  it("rejects an edge whose port contracts disagree", () => {
    const graph = validDiamondGraph();
    graph.nodes[1]!.inputs[0] = {
      name: "items",
      type: "acs/not-items",
      cardinality: "ONE",
      required: true
    };

    expect(() => validateGraph(graph, { allowedAdapters: new Set(["fake"]) })).toThrowError(
      expect.objectContaining<Partial<GraphValidationError>>({ code: "PORT_TYPE_MISMATCH" })
    );
  });

  it("rejects a graph deeper than its declared bound", () => {
    const graph = validDiamondGraph();
    graph.limits.maxDepth = 2;

    expect(() => validateGraph(graph, { allowedAdapters: new Set(["fake"]) })).toThrowError(
      expect.objectContaining<Partial<GraphValidationError>>({ code: "DEPTH_LIMIT_EXCEEDED" })
    );
  });

  it.each(["WRITE", "EXTERNAL"] as const)(
    "rejects %s nodes because graph v0.1 is structurally read-only",
    (sideEffect) => {
      const graph = validDiamondGraph();
      const seed = graph.nodes[0]!;
      seed.sideEffect = sideEffect;
      seed.retry.maxAttempts = 1;
      seed.approval = "HUMAN";
      if (sideEffect === "WRITE") {
        seed.resources.filesystem = [{ scope: "repo://acs/generated/**", access: "WRITE" }];
      } else {
        seed.resources.externalTargets = ["fixture-target"];
      }

      expect(() => validateGraph(graph, { allowedAdapters: new Set(["fake"]) })).toThrowError(
        expect.objectContaining<Partial<GraphValidationError>>({ code: "SIDE_EFFECT_CLASS_DISABLED" })
      );
    }
  );

  it("rejects path traversal and unsupported wildcards in filesystem resource scopes", () => {
    const graph = validDiamondGraph();
    const seed = graph.nodes.find((node) => node.id === "seed")!;
    seed.sideEffect = "WRITE";
    seed.approval = "HUMAN";
    seed.resources.filesystem = [{ scope: "repo://acs/../secrets/**", access: "WRITE" }];

    expect(() => validateGraph(graph, { allowedAdapters: new Set(["fake"]) })).toThrowError(
      expect.objectContaining<Partial<GraphValidationError>>({ code: "MALFORMED_GRAPH" })
    );
  });

  it("rejects cycles and unknown acceptance nodes", () => {
    const cyclic = validDiamondGraph();
    cyclic.nodes
      .find((node) => node.id === "seed")!
      .inputs.push({
        name: "prior-report",
        type: "acs/report",
        cardinality: "ONE",
        required: true
      });
    cyclic.nodes.find((node) => node.id === "seed")!.input_schema = {
      type: "object",
      properties: { "prior-report": { type: "array" } },
      required: ["prior-report"],
      additionalProperties: false
    };
    cyclic.edges.push({
      id: "merge-seed",
      from: { nodeId: "merge", port: "report" },
      to: { nodeId: "seed", port: "prior-report" },
      required: true
    });
    expect(() => validateGraph(cyclic, { allowedAdapters: new Set(["fake"]) })).toThrowError(
      expect.objectContaining<Partial<GraphValidationError>>({ code: "CYCLIC_GRAPH" })
    );

    const unknownAcceptance = validDiamondGraph();
    unknownAcceptance.acceptanceTests[0]!.nodeIds = ["missing"];
    expect(() => validateGraph(unknownAcceptance, { allowedAdapters: new Set(["fake"]) })).toThrowError(
      expect.objectContaining<Partial<GraphValidationError>>({ code: "UNKNOWN_ACCEPTANCE_NODE" })
    );
  });

  it.each([
    [
      "duplicate node IDs",
      (graph: ReturnType<typeof validDiamondGraph>) => {
        graph.nodes[1]!.id = graph.nodes[0]!.id;
      },
      "DUPLICATE_IDENTIFIER"
    ],
    [
      "missing dependencies",
      (graph: ReturnType<typeof validDiamondGraph>) => {
        graph.nodes[1]!.dependencies = ["missing"];
      },
      "UNKNOWN_NODE"
    ],
    [
      "self-dependencies",
      (graph: ReturnType<typeof validDiamondGraph>) => {
        graph.nodes[0]!.dependencies = ["seed"];
      },
      "SELF_DEPENDENCY"
    ],
    [
      "malformed function identifiers",
      (graph: ReturnType<typeof validDiamondGraph>) => {
        graph.nodes[0]!.function_id = "bad function";
      },
      "MALFORMED_GRAPH"
    ],
    [
      "invalid retry values",
      (graph: ReturnType<typeof validDiamondGraph>) => {
        graph.nodes[0]!.retry_policy.max_attempts = 0;
      },
      "MALFORMED_GRAPH"
    ],
    [
      "invalid timeout values",
      (graph: ReturnType<typeof validDiamondGraph>) => {
        graph.nodes[0]!.timeout = 0;
      },
      "MALFORMED_GRAPH"
    ],
    [
      "invalid risk values",
      (graph: ReturnType<typeof validDiamondGraph>) => {
        Object.assign(graph, { risk: "urgent" });
      },
      "MALFORMED_GRAPH"
    ],
    [
      "invalid approval values",
      (graph: ReturnType<typeof validDiamondGraph>) => {
        Object.assign(graph.nodes[0]!, { approval: "AUTO" });
      },
      "MALFORMED_GRAPH"
    ],
    [
      "malformed requester identity",
      (graph: ReturnType<typeof validDiamondGraph>) => {
        Object.assign(graph, { requested_by: { actor_id: "", actor_type: "agent" } });
      },
      "MALFORMED_GRAPH"
    ]
  ] as const)("rejects %s", (_label, mutate, code) => {
    const graph = validDiamondGraph();
    mutate(graph);

    expect(() => validateGraph(graph, { allowedAdapters: new Set(["fake"]) })).toThrowError(
      expect.objectContaining<Partial<GraphValidationError>>({ code })
    );
  });

  it("rejects missing idempotency keys and unsupported versions", () => {
    const missingKey = validDiamondGraph();
    delete (missingKey.nodes[0] as unknown as Record<string, unknown>).idempotency_key;
    expect(() => validateGraph(missingKey, { allowedAdapters: new Set(["fake"]) })).toThrowError(
      expect.objectContaining<Partial<GraphValidationError>>({ code: "MALFORMED_GRAPH" })
    );

    const unsupported = validDiamondGraph();
    Object.assign(unsupported, { version: "0.2" });
    expect(() => validateGraph(unsupported, { allowedAdapters: new Set(["fake"]) })).toThrowError(
      expect.objectContaining<Partial<GraphValidationError>>({ code: "UNSUPPORTED_SCHEMA_VERSION" })
    );
  });

  it("rejects a conflicting objective alias", () => {
    const graph = validDiamondGraph();
    graph.objective = "a different request";

    expect(() => validateGraph(graph, { allowedAdapters: new Set(["fake"]) })).toThrowError(
      expect.objectContaining<Partial<GraphValidationError>>({ code: "MALFORMED_GRAPH" })
    );
  });

  it("rejects conflicting timeout and retry aliases", () => {
    const timeoutConflict = validDiamondGraph();
    timeoutConflict.nodes[0]!.timeoutMs = 5;
    expect(() => validateGraph(timeoutConflict, { allowedAdapters: new Set(["fake"]) })).toThrowError(
      expect.objectContaining<Partial<GraphValidationError>>({ code: "MALFORMED_GRAPH" })
    );

    const retryConflict = validDiamondGraph();
    retryConflict.nodes[0]!.retry.maxAttempts = 2;
    expect(() => validateGraph(retryConflict, { allowedAdapters: new Set(["fake"]) })).toThrowError(
      expect.objectContaining<Partial<GraphValidationError>>({ code: "MALFORMED_GRAPH" })
    );
  });

  it("rejects unsupported JSON-Schema validation keywords instead of ignoring them", () => {
    const graph = validDiamondGraph();
    graph.nodes[0]!.output_schema = { type: "object", unevaluatedProperties: false };

    expect(() => validateGraph(graph, { allowedAdapters: new Set(["fake"]) })).toThrowError(
      expect.objectContaining<Partial<GraphValidationError>>({ code: "INVALID_SCHEMA" })
    );
  });

  it("rejects credential-bearing resource identifiers before durable admission", () => {
    const graph = validDiamondGraph();
    graph.nodes[0]!.resources.filesystem = [{ scope: "repo://user:secret@example", access: "READ" }];

    expect(() => validateGraph(graph, { allowedAdapters: new Set(["fake"]) })).toThrowError(
      expect.objectContaining<Partial<GraphValidationError>>({ code: "MALFORMED_GRAPH" })
    );
  });

  it("rejects credential-like authority keys and schema patterns", () => {
    const credential = `sk-${"x".repeat(24)}`;
    const keyGraph = validDiamondGraph();
    keyGraph.idempotency_key = credential;
    expect(() => validateGraph(keyGraph, { allowedAdapters: new Set(["fake"]) })).toThrowError(
      expect.objectContaining<Partial<GraphValidationError>>({ code: "MALFORMED_GRAPH" })
    );

    const patternGraph = validDiamondGraph();
    patternGraph.nodes[0]!.output_schema = { type: "string", pattern: credential };
    expect(() => validateGraph(patternGraph, { allowedAdapters: new Set(["fake"]) })).toThrowError(
      expect.objectContaining<Partial<GraphValidationError>>({ code: "INVALID_SCHEMA" })
    );
  });

  it("rejects admission payloads beyond the bounded JSON contract", () => {
    const graph = validDiamondGraph();
    graph.nodes[0]!.input = "x".repeat(GRAPH_JSON_LIMITS.maxStringBytes + 1);
    graph.nodes[0]!.input_schema = { type: "string" };

    expect(() => validateGraph(graph, { allowedAdapters: new Set(["fake"]) })).toThrowError(
      expect.objectContaining<Partial<GraphValidationError>>({ code: "MALFORMED_GRAPH" })
    );
  });

  it("uses collision-free IDs when deriving edges from dependencies", () => {
    const graph = validDiamondGraph();
    graph.nodes = graph.nodes.map((node) => ({
      ...node,
      inputs: [],
      outputs: [],
      input_schema: { type: "object" }
    }));
    graph.nodes[0]!.id = "a-b";
    graph.nodes[0]!.dependencies = [];
    graph.nodes[1]!.id = "c";
    graph.nodes[1]!.dependencies = ["a-b"];
    graph.nodes[2]!.id = "a";
    graph.nodes[2]!.dependencies = [];
    graph.nodes[3]!.id = "b-c";
    graph.nodes[3]!.dependencies = ["a"];
    graph.edges = [];
    graph.acceptanceTests = [];

    const validated = validateGraph(graph, { allowedAdapters: new Set(["fake"]) });

    expect(validated.definition.edges).toHaveLength(2);
    expect(new Set(validated.definition.edges.map((edge) => edge.id))).toHaveLength(2);
  });
});
