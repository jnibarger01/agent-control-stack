import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { redactValue, stableHash } from "@agent-control-stack/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  FakeNodeAdapter,
  GraphLedgerWriteError,
  SqliteGraphLedger,
  StaticGraphScheduler,
  validateGraph,
  type NodeAdapterContext,
  type NodeExecutionResult
} from "./index.js";
import { validDiamondGraph } from "./test-fixtures.js";

const tempDirectories: string[] = [];
const openLedgers: SqliteGraphLedger[] = [];

afterEach(() => {
  for (const ledger of openLedgers.splice(0)) {
    try {
      ledger.close();
    } catch {
      // The ledger-write-failure test intentionally exercises a failed write path.
    }
  }
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createLedger(): { ledger: SqliteGraphLedger; databasePath: string } {
  const directory = mkdtempSync(join(tmpdir(), "acs-graph-acceptance-"));
  tempDirectories.push(directory);
  const databasePath = join(directory, "graph.db");
  const ledger = new SqliteGraphLedger(databasePath);
  openLedgers.push(ledger);
  return { ledger, databasePath };
}

function success(output: NodeExecutionResult["output"]): NodeExecutionResult {
  return {
    status: "SUCCEEDED",
    output,
    evidence: [],
    assumptions: [],
    confidence: 1,
    unresolved: [],
    retryable: false,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 1 }
  };
}

function allResults(seedOutput: NodeExecutionResult["output"] = { items: ["a"] }): Record<string, unknown> {
  return {
    seed: success(seedOutput),
    left: success({ findings: ["left"] }),
    right: success({ findings: ["right"] }),
    merge: success({ report: "complete" })
  };
}

describe("Graph v0.1 acceptance gates", () => {
  it("accepts the public envelope and resolves dependencies into a static DAG", async () => {
    const { ledger } = createLedger();
    const graph = {
      graph_id: "graph_minimal",
      version: "0.1",
      requested_by: { actor_id: "hermes-main", actor_type: "agent" },
      intent: "Run a deterministic two-node graph",
      risk: "low",
      idempotency_key: "minimal-submission-1",
      correlation_id: "corr-minimal-1",
      nodes: [
        {
          id: "first",
          function_id: "fake",
          dependencies: [],
          input: { seed: "initial" },
          input_schema: {
            type: "object",
            properties: { seed: { type: "string" } },
            required: ["seed"],
            additionalProperties: false
          },
          output_schema: {
            type: "object",
            properties: { output: { type: "string" } },
            required: ["output"],
            additionalProperties: false
          },
          timeout: 1_000,
          retry_policy: { max_attempts: 1, backoff_ms: 0 },
          risk: "low",
          approval_required: false,
          idempotency_key: "minimal-first-1"
        },
        {
          id: "second",
          function_id: "fake",
          dependencies: ["first"],
          input_schema: { type: "object" },
          output_schema: {
            type: "object",
            properties: { output: { type: "string" } },
            required: ["output"],
            additionalProperties: false
          },
          timeout: 1_000,
          retry_policy: { max_attempts: 1, backoff_ms: 0 },
          risk: "low",
          approval_required: false,
          idempotency_key: "minimal-second-1"
        }
      ]
    };
    const validated = validateGraph(graph, { allowedAdapters: new Set(["fake"]) });
    const fake = new FakeNodeAdapter({
      first: success({ output: "first" }),
      second: success({ output: "second" })
    });
    const scheduler = new StaticGraphScheduler({ ledger, adapters: new Map([["fake", fake]]) });

    const summary = await scheduler.start(graph, { runId: "run-minimal-envelope" });

    expect(validated.topologicalOrder).toEqual(["first", "second"]);
    expect(summary.verdict).toBe("PASS");
    expect(fake.calls.map((call) => call.nodeId)).toEqual(["first", "second"]);
  });

  it("persists the authority envelope and records duplicate idempotency decisions", async () => {
    const { ledger } = createLedger();
    const fake = new FakeNodeAdapter(allResults());
    const scheduler = new StaticGraphScheduler({ ledger, adapters: new Map([["fake", fake]]) });

    const first = await scheduler.start(validDiamondGraph(), { runId: "run-idempotent-first" });
    const duplicate = await scheduler.start(validDiamondGraph(), { runId: "run-idempotent-second" });

    expect(first.runId).toBe("run-idempotent-first");
    expect(duplicate.runId).toBe(first.runId);
    expect(fake.calls).toHaveLength(4);
    expect(ledger.getRun(first.runId)).toEqual(
      expect.objectContaining({
        requestedBy: { actor_id: "hermes-main", actor_type: "agent" },
        intent: "Run deterministic graph tests",
        risk: "low",
        idempotencyKey: "graph-diamond-submission",
        correlationId: "corr-graph-diamond"
      })
    );
    expect(ledger.listIdempotencyDecisions("graph-diamond-submission").map((entry) => entry.decision)).toEqual([
      "ADMITTED",
      "DEDUPLICATED"
    ]);
  });

  it("resumes an idempotent nonterminal submission from the admitted redacted graph", async () => {
    const { ledger } = createLedger();
    const configure = (graph: ReturnType<typeof validDiamondGraph>, secret: string) => {
      const seed = graph.nodes[0]!;
      graph.nodes = [seed];
      graph.edges = [];
      graph.acceptanceTests = [];
      graph.limits.maxDepth = 1;
      seed.input_schema = {
        type: "object",
        properties: { payload: { type: "string" } },
        required: ["payload"],
        additionalProperties: false
      };
      seed.input = { payload: secret };
      seed.parameters = { source: "fixture" };
      seed.retry.maxAttempts = 2;
      seed.retry_policy.max_attempts = 2;
      return graph;
    };
    const first = configure(validDiamondGraph(), `sk-${"a".repeat(24)}`);
    const second = configure(validDiamondGraph(), `sk-${"b".repeat(24)}`);
    const validated = validateGraph(first, { allowedAdapters: new Set(["fake"]) });
    expect(validateGraph(second, { allowedAdapters: new Set(["fake"]) }).graphHash).toBe(validated.graphHash);

    ledger.createRun(validated, "run-idempotent-redacted");
    const { lease } = ledger.acquireSchedulerLease("run-idempotent-redacted", "manual-owner", 60_000);
    const token = { runId: "run-idempotent-redacted", ownerId: lease.ownerId, epoch: lease.leaseEpoch };
    ledger.transitionRun(token, "RUNNING", "manual interruption fixture");
    ledger.transitionNode(token, "seed", "READY", "manual interruption fixture");
    ledger.startAttempt(
      token,
      "seed",
      stableHash({
        graphHash: validated.graphHash,
        nodeId: "seed",
        parameters: redactValue(validated.definition.nodes[0]!.parameters),
        inputs: {},
        input: redactValue(validated.definition.nodes[0]!.input)
      })
    );
    ledger.releaseSchedulerLease(token);

    const fake = new FakeNodeAdapter({ seed: success({ items: [] }) });
    const scheduler = new StaticGraphScheduler({ ledger, adapters: new Map([["fake", fake]]) });

    const summary = await scheduler.start(second, { runId: "run-idempotent-redacted-retry" });

    expect(summary.verdict).toBe("PASS");
    expect(fake.calls.map((call) => call.input)).toEqual([{ payload: "[redacted]" }]);
    expect(ledger.listIdempotencyDecisions("graph-diamond-submission").map((entry) => entry.decision)).toEqual([
      "ADMITTED",
      "DEDUPLICATED"
    ]);
  });

  it("delivers scalar root input and binds it into the admitted input hash", async () => {
    const { ledger } = createLedger();
    const graph = validDiamondGraph();
    const seed = graph.nodes.find((node) => node.id === "seed")!;
    graph.nodes = [seed];
    graph.edges = [];
    graph.acceptanceTests = [];
    graph.limits.maxDepth = 1;
    seed.input = "hello";
    seed.input_schema = { type: "string" };
    const validated = validateGraph(graph, { allowedAdapters: new Set(["fake"]) });
    const fake = new FakeNodeAdapter({ seed: success({ items: [] }) });
    const scheduler = new StaticGraphScheduler({ ledger, adapters: new Map([["fake", fake]]) });

    const summary = await scheduler.start(graph, { runId: "run-scalar-root-input" });

    expect(summary.verdict).toBe("PASS");
    expect(fake.calls[0]!.input).toBe("hello");
    expect(fake.calls[0]!.inputHash).toBe(
      stableHash({
        graphHash: validated.graphHash,
        nodeId: "seed",
        parameters: {},
        inputs: {},
        input: "hello"
      })
    );
  });

  it("redacts graph parameters and adapter results before durable persistence", async () => {
    const { ledger, databasePath } = createLedger();
    const graph = validDiamondGraph();
    graph.nodes.find((node) => node.id === "seed")!.parameters = { password: "super-secret" };
    graph.nodes.find((node) => node.id === "seed")!.input_schema.default = `sk-${"x".repeat(24)}`;
    const fake = new FakeNodeAdapter(allResults({ items: [{ token: "super-secret" }] }));
    const scheduler = new StaticGraphScheduler({ ledger, adapters: new Map([["fake", fake]]) });

    const summary = await scheduler.start(graph, { runId: "run-redacted-payloads" });

    expect(summary.verdict).toBe("PASS");
    expect(ledger.getRun("run-redacted-payloads").definition.nodes[0]!.parameters).toEqual({
      password: "[redacted]"
    });
    expect(ledger.getRun("run-redacted-payloads").definition.nodes[0]!.input_schema.default).toBe("[redacted]");
    expect(ledger.getNode("run-redacted-payloads", "seed").result?.output).toEqual({
      items: [{ token: "[redacted]" }]
    });
    const raw = new DatabaseSync(databasePath);
    const persisted = raw
      .prepare("SELECT definition_json FROM graph_runs WHERE run_id = ?")
      .get("run-redacted-payloads") as unknown as { definition_json: string };
    raw.close();
    expect(persisted.definition_json).not.toContain("super-secret");

    await expect(scheduler.resume("run-redacted-payloads")).resolves.toEqual(
      expect.objectContaining({ verdict: "PASS" })
    );
    expect(fake.invocationCounts.seed).toBe(1);
  });

  it("redacts credential-bearing URI payloads before durable persistence", async () => {
    const { ledger } = createLedger();
    const graph = validDiamondGraph();
    graph.nodes = [graph.nodes[0]!];
    graph.edges = [];
    graph.acceptanceTests = [];
    graph.limits.maxDepth = 1;
    graph.nodes[0]!.input_schema = { type: "object" };
    graph.nodes[0]!.parameters = { source: "https://example.test?client_secret%253Dsecret" };
    const fake = new FakeNodeAdapter({ seed: success({ items: ["https://example.test#private_key%253Dsecret"] }) });
    const scheduler = new StaticGraphScheduler({ ledger, adapters: new Map([["fake", fake]]) });

    const summary = await scheduler.start(graph, { runId: "run-redacted-uri-payloads" });

    expect(summary.verdict).toBe("PASS");
    expect(ledger.getRun(summary.runId).definition.nodes[0]!.parameters).toEqual({ source: "[redacted]" });
    expect(ledger.getNode(summary.runId, "seed").result?.output).toEqual({ items: ["[redacted]"] });
  });

  it("retries only a declared retryable failure and never exceeds the bound", async () => {
    const { ledger } = createLedger();
    const graph = validDiamondGraph();
    graph.nodes[0]!.retry.maxAttempts = 2;
    graph.nodes[0]!.retry_policy.max_attempts = 2;
    const fake = new FakeNodeAdapter(allResults(), {
      behaviors: {
        seed: [{ kind: "retryable-failure", message: "transient fixture failure" }, { kind: "success" }]
      }
    });
    const scheduler = new StaticGraphScheduler({ ledger, adapters: new Map([["fake", fake]]) });

    const summary = await scheduler.start(graph, { runId: "run-retryable" });

    expect(summary.verdict).toBe("PASS");
    expect(fake.invocationCounts.seed).toBe(2);
    expect(ledger.listAttempts("run-retryable", "seed").map((attempt) => attempt.state)).toEqual([
      "FAILED",
      "SUCCEEDED"
    ]);
  });

  it("resumes redacted outputs without changing supported combinator semantics", async () => {
    const { ledger } = createLedger();
    const graph = validDiamondGraph();
    const seed = graph.nodes.find((node) => node.id === "seed")!;
    const secret = `sk-${"x".repeat(24)}`;
    const otherSecret = `sk-${"y".repeat(24)}`;
    graph.nodes = [seed];
    graph.edges = [];
    graph.acceptanceTests = [];
    graph.limits.maxDepth = 1;
    seed.output_schema = {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            oneOf: [
              {
                type: "object",
                properties: { value: { const: secret } },
                required: ["value"],
                additionalProperties: false
              },
              {
                type: "object",
                properties: { value: { type: "number" } },
                required: ["value"],
                additionalProperties: false
              }
            ]
          }
        }
      },
      required: ["items"],
      additionalProperties: false,
      not: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: { value: { const: otherSecret } },
              required: ["value"],
              additionalProperties: false
            }
          }
        },
        required: ["items"],
        additionalProperties: false
      }
    };
    const fake = new FakeNodeAdapter({ seed: success({ items: [{ value: secret }] }) });
    const scheduler = new StaticGraphScheduler({ ledger, adapters: new Map([["fake", fake]]) });

    const started = await scheduler.start(graph, { runId: "run-redacted-combinators" });
    const resumed = await scheduler.resume("run-redacted-combinators");

    expect(started.verdict).toBe("PASS");
    expect(resumed.verdict).toBe("PASS");
    expect(fake.invocationCounts.seed).toBe(1);
  });

  it("blocks approval-required nodes before invoking the adapter", async () => {
    const { ledger } = createLedger();
    const graph = validDiamondGraph();
    graph.nodes[0]!.approval_required = true;
    graph.nodes[0]!.approval = "HUMAN";
    const fake = new FakeNodeAdapter(allResults());
    const scheduler = new StaticGraphScheduler({ ledger, adapters: new Map([["fake", fake]]) });

    const summary = await scheduler.start(graph, { runId: "run-approval-required" });

    expect(summary.verdict).toBe("BLOCK");
    expect(fake.calls).toHaveLength(0);
    expect(ledger.getNode("run-approval-required", "seed")).toEqual(
      expect.objectContaining({
        state: "BLOCKED",
        error: expect.objectContaining({ message: expect.stringContaining("approval required") })
      })
    );
  });

  it("fails closed when a successful output violates the declared JSON schema", async () => {
    const { ledger } = createLedger();
    const graph = validDiamondGraph();
    graph.nodes[0]!.output_schema = {
      type: "object",
      properties: { items: { type: "array", minItems: 2, items: { type: "string" } } },
      required: ["items"],
      additionalProperties: false
    };
    const fake = new FakeNodeAdapter(allResults());
    const scheduler = new StaticGraphScheduler({ ledger, adapters: new Map([["fake", fake]]) });

    const summary = await scheduler.start(graph, { runId: "run-output-schema-mismatch" });

    expect(summary.verdict).toBe("BLOCK");
    expect(ledger.getNode("run-output-schema-mismatch", "seed")).toEqual(
      expect.objectContaining({
        state: "FAILED",
        error: expect.objectContaining({ code: "MALFORMED_RESULT" })
      })
    );
  });

  it("does not treat a literal redacted marker as schema-valid on a fresh run", async () => {
    const { ledger } = createLedger();
    const graph = validDiamondGraph();
    graph.nodes[0]!.output_schema = {
      type: "object",
      properties: { items: { type: "string", const: "expected" } },
      required: ["items"],
      additionalProperties: false
    };
    const fake = new FakeNodeAdapter({
      seed: success({ items: "[redacted]" }),
      left: success({ findings: [] }),
      right: success({ findings: [] }),
      merge: success({ report: "must not run" })
    });
    const scheduler = new StaticGraphScheduler({ ledger, adapters: new Map([["fake", fake]]) });

    const summary = await scheduler.start(graph, { runId: "run-fresh-redacted-marker" });

    expect(summary.verdict).toBe("BLOCK");
    expect(ledger.getNode("run-fresh-redacted-marker", "seed")).toEqual(
      expect.objectContaining({
        state: "FAILED",
        result: null,
        error: expect.objectContaining({ code: "MALFORMED_RESULT" })
      })
    );
  });

  it("rejects a deduplicated start when the durable graph definition no longer matches its hash", async () => {
    const { ledger, databasePath } = createLedger();
    const graph = validDiamondGraph();
    const fake = new FakeNodeAdapter(allResults());
    const scheduler = new StaticGraphScheduler({ ledger, adapters: new Map([["fake", fake]]) });
    await scheduler.start(graph, { runId: "run-dedup-hash" });
    const raw = new DatabaseSync(databasePath);
    const row = raw
      .prepare("SELECT definition_json FROM graph_runs WHERE run_id = ?")
      .get("run-dedup-hash") as unknown as { definition_json: string };
    const tampered = JSON.parse(row.definition_json) as Record<string, unknown>;
    tampered.intent = "tampered durable intent";
    tampered.objective = "tampered durable intent";
    raw
      .prepare("UPDATE graph_runs SET definition_json = ? WHERE run_id = ?")
      .run(JSON.stringify(tampered), "run-dedup-hash");
    raw.close();

    await expect(scheduler.start(graph, { runId: "run-dedup-hash-retry" })).rejects.toEqual(
      expect.objectContaining({ code: "GRAPH_HASH_MISMATCH" })
    );
    expect(fake.calls).toHaveLength(4);
  });

  it("rejects assembled dependency input-schema mismatch before run creation", async () => {
    const { ledger } = createLedger();
    const graph = validDiamondGraph();
    graph.nodes.find((node) => node.id === "left")!.input_schema = {
      type: "object",
      properties: { items: { type: "string" } },
      required: ["items"],
      additionalProperties: false
    };
    const fake = new FakeNodeAdapter(allResults());
    const scheduler = new StaticGraphScheduler({ ledger, adapters: new Map([["fake", fake]]) });

    await expect(scheduler.start(graph, { runId: "run-input-schema-mismatch" })).rejects.toEqual(
      expect.objectContaining({ code: "INPUT_SCHEMA_MISMATCH" })
    );
    expect(fake.calls).toHaveLength(0);
    expect(() => ledger.getRun("run-input-schema-mismatch")).toThrow();
  });

  it("fails closed when the ledger cannot persist an attempt, before adapter execution", async () => {
    const { ledger, databasePath } = createLedger();
    const raw = new DatabaseSync(databasePath);
    raw.exec(`
      CREATE TRIGGER reject_graph_attempts
      BEFORE INSERT ON graph_attempts
      BEGIN
        SELECT RAISE(ABORT, 'injected ledger write failure');
      END;
    `);
    raw.close();
    const fake = new FakeNodeAdapter(allResults());
    const scheduler = new StaticGraphScheduler({ ledger, adapters: new Map([["fake", fake]]) });

    await expect(scheduler.start(validDiamondGraph(), { runId: "run-ledger-write-failure" })).rejects.toBeInstanceOf(
      GraphLedgerWriteError
    );

    expect(fake.calls).toHaveLength(0);
    expect(ledger.listAttempts("run-ledger-write-failure")).toHaveLength(0);
    expect(ledger.getNode("run-ledger-write-failure", "seed").state).toBe("READY");
  });

  it("returns deterministic duplicate deliveries without network or shell access", async () => {
    const graph = validateGraph(validDiamondGraph(), { allowedAdapters: new Set(["fake"]) });
    const fake = new FakeNodeAdapter(allResults());
    const node = graph.definition.nodes.find((candidate) => candidate.id === "seed")!;
    const context: NodeAdapterContext = {
      runId: "run-duplicate-delivery",
      graphId: graph.definition.graphId,
      graphHash: graph.graphHash,
      node,
      input: undefined,
      parameters: {},
      inputs: {},
      inputHash: "a".repeat(64),
      attemptNumber: 1,
      signal: new AbortController().signal
    };

    const [first, second] = await fake.duplicateDelivery(context);

    expect(second).toEqual(first);
    expect(fake.invocationCounts.seed).toBe(2);
    expect(fake.calls.map((call) => call.nodeId)).toEqual(["seed", "seed"]);
  });
});
