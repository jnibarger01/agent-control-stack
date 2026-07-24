import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { stableHash } from "@agent-control-stack/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  FakeNodeAdapter,
  GraphSchedulerLeaseError,
  SqliteGraphLedger,
  StaticGraphScheduler,
  calculateGraphVerdict,
  validateGraph,
  type NodeAdapter,
  type NodeExecutionResult,
  type RunLeaseToken
} from "./index.js";
import { validDiamondGraph } from "./test-fixtures.js";
import { ExecutableTestNodeAdapter } from "./test-helpers/executable-node-adapter.js";

class SpoofedFakeNodeAdapter extends FakeNodeAdapter {
  override async execute(context: Parameters<FakeNodeAdapter["execute"]>[0]): Promise<unknown> {
    return super.execute(context);
  }
}

const tempDirectories: string[] = [];
const openLedgers: SqliteGraphLedger[] = [];

afterEach(() => {
  for (const ledger of openLedgers.splice(0)) {
    try {
      ledger.close();
    } catch {
      // A test may deliberately close and reopen the same database.
    }
  }
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createLedger(): { ledger: SqliteGraphLedger; databasePath: string } {
  const directory = mkdtempSync(join(tmpdir(), "acs-graph-scheduler-"));
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

function failure(message: string): NodeExecutionResult {
  return {
    status: "FAILED",
    output: {},
    evidence: [],
    assumptions: [],
    confidence: 1,
    unresolved: [message],
    retryable: false,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 1 }
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function claim(ledger: SqliteGraphLedger, runId: string, ownerId = "test-owner"): RunLeaseToken {
  const { lease } = ledger.acquireSchedulerLease(runId, ownerId, 60_000);
  return { runId, ownerId: lease.ownerId, epoch: lease.leaseEpoch };
}

describe("static graph scheduler", () => {
  it("admits only the built-in inert fake adapter in v0.1", () => {
    const { ledger } = createLedger();
    const spoofed = new ExecutableTestNodeAdapter({
      seed: async () => success({})
    });

    expect(() => new StaticGraphScheduler({ ledger, adapters: new Map([["fake", spoofed]]) })).toThrowError(
      expect.objectContaining({ code: "UNSUPPORTED_ADAPTER_IMPLEMENTATION" })
    );

    const subclassed = new SpoofedFakeNodeAdapter({ seed: success({}) });
    expect(() => new StaticGraphScheduler({ ledger, adapters: new Map([["fake", subclassed]]) })).toThrowError(
      expect.objectContaining({ code: "UNSUPPORTED_ADAPTER_IMPLEMENTATION" })
    );

    const mutated = new FakeNodeAdapter({ seed: success({}) });
    mutated.execute = async () => success({});
    expect(() => new StaticGraphScheduler({ ledger, adapters: new Map([["fake", mutated]]) })).toThrowError(
      expect.objectContaining({ code: "UNSUPPORTED_ADAPTER_IMPLEMENTATION" })
    );
  });

  it("rejects executable fake behavior at construction", () => {
    expect(
      () =>
        new FakeNodeAdapter({
          seed: { result: (() => success({ items: [] })) as unknown }
        })
    ).toThrow();
  });

  it("keeps fake invocation counts safe for prototype-named node IDs", async () => {
    const { ledger } = createLedger();
    const graph = validDiamondGraph();
    graph.nodes = [graph.nodes[0]!];
    graph.nodes[0]!.id = "constructor";
    graph.nodes[0]!.retry.maxAttempts = 2;
    graph.nodes[0]!.retry_policy.max_attempts = 2;
    graph.edges = [];
    graph.acceptanceTests = [];
    graph.limits.maxDepth = 1;
    const fake = new FakeNodeAdapter(
      { constructor: success({ items: [] }) },
      {
        behaviors: {
          constructor: [{ kind: "retryable-failure" as const }, { kind: "success" as const }]
        }
      }
    );
    const scheduler = new StaticGraphScheduler({ ledger, adapters: new Map([["fake", fake]]) });

    const summary = await scheduler.start(graph, { runId: "run-prototype-node-id" });

    expect(summary.verdict).toBe("PASS");
    expect(fake.invocationCounts["constructor"]).toBe(2);
  });

  it("freezes the admitted adapter registry and dispatch binding", async () => {
    const { ledger } = createLedger();
    const fake = new FakeNodeAdapter({ seed: success({ items: [] }) });
    const executable = new ExecutableTestNodeAdapter({
      seed: async () => {
        throw new Error("replacement adapter must never execute");
      }
    });
    const registry = new Map<string, NodeAdapter>([["fake", fake]]);
    const scheduler = new StaticGraphScheduler({ ledger, adapters: registry });
    registry.set("fake", executable);
    fake.execute = async () => {
      throw new Error("mutated adapter method must never execute");
    };

    const graph = validDiamondGraph();
    graph.nodes = [graph.nodes[0]!];
    graph.edges = [];
    graph.acceptanceTests = [];
    graph.limits.maxDepth = 1;
    const summary = await scheduler.start(graph, { runId: "run-frozen-adapter-registry" });

    expect(summary.verdict).toBe("PASS");
    expect(fake.invocationCounts.seed).toBe(1);
  });

  it("prevents a second scheduler from claiming an actively owned run", async () => {
    const { ledger } = createLedger();
    const graph = validateGraph(validDiamondGraph(), { allowedAdapters: new Set(["fake"]) });
    ledger.createRun(graph, "run-active-owner");
    const lease = claim(ledger, "run-active-owner", "owner-a");
    ledger.transitionRun(lease, "RUNNING", "first scheduler started");
    const fake = new FakeNodeAdapter({
      seed: success({ items: [] }),
      left: success({ findings: [] }),
      right: success({ findings: [] }),
      merge: success({ report: "must not run" })
    });
    const second = new StaticGraphScheduler({
      ledger,
      adapters: new Map([["fake", fake]]),
      ownerId: "owner-b",
      leaseTtlMs: 5_000
    });

    await expect(second.resume("run-active-owner")).rejects.toThrow(GraphSchedulerLeaseError);
    expect(fake.calls).toHaveLength(0);
  });

  it("recovers an expired scheduler owner and releases ownership after safe read-only completion", async () => {
    const { ledger, databasePath } = createLedger();
    const graph = validateGraph(validDiamondGraph(), { allowedAdapters: new Set(["fake"]) });
    ledger.createRun(graph, "run-expired-owner");
    const staleLease = claim(ledger, "run-expired-owner", "owner-stale");
    ledger.transitionRun(staleLease, "RUNNING", "stale scheduler started");
    const raw = new DatabaseSync(databasePath);
    raw
      .prepare("UPDATE graph_scheduler_leases SET acquired_at = ?, heartbeat_at = ?, expires_at = ? WHERE run_id = ?")
      .run("2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z", "2000-01-01T00:00:01.000Z", "run-expired-owner");
    raw.close();
    const fake = new FakeNodeAdapter({
      seed: success({ items: [] }),
      left: success({ findings: [] }),
      right: success({ findings: [] }),
      merge: success({ report: "recovered" })
    });
    const recovered = new StaticGraphScheduler({
      ledger,
      adapters: new Map([["fake", fake]]),
      ownerId: "owner-recovered",
      leaseTtlMs: 5_000
    });

    const summary = await recovered.resume("run-expired-owner");

    expect(summary.verdict).toBe("PASS");
    expect(fake.calls).toHaveLength(4);
    expect(ledger.getSchedulerLease("run-expired-owner")).toBeNull();
  });

  it("executes a valid diamond with concurrent fan-out and deterministic fan-in", async () => {
    const { ledger } = createLedger();
    const fake = new FakeNodeAdapter(
      {
        seed: success({ items: ["a", "b"] }),
        left: success({ findings: ["left"] }),
        right: success({ findings: ["right"] }),
        merge: success({ report: "complete" })
      },
      { delaysMs: { left: 20, right: 20 } }
    );
    const scheduler = new StaticGraphScheduler({ ledger, adapters: new Map([["fake", fake]]) });

    const summary = await scheduler.start(validDiamondGraph(), { runId: "run-diamond" });

    expect(summary.verdict).toBe("PASS");
    expect(summary.state).toBe("SUCCEEDED");
    expect(summary.nodes.every((node) => node.state === "SUCCEEDED")).toBe(true);
    expect(fake.maxObservedConcurrency).toBe(2);
    expect(fake.calls.find((call) => call.nodeId === "merge")?.inputs).toEqual({
      findings: [["left"], ["right"]]
    });
    expect(fake.calls.map((call) => call.nodeId)).toEqual(["seed", "left", "right", "merge"]);
  });

  it("blocks downstream work when a required dependency fails", async () => {
    const { ledger } = createLedger();
    const fake = new FakeNodeAdapter({
      seed: success({ items: ["a"] }),
      left: failure("review failed"),
      right: success({ findings: ["right"] }),
      merge: success({ report: "must not run" })
    });
    const scheduler = new StaticGraphScheduler({ ledger, adapters: new Map([["fake", fake]]) });

    const summary = await scheduler.start(validDiamondGraph(), { runId: "run-required-failure" });

    expect(summary.verdict).toBe("BLOCK");
    expect(summary.nodes.find((node) => node.nodeId === "left")?.state).toBe("FAILED");
    expect(summary.nodes.find((node) => node.nodeId === "right")?.state).toBe("SUCCEEDED");
    expect(summary.nodes.find((node) => node.nodeId === "merge")?.state).toBe("BLOCKED");
    expect(fake.calls.map((call) => call.nodeId)).not.toContain("merge");
  });

  it("continues after an optional dependency fails and reports visible degradation", async () => {
    const { ledger } = createLedger();
    const graph = validDiamondGraph();
    graph.nodes.find((node) => node.id === "left")!.required = false;
    graph.edges.find((edge) => edge.id === "left-merge")!.required = false;
    const fake = new FakeNodeAdapter({
      seed: success({ items: ["a"] }),
      left: failure("optional reviewer unavailable"),
      right: success({ findings: ["right"] }),
      merge: success({ report: "degraded but complete" })
    });
    const scheduler = new StaticGraphScheduler({ ledger, adapters: new Map([["fake", fake]]) });

    const summary = await scheduler.start(graph, { runId: "run-optional-failure" });

    expect(summary.verdict).toBe("PARTIAL");
    expect(summary.failedOptionalNodeIds).toEqual(["left"]);
    expect(summary.nodes.find((node) => node.nodeId === "merge")?.state).toBe("SUCCEEDED");
    expect(fake.calls.find((call) => call.nodeId === "merge")?.inputs).toEqual({ findings: [["right"]] });
  });

  it("blocks a required input when every optional source fails", async () => {
    const { ledger } = createLedger();
    const graph = validDiamondGraph();
    for (const nodeId of ["left", "right"]) {
      graph.nodes.find((node) => node.id === nodeId)!.required = false;
    }
    for (const edgeId of ["left-merge", "right-merge"]) {
      graph.edges.find((edge) => edge.id === edgeId)!.required = false;
    }
    const fake = new FakeNodeAdapter({
      seed: success({ items: ["a"] }),
      left: failure("left unavailable"),
      right: failure("right unavailable"),
      merge: success({ report: "must not run" })
    });
    const scheduler = new StaticGraphScheduler({ ledger, adapters: new Map([["fake", fake]]) });

    const summary = await scheduler.start(graph, { runId: "run-empty-required-input" });

    expect(summary.verdict).toBe("BLOCK");
    expect(summary.nodes.find((node) => node.nodeId === "merge")?.state).toBe("BLOCKED");
    expect(fake.calls.map((call) => call.nodeId)).not.toContain("merge");
  });

  it("fails a node closed when an adapter returns malformed output", async () => {
    const { ledger } = createLedger();
    const fake = new FakeNodeAdapter({
      seed: { status: "SUCCEEDED", output: { items: ["a"] } },
      left: success({ findings: [] }),
      right: success({ findings: [] }),
      merge: success({ report: "must not run" })
    });
    const scheduler = new StaticGraphScheduler({ ledger, adapters: new Map([["fake", fake]]) });

    const summary = await scheduler.start(validDiamondGraph(), { runId: "run-malformed" });

    expect(summary.verdict).not.toBe("PASS");
    expect(ledger.getNode("run-malformed", "seed")).toEqual(
      expect.objectContaining({
        state: "FAILED",
        result: null,
        error: expect.objectContaining({ code: "MALFORMED_RESULT" })
      })
    );
  });

  it("records a node timeout as failure instead of accepting late output", async () => {
    const { ledger } = createLedger();
    const graph = validDiamondGraph();
    graph.nodes.find((node) => node.id === "seed")!.timeout = 5;
    graph.nodes.find((node) => node.id === "seed")!.timeoutMs = 5;
    const fake = new FakeNodeAdapter(
      {
        seed: success({ items: ["late"] }),
        left: success({ findings: [] }),
        right: success({ findings: [] }),
        merge: success({ report: "must not run" })
      },
      { delaysMs: { seed: 30 } }
    );
    const scheduler = new StaticGraphScheduler({ ledger, adapters: new Map([["fake", fake]]) });

    const summary = await scheduler.start(graph, { runId: "run-timeout" });

    expect(summary.verdict).not.toBe("PASS");
    expect(ledger.getNode("run-timeout", "seed")).toEqual(
      expect.objectContaining({
        state: "FAILED",
        result: null,
        error: expect.objectContaining({ code: "NODE_TIMEOUT" })
      })
    );
  });

  it("uses the original run admission time for the graph wall-clock limit on resume", async () => {
    const { ledger } = createLedger();
    const graphInput = validDiamondGraph();
    graphInput.limits.wallClockMs = 50;
    const graph = validateGraph(graphInput, { allowedAdapters: new Set(["fake"]) });
    ledger.createRun(graph, "run-expired");
    const lease = claim(ledger, "run-expired");
    ledger.transitionRun(lease, "RUNNING", "scheduler started");
    ledger.releaseSchedulerLease(lease);
    await delay(75);

    const fake = new FakeNodeAdapter({
      seed: success({ items: ["must not run"] }),
      left: success({ findings: [] }),
      right: success({ findings: [] }),
      merge: success({ report: "must not run" })
    });
    const scheduler = new StaticGraphScheduler({ ledger, adapters: new Map([["fake", fake]]) });

    const summary = await scheduler.resume("run-expired");

    expect(summary.verdict).toBe("BLOCK");
    expect(summary.state).toBe("BLOCKED");
    expect(fake.calls).toHaveLength(0);
    expect(summary.nodes.every((node) => node.state === "BLOCKED")).toBe(true);
  });

  it("fails the overshooting node when reported usage exceeds graph budget", async () => {
    const { ledger } = createLedger();
    const seedResult = success({ items: ["a"] });
    seedResult.usage.inputTokens = 1;
    const fake = new FakeNodeAdapter({
      seed: seedResult,
      left: success({ findings: [] }),
      right: success({ findings: [] }),
      merge: success({ report: "must not run" })
    });
    const scheduler = new StaticGraphScheduler({ ledger, adapters: new Map([["fake", fake]]) });

    const summary = await scheduler.start(validDiamondGraph(), { runId: "run-budget" });

    expect(summary.verdict).not.toBe("PASS");
    expect(ledger.getNode("run-budget", "seed")).toEqual(
      expect.objectContaining({
        state: "FAILED",
        error: expect.objectContaining({ code: "BUDGET_EXCEEDED" })
      })
    );
    expect(ledger.getRunBudget("run-budget")).toEqual(
      expect.objectContaining({ usedTokens: 0, usedCostUsd: 0, reservedTokens: 0, reservedCostUsd: 0 })
    );
    expect(ledger.listBudgetReservations("run-budget")).toEqual([
      expect.objectContaining({ state: "RELEASED", actualTokens: null, actualCostUsd: null })
    ]);
  });

  it("atomically prevents two concurrently ready nodes from oversubscribing the run budget", async () => {
    const { ledger } = createLedger();
    const graph = validDiamondGraph();
    graph.limits.tokenCeiling = 10;
    for (const node of graph.nodes) {
      Object.assign(node, { budget: { maxTokens: 0, maxCostUsd: 0, apiSlots: 0 } });
    }
    for (const nodeId of ["left", "right"]) {
      Object.assign(
        graph.nodes.find((node) => node.id === nodeId)!,
        {
          budget: { maxTokens: 6, maxCostUsd: 0, apiSlots: 0 }
        }
      );
    }
    const left = success({ findings: ["left"] });
    left.usage.inputTokens = 6;
    const right = success({ findings: ["right"] });
    right.usage.inputTokens = 6;
    const fake = new FakeNodeAdapter(
      {
        seed: success({ items: ["a"] }),
        left,
        right,
        merge: success({ report: "must not run" })
      },
      { delaysMs: { left: 20, right: 20 } }
    );
    const scheduler = new StaticGraphScheduler({ ledger, adapters: new Map([["fake", fake]]) });

    const summary = await scheduler.start(graph, { runId: "run-concurrent-budget" });

    expect(summary.verdict).toBe("BLOCK");
    expect(fake.calls.filter((call) => call.nodeId === "left" || call.nodeId === "right")).toHaveLength(1);
    expect(
      summary.nodes
        .filter((node) => ["left", "right"].includes(node.nodeId))
        .map((node) => node.state)
        .sort()
    ).toEqual(["BLOCKED", "SUCCEEDED"]);
    expect(ledger.getRunBudget("run-concurrent-budget")).toEqual(
      expect.objectContaining({ usedTokens: 6, reservedTokens: 0 })
    );
    expect(
      ledger.listBudgetReservations("run-concurrent-budget").filter((reservation) => reservation.maxTokens > 0)
    ).toEqual([expect.objectContaining({ state: "SETTLED", maxTokens: 6, actualTokens: 6 })]);
  });

  it("defers temporary API-slot contention and runs ready work serially", async () => {
    const { ledger } = createLedger();
    const graph = validDiamondGraph();
    graph.limits.apiConcurrency = 1;
    for (const nodeId of ["left", "right"]) {
      graph.nodes.find((node) => node.id === nodeId)!.budget.apiSlots = 1;
    }
    const fake = new FakeNodeAdapter(
      {
        seed: success({ items: ["a"] }),
        left: success({ findings: ["left"] }),
        right: success({ findings: ["right"] }),
        merge: success({ report: "serial" })
      },
      { delaysMs: { left: 10, right: 10 } }
    );
    const scheduler = new StaticGraphScheduler({ ledger, adapters: new Map([["fake", fake]]) });

    const summary = await scheduler.start(graph, { runId: "run-api-contention" });

    expect(summary.verdict).toBe("PASS");
    expect(fake.calls.map((call) => call.nodeId)).toEqual(["seed", "left", "right", "merge"]);
    expect(fake.maxObservedConcurrency).toBe(1);
  });

  it("allows concurrent read-only nodes on overlapping declared scopes", async () => {
    const { ledger } = createLedger();
    const graph = validDiamondGraph();
    for (const nodeId of ["left", "right"]) {
      const node = graph.nodes.find((candidate) => candidate.id === nodeId)!;
      node.sideEffect = "READ_ONLY";
      node.resources = {
        ...node.resources,
        filesystem: [
          {
            scope: nodeId === "left" ? "repo://acs/**" : "repo://acs/src/**",
            access: "READ" as const
          }
        ]
      };
    }
    const fake = new FakeNodeAdapter(
      {
        seed: success({ items: ["a"] }),
        left: success({ findings: ["left"] }),
        right: success({ findings: ["right"] }),
        merge: success({ report: "complete" })
      },
      { delaysMs: { left: 15, right: 15 } }
    );
    const scheduler = new StaticGraphScheduler({ ledger, adapters: new Map([["fake", fake]]) });

    const summary = await scheduler.start(graph, { runId: "run-read-only-overlap" });

    expect(summary.verdict).toBe("PASS");
    expect(fake.maxObservedConcurrency).toBe(2);
  });

  it("fails closed on resume when persisted output content no longer matches its hash", async () => {
    const { ledger, databasePath } = createLedger();
    const fake = new FakeNodeAdapter({
      seed: success({ items: ["a"] }),
      left: success({ findings: ["left"] }),
      right: success({ findings: ["right"] }),
      merge: success({ report: "complete" })
    });
    const scheduler = new StaticGraphScheduler({ ledger, adapters: new Map([["fake", fake]]) });
    await scheduler.start(validDiamondGraph(), { runId: "run-output-integrity" });
    const seed = ledger.getNode("run-output-integrity", "seed");
    const tampered = { ...seed.result!, output: { items: ["tampered"] } };
    const raw = new DatabaseSync(databasePath);
    raw
      .prepare("UPDATE graph_nodes SET result_json = ? WHERE run_id = ? AND node_id = ?")
      .run(JSON.stringify(tampered), "run-output-integrity", "seed");
    raw.close();

    await expect(scheduler.resume("run-output-integrity")).rejects.toMatchObject({
      code: "PERSISTED_RESULT_INVALID"
    });
  });

  it("fails closed on resume when a persisted node input hash is tampered", async () => {
    const { ledger, databasePath } = createLedger();
    const fake = new FakeNodeAdapter({
      seed: success({ items: ["a"] }),
      left: success({ findings: ["left"] }),
      right: success({ findings: ["right"] }),
      merge: success({ report: "complete" })
    });
    const scheduler = new StaticGraphScheduler({ ledger, adapters: new Map([["fake", fake]]) });
    await scheduler.start(validDiamondGraph(), { runId: "run-input-integrity" });
    const raw = new DatabaseSync(databasePath);
    raw
      .prepare("UPDATE graph_attempts SET input_hash = ? WHERE run_id = ? AND node_id = ?")
      .run("f".repeat(64), "run-input-integrity", "merge");
    raw.close();
    const transitionsBefore = ledger.listTransitions("run-input-integrity").length;
    const budgetBefore = ledger.getRunBudget("run-input-integrity");

    await expect(scheduler.resume("run-input-integrity")).rejects.toMatchObject({
      code: "PERSISTED_INPUT_INVALID"
    });
    expect(fake.calls).toHaveLength(4);
    expect(ledger.listTransitions("run-input-integrity")).toHaveLength(transitionsBefore);
    expect(ledger.getRunBudget("run-input-integrity")).toEqual(budgetBefore);
  });

  it("fails closed on terminal resume when a persisted failed-attempt output hash is tampered", async () => {
    const { ledger, databasePath } = createLedger();
    const fake = new FakeNodeAdapter({
      seed: failure("expected failure")
    });
    const scheduler = new StaticGraphScheduler({ ledger, adapters: new Map([["fake", fake]]) });
    const summary = await scheduler.start(validDiamondGraph(), { runId: "run-failed-output-integrity" });
    expect(summary.state).toBe("BLOCKED");
    const failedAttempt = ledger.listAttempts("run-failed-output-integrity", "seed")[0]!;
    expect(failedAttempt.state).toBe("FAILED");
    const raw = new DatabaseSync(databasePath);
    raw
      .prepare("UPDATE graph_attempts SET output_hash = ? WHERE attempt_id = ?")
      .run("f".repeat(64), failedAttempt.attemptId);
    raw.close();
    const transitionsBefore = ledger.listTransitions("run-failed-output-integrity").length;

    await expect(scheduler.resume("run-failed-output-integrity")).rejects.toMatchObject({
      code: "PERSISTED_RESULT_INVALID"
    });
    expect(ledger.listTransitions("run-failed-output-integrity")).toHaveLength(transitionsBefore);
    expect(ledger.getSchedulerLease("run-failed-output-integrity")).toBeNull();
  });

  it.each(["node", "attempt"] as const)(
    "fails closed when a persisted blocked %s output hash is tampered",
    async (target) => {
      const { ledger, databasePath } = createLedger();
      const blocked: NodeExecutionResult = { ...failure("expected block"), status: "BLOCKED" };
      const fake = new FakeNodeAdapter({ seed: blocked });
      const scheduler = new StaticGraphScheduler({ ledger, adapters: new Map([["fake", fake]]) });
      const runId = `run-blocked-${target}-integrity`;
      await scheduler.start(validDiamondGraph(), { runId });
      const attempt = ledger.listAttempts(runId, "seed")[0]!;
      expect(attempt.state).toBe("BLOCKED");
      const raw = new DatabaseSync(databasePath);
      if (target === "node") {
        raw
          .prepare("UPDATE graph_nodes SET output_hash = ? WHERE run_id = ? AND node_id = 'seed'")
          .run("f".repeat(64), runId);
      } else {
        raw
          .prepare("UPDATE graph_attempts SET output_hash = ? WHERE attempt_id = ?")
          .run("f".repeat(64), attempt.attemptId);
      }
      raw.close();

      await expect(scheduler.resume(runId)).rejects.toMatchObject({ code: "PERSISTED_RESULT_INVALID" });
      expect(ledger.getSchedulerLease(runId)).toBeNull();
    }
  );

  it("rejects nonterminal input-hash tampering before lease acquisition or reconciliation", async () => {
    const { ledger, databasePath } = createLedger();
    const graphInput = validDiamondGraph();
    graphInput.nodes[0]!.retry.maxAttempts = 2;
    graphInput.nodes[0]!.retry_policy.max_attempts = 2;
    const graph = validateGraph(graphInput, { allowedAdapters: new Set(["fake"]) });
    ledger.createRun(graph, "run-nonterminal-input-integrity");
    const lease = claim(ledger, "run-nonterminal-input-integrity");
    ledger.transitionRun(lease, "RUNNING", "scheduler started");
    ledger.transitionNode(lease, "seed", "READY", "dependencies satisfied");
    const inputHash = stableHash({
      graphHash: graph.graphHash,
      nodeId: "seed",
      parameters: graph.definition.nodes[0]!.parameters,
      inputs: {}
    });
    ledger.startAttempt(lease, "seed", inputHash);
    ledger.releaseSchedulerLease(lease);
    const transitionsBefore = ledger.listTransitions("run-nonterminal-input-integrity").length;
    const raw = new DatabaseSync(databasePath);
    raw
      .prepare("UPDATE graph_attempts SET input_hash = ? WHERE run_id = ? AND node_id = 'seed'")
      .run("f".repeat(64), "run-nonterminal-input-integrity");
    raw.close();
    const fake = new FakeNodeAdapter({
      seed: success({ items: ["must not execute"] })
    });
    const scheduler = new StaticGraphScheduler({ ledger, adapters: new Map([["fake", fake]]) });

    await expect(scheduler.resume("run-nonterminal-input-integrity")).rejects.toMatchObject({
      code: "PERSISTED_INPUT_INVALID"
    });
    expect(fake.calls).toHaveLength(0);
    expect(ledger.getSchedulerLease("run-nonterminal-input-integrity")).toBeNull();
    expect(ledger.getNode("run-nonterminal-input-integrity", "seed").state).toBe("RUNNING");
    expect(ledger.listTransitions("run-nonterminal-input-integrity")).toHaveLength(transitionsBefore);
  });

  it("rejects nonterminal successful-attempt tampering before lease acquisition or reconciliation", async () => {
    const { ledger, databasePath } = createLedger();
    const graphInput = validDiamondGraph();
    graphInput.nodes.find((node) => node.id === "left")!.retry.maxAttempts = 2;
    graphInput.nodes.find((node) => node.id === "left")!.retry_policy.max_attempts = 2;
    const graph = validateGraph(graphInput, { allowedAdapters: new Set(["fake"]) });
    const seedResult = success({ items: ["persisted"] });
    ledger.createRun(graph, "run-nonterminal-integrity");
    const lease = claim(ledger, "run-nonterminal-integrity");
    ledger.transitionRun(lease, "RUNNING", "scheduler started");
    ledger.transitionNode(lease, "seed", "READY", "dependencies satisfied");
    const seedInputHash = stableHash({
      graphHash: graph.graphHash,
      nodeId: "seed",
      parameters: graph.definition.nodes.find((node) => node.id === "seed")!.parameters,
      inputs: {}
    });
    const seedAttempt = ledger.startAttempt(lease, "seed", seedInputHash);
    ledger.completeAttempt({
      lease,
      nodeId: "seed",
      attemptId: seedAttempt.attemptId,
      state: "SUCCEEDED",
      result: seedResult,
      outputHash: stableHash(seedResult.output)
    });
    ledger.transitionNode(lease, "left", "READY", "dependencies satisfied");
    const leftInputHash = stableHash({
      graphHash: graph.graphHash,
      nodeId: "left",
      parameters: graph.definition.nodes.find((node) => node.id === "left")!.parameters,
      inputs: { items: [["persisted"]] }
    });
    ledger.startAttempt(lease, "left", leftInputHash);
    ledger.releaseSchedulerLease(lease);
    const transitionsBefore = ledger.listTransitions("run-nonterminal-integrity").length;
    const budgetBefore = ledger.getRunBudget("run-nonterminal-integrity");
    const raw = new DatabaseSync(databasePath);
    raw
      .prepare("UPDATE graph_attempts SET output_hash = ? WHERE attempt_id = ?")
      .run("f".repeat(64), seedAttempt.attemptId);
    raw.close();
    const fake = new FakeNodeAdapter({
      left: success({ findings: ["must not execute"] }),
      right: success({ findings: ["must not execute"] }),
      merge: success({ report: "must not execute" })
    });
    const scheduler = new StaticGraphScheduler({ ledger, adapters: new Map([["fake", fake]]) });

    await expect(scheduler.resume("run-nonterminal-integrity")).rejects.toMatchObject({
      code: "PERSISTED_RESULT_INVALID"
    });
    expect(fake.calls).toHaveLength(0);
    expect(ledger.getSchedulerLease("run-nonterminal-integrity")).toBeNull();
    expect(ledger.getNode("run-nonterminal-integrity", "left").state).toBe("RUNNING");
    expect(ledger.listTransitions("run-nonterminal-integrity")).toHaveLength(transitionsBefore);
    expect(ledger.getRunBudget("run-nonterminal-integrity")).toEqual(budgetBefore);
  });

  it("resumes interrupted read-only work without rerunning a completed node", async () => {
    const { ledger, databasePath } = createLedger();
    const graphInput = validDiamondGraph();
    graphInput.nodes.find((node) => node.id === "left")!.retry.maxAttempts = 2;
    graphInput.nodes.find((node) => node.id === "left")!.retry_policy.max_attempts = 2;
    const graph = validateGraph(graphInput, { allowedAdapters: new Set(["fake"]) });
    const seedResult = success({ items: ["persisted"] });

    ledger.createRun(graph, "run-resume");
    const lease = claim(ledger, "run-resume");
    ledger.transitionRun(lease, "RUNNING", "scheduler started");
    ledger.transitionNode(lease, "seed", "READY", "dependencies satisfied");
    const seedInputHash = stableHash({
      graphHash: graph.graphHash,
      nodeId: "seed",
      parameters: graph.definition.nodes.find((node) => node.id === "seed")!.parameters,
      inputs: {}
    });
    const seedAttempt = ledger.startAttempt(lease, "seed", seedInputHash);
    ledger.completeAttempt({
      lease,
      nodeId: "seed",
      attemptId: seedAttempt.attemptId,
      state: "SUCCEEDED",
      result: seedResult,
      outputHash: stableHash(seedResult.output)
    });
    ledger.transitionNode(lease, "left", "READY", "dependencies satisfied");
    const leftInputHash = stableHash({
      graphHash: graph.graphHash,
      nodeId: "left",
      parameters: graph.definition.nodes.find((node) => node.id === "left")!.parameters,
      inputs: { items: [["persisted"]] }
    });
    ledger.startAttempt(lease, "left", leftInputHash);
    ledger.releaseSchedulerLease(lease);
    ledger.close();
    openLedgers.splice(openLedgers.indexOf(ledger), 1);

    const reopened = new SqliteGraphLedger(databasePath);
    openLedgers.push(reopened);
    const fake = new FakeNodeAdapter({
      left: success({ findings: ["left"] }),
      right: success({ findings: ["right"] }),
      merge: success({ report: "resumed" })
    });
    const scheduler = new StaticGraphScheduler({ ledger: reopened, adapters: new Map([["fake", fake]]) });

    const summary = await scheduler.resume("run-resume");

    expect(summary.verdict).toBe("PASS");
    expect(fake.calls.map((call) => call.nodeId)).toEqual(["left", "right", "merge"]);
    expect(reopened.getNode("run-resume", "seed").attemptCount).toBe(1);
    expect(reopened.getNode("run-resume", "left").attemptCount).toBe(2);
  });

  it("reconciles an interrupted idempotent submission before continuing", async () => {
    const { ledger } = createLedger();
    const graphInput = validDiamondGraph();
    graphInput.nodes[0]!.retry.maxAttempts = 2;
    graphInput.nodes[0]!.retry_policy.max_attempts = 2;
    const graph = validateGraph(graphInput, { allowedAdapters: new Set(["fake"]) });
    ledger.createRun(graph, "run-idempotent-recovery");
    const lease = claim(ledger, "run-idempotent-recovery");
    ledger.transitionRun(lease, "RUNNING", "scheduler started");
    ledger.transitionNode(lease, "seed", "READY", "dependencies satisfied");
    const inputHash = stableHash({
      graphHash: graph.graphHash,
      nodeId: "seed",
      parameters: graph.definition.nodes.find((node) => node.id === "seed")!.parameters,
      inputs: {}
    });
    ledger.startAttempt(lease, "seed", inputHash);
    ledger.releaseSchedulerLease(lease);

    const fake = new FakeNodeAdapter({
      seed: success({ items: ["recovered"] }),
      left: success({ findings: ["left"] }),
      right: success({ findings: ["right"] }),
      merge: success({ report: "recovered" })
    });
    const scheduler = new StaticGraphScheduler({ ledger, adapters: new Map([["fake", fake]]) });

    const summary = await scheduler.start(graphInput, { runId: "run-idempotent-recovery" });

    expect(summary.verdict).toBe("PASS");
    expect(fake.calls.map((call) => call.nodeId)).toEqual(["seed", "left", "right", "merge"]);
    expect(ledger.getNode("run-idempotent-recovery", "seed").attemptCount).toBe(2);
  });

  it("aggregates a blocked verdict after recovery exhausts the attempt bound", async () => {
    const { ledger } = createLedger();
    const graphInput = validDiamondGraph();
    graphInput.nodes[0]!.retry.maxAttempts = 1;
    graphInput.nodes[0]!.retry_policy.max_attempts = 1;
    const graph = validateGraph(graphInput, { allowedAdapters: new Set(["fake"]) });
    ledger.createRun(graph, "run-recovery-attempt-limit");
    const lease = claim(ledger, "run-recovery-attempt-limit");
    ledger.transitionRun(lease, "RUNNING", "scheduler started");
    ledger.transitionNode(lease, "seed", "READY", "dependencies satisfied");
    const seed = graph.definition.nodes.find((node) => node.id === "seed")!;
    ledger.startAttempt(
      lease,
      "seed",
      stableHash({ graphHash: graph.graphHash, nodeId: "seed", parameters: seed.parameters, inputs: {} })
    );
    ledger.releaseSchedulerLease(lease);

    const fake = new FakeNodeAdapter({
      seed: success({ items: ["recovered"] }),
      left: success({ findings: ["left"] }),
      right: success({ findings: ["right"] }),
      merge: success({ report: "must not run" })
    });
    const scheduler = new StaticGraphScheduler({ ledger, adapters: new Map([["fake", fake]]) });

    const summary = await scheduler.resume("run-recovery-attempt-limit");

    expect(summary.verdict).toBe("BLOCK");
    expect(summary.state).toBe("BLOCKED");
    expect(fake.calls).toHaveLength(0);
    expect(ledger.getRun("run-recovery-attempt-limit").state).toBe("BLOCKED");
  });

  it("cannot aggregate PASS while required coverage is incomplete", () => {
    const { ledger } = createLedger();
    const graph = validateGraph(validDiamondGraph(), { allowedAdapters: new Set(["fake"]) });
    ledger.createRun(graph, "run-incomplete");

    const assessment = calculateGraphVerdict(graph.definition, ledger.listNodes("run-incomplete"));

    expect(assessment.verdict).toBe("PARTIAL");
    expect(assessment.requiredCoverage).toBe(0);
    expect(assessment.incompleteRequiredNodeIds).toEqual(["seed", "left", "right", "merge"]);
  });

  it.each([
    ["FAIL", "FAIL"],
    ["PARTIAL", "PARTIAL"]
  ] as const)("applies requiredFailure=%s to a failed required node", (policy, expected) => {
    const definition = validDiamondGraph();
    definition.verdictPolicy.requiredFailure = policy;
    const nodes = definition.nodes.map((node) => ({
      nodeId: node.id,
      required: node.required,
      state: node.id === "seed" ? ("FAILED" as const) : ("SUCCEEDED" as const)
    }));

    expect(calculateGraphVerdict(definition, nodes).verdict).toBe(expected);
  });

  it("keeps PASS when optionalFailure=IGNORE and only an optional node fails", () => {
    const definition = validDiamondGraph();
    definition.nodes.find((node) => node.id === "left")!.required = false;
    definition.verdictPolicy.optionalFailure = "IGNORE";
    definition.acceptanceTests[0]!.nodeIds = ["merge"];
    const nodes = definition.nodes.map((node) => ({
      nodeId: node.id,
      required: node.required,
      state: node.id === "left" ? ("FAILED" as const) : ("SUCCEEDED" as const)
    }));

    expect(calculateGraphVerdict(definition, nodes)).toEqual(
      expect.objectContaining({ verdict: "PASS", failedOptionalNodeIds: ["left"] })
    );
  });

  it("returns PARTIAL when a required acceptance test references a failed optional node", () => {
    const definition = validDiamondGraph();
    definition.nodes.find((node) => node.id === "left")!.required = false;
    definition.verdictPolicy.optionalFailure = "IGNORE";
    definition.acceptanceTests[0]!.nodeIds = ["left"];
    const nodes = definition.nodes.map((node) => ({
      nodeId: node.id,
      required: node.required,
      state: node.id === "left" ? ("FAILED" as const) : ("SUCCEEDED" as const)
    }));

    expect(calculateGraphVerdict(definition, nodes)).toEqual(
      expect.objectContaining({ verdict: "PARTIAL", failedAcceptanceTestIds: ["report-produced"] })
    );
  });
});
