import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { stableHash } from "@agent-control-stack/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  GraphBudgetAdmissionError,
  GraphLedgerInvariantError,
  GraphLedgerSchemaVersionError,
  GraphSchedulerLeaseError,
  SqliteGraphLedger,
  migrateGraphLedger,
  validateGraph,
  type NodeExecutionResult,
  type RunLeaseToken
} from "./index.js";
import { validDiamondGraph } from "./test-fixtures.js";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tempDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "acs-graph-ledger-"));
  tempDirectories.push(directory);
  return join(directory, "graph.db");
}

const successfulSeedResult = {
  status: "SUCCEEDED" as const,
  output: { items: ["a", "b"] },
  evidence: [
    {
      kind: "fixture",
      uri: "fixture://seed",
      sha256: "a".repeat(64)
    }
  ],
  assumptions: [],
  confidence: 1,
  unresolved: [],
  retryable: false,
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    durationMs: 1
  }
};

function claim(ledger: SqliteGraphLedger, runId: string): RunLeaseToken {
  const { lease } = ledger.acquireSchedulerLease(runId, "test-owner", 60_000);
  return { runId, ownerId: lease.ownerId, epoch: lease.leaseEpoch };
}

describe("SQLite graph execution ledger", () => {
  it("durably records run, node, attempt, hashes, and every state transition", () => {
    const databasePath = tempDatabasePath();
    const graph = validateGraph(validDiamondGraph(), { allowedAdapters: new Set(["fake"]) });
    const ledger = new SqliteGraphLedger(databasePath);

    ledger.createRun(graph, "run-ledger");
    const lease = claim(ledger, "run-ledger");
    ledger.transitionRun(lease, "RUNNING", "scheduler started");
    ledger.transitionNode(lease, "seed", "READY", "dependencies satisfied");
    const attempt = ledger.startAttempt(lease, "seed");
    ledger.completeAttempt({
      lease,
      nodeId: "seed",
      attemptId: attempt.attemptId,
      state: "SUCCEEDED",
      result: successfulSeedResult,
      outputHash: stableHash(successfulSeedResult.output)
    });
    ledger.close();

    const reopened = new SqliteGraphLedger(databasePath);
    const run = reopened.getRun("run-ledger");
    const seed = reopened.getNode("run-ledger", "seed");
    const attempts = reopened.listAttempts("run-ledger", "seed");
    const transitions = reopened.listTransitions("run-ledger");

    expect(run.graphHash).toBe(graph.graphHash);
    expect(run.state).toBe("RUNNING");
    expect(seed.state).toBe("SUCCEEDED");
    expect(seed.outputHash).toBe(stableHash(successfulSeedResult.output));
    expect(seed.result).toEqual(successfulSeedResult);
    expect(attempts).toEqual([
      expect.objectContaining({
        attemptId: attempt.attemptId,
        attemptNumber: 1,
        state: "SUCCEEDED",
        inputHash: attempt.inputHash,
        outputHash: stableHash(successfulSeedResult.output)
      })
    ]);
    expect(transitions.map((transition) => [transition.entityType, transition.nodeId, transition.toState])).toEqual([
      ["RUN", null, "PENDING"],
      ["NODE", "seed", "PENDING"],
      ["NODE", "left", "PENDING"],
      ["NODE", "right", "PENDING"],
      ["NODE", "merge", "PENDING"],
      ["RUN", null, "RUNNING"],
      ["NODE", "seed", "READY"],
      ["NODE", "seed", "RUNNING"],
      ["NODE", "seed", "SUCCEEDED"]
    ]);
    expect(reopened.verifyTransitionChain()).toEqual({ valid: true, checked: 9 });
    reopened.close();
  });

  it("applies the v1 migration idempotently and records schema_version = 1", () => {
    const databasePath = tempDatabasePath();

    expect(migrateGraphLedger(databasePath)).toEqual({ fromVersion: null, toVersion: 1, applied: true });
    expect(migrateGraphLedger(databasePath)).toEqual({ fromVersion: 1, toVersion: 1, applied: false });

    const raw = new DatabaseSync(databasePath);
    const metadata = raw
      .prepare("SELECT value FROM graph_ledger_meta WHERE key = 'schema_version'")
      .get() as unknown as { value: string };
    expect(metadata.value).toBe("1");
    raw.close();
  });

  it("binds attempt reservations to the budget admitted in the graph definition", () => {
    const databasePath = tempDatabasePath();
    const graphInput = validDiamondGraph();
    graphInput.limits.tokenCeiling = 5;
    graphInput.nodes[0]!.budget.maxTokens = 5;
    const graph = validateGraph(graphInput, { allowedAdapters: new Set(["fake"]) });
    const ledger = new SqliteGraphLedger(databasePath);
    ledger.createRun(graph, "run-admitted-budget");
    const lease = claim(ledger, "run-admitted-budget");
    ledger.transitionRun(lease, "RUNNING", "scheduler started");
    ledger.transitionNode(lease, "seed", "READY", "dependencies satisfied");

    expect(() => ledger.startAttempt(lease, "seed", undefined, { maxTokens: 0, maxCostUsd: 0, apiSlots: 0 })).toThrow(
      GraphLedgerInvariantError
    );
    expect(ledger.getNode("run-admitted-budget", "seed").state).toBe("READY");
    expect(ledger.getRunBudget("run-admitted-budget").reservedTokens).toBe(0);

    const admittedAttempt = ledger.startAttempt(lease, "seed");
    expect(admittedAttempt.attemptNumber).toBe(1);
    ledger.close();
  });

  it("derives and verifies attempt input hashes at the ledger boundary", () => {
    const databasePath = tempDatabasePath();
    const ledger = new SqliteGraphLedger(databasePath);
    const graph = validateGraph(validDiamondGraph(), { allowedAdapters: new Set(["fake"]) });
    ledger.createRun(graph, "run-input-hash-boundary");
    const lease = claim(ledger, "run-input-hash-boundary");
    ledger.transitionRun(lease, "RUNNING", "scheduler started");
    ledger.transitionNode(lease, "seed", "READY", "dependencies satisfied");

    expect(() => ledger.startAttempt(lease, "seed", "a".repeat(64))).toThrow(GraphLedgerInvariantError);
    expect(ledger.getNode("run-input-hash-boundary", "seed").state).toBe("READY");
    expect(ledger.listAttempts("run-input-hash-boundary", "seed")).toHaveLength(0);

    const attempt = ledger.startAttempt(lease, "seed");
    expect(attempt.inputHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(ledger.listAttempts("run-input-hash-boundary", "seed")[0]!.inputHash).toBe(attempt.inputHash);
    ledger.close();
  });

  it("fails and releases an attempt whose reported usage exceeds its reservation", () => {
    const databasePath = tempDatabasePath();
    const graphInput = validDiamondGraph();
    graphInput.limits.tokenCeiling = 10;
    graphInput.nodes[0]!.budget.maxTokens = 5;
    const graph = validateGraph(graphInput, { allowedAdapters: new Set(["fake"]) });
    const ledger = new SqliteGraphLedger(databasePath);
    ledger.createRun(graph, "run-over-budget-ledger");
    const lease = claim(ledger, "run-over-budget-ledger");
    ledger.transitionRun(lease, "RUNNING", "scheduler started");
    ledger.transitionNode(lease, "seed", "READY", "dependencies satisfied");
    const attempt = ledger.startAttempt(lease, "seed");
    const overBudget = structuredClone(successfulSeedResult);
    overBudget.usage.inputTokens = 6;

    expect(
      ledger.completeAttempt({
        lease,
        nodeId: "seed",
        attemptId: attempt.attemptId,
        state: "SUCCEEDED",
        result: overBudget,
        outputHash: stableHash(overBudget.output)
      })
    ).toBe(false);
    expect(ledger.getNode("run-over-budget-ledger", "seed")).toEqual(
      expect.objectContaining({
        state: "FAILED",
        result: null,
        error: expect.objectContaining({ code: "BUDGET_EXCEEDED" })
      })
    );
    expect(ledger.getRunBudget("run-over-budget-ledger")).toEqual(
      expect.objectContaining({ usedTokens: 0, reservedTokens: 0 })
    );
    expect(ledger.listBudgetReservations("run-over-budget-ledger")).toEqual([
      expect.objectContaining({ state: "RELEASED", actualTokens: null })
    ]);
    ledger.close();
  });

  it("rejects credential-bearing run and scheduler owner identifiers before persistence", () => {
    const ledger = new SqliteGraphLedger(tempDatabasePath());
    const graph = validateGraph(validDiamondGraph(), { allowedAdapters: new Set(["fake"]) });
    const credential = `sk-${"x".repeat(24)}`;

    expect(() => ledger.createRun(graph, credential)).toThrow(GraphLedgerInvariantError);
    ledger.createRun(graph, "run-safe-identifiers");
    expect(() => ledger.acquireSchedulerLease("run-safe-identifiers", credential, 60_000)).toThrow(
      GraphSchedulerLeaseError
    );
    ledger.close();
  });

  it("does not expose a public readiness path around approval or dependencies", () => {
    const databasePath = tempDatabasePath();
    const graphInput = validDiamondGraph();
    graphInput.nodes[0]!.approval_required = true;
    graphInput.nodes[0]!.approval = "HUMAN";
    const graph = validateGraph(graphInput, { allowedAdapters: new Set(["fake"]) });
    const ledger = new SqliteGraphLedger(databasePath);
    ledger.createRun(graph, "run-readiness-boundary");
    const lease = claim(ledger, "run-readiness-boundary");
    ledger.transitionRun(lease, "RUNNING", "scheduler started");

    expect(() => ledger.transitionNode(lease, "seed", "READY", "forged readiness")).toThrow(GraphLedgerInvariantError);
    expect(() => ledger.transitionNode(lease, "left", "READY", "forged dependency readiness")).toThrow(
      GraphLedgerInvariantError
    );
    expect(ledger.listNodes("run-readiness-boundary").map((node) => node.state)).toEqual([
      "PENDING",
      "PENDING",
      "PENDING",
      "PENDING"
    ]);
    ledger.close();
  });

  it("requires a running parent before node execution or terminal run settlement", () => {
    const ledger = new SqliteGraphLedger(tempDatabasePath());
    const graph = validateGraph(validDiamondGraph(), { allowedAdapters: new Set(["fake"]) });
    ledger.createRun(graph, "run-parent-state-boundary");
    const lease = claim(ledger, "run-parent-state-boundary");

    expect(() => ledger.transitionNode(lease, "seed", "READY", "forged readiness")).toThrow(GraphLedgerInvariantError);
    expect(() => ledger.startAttempt(lease, "seed")).toThrow(GraphLedgerInvariantError);
    expect(() =>
      ledger.transitionRun(lease, "SUCCEEDED", "forged terminal state", { verdict: "PASS", summary: {} })
    ).toThrow(GraphLedgerInvariantError);
    expect(() => ledger.transitionRun(lease, "CANCELLED", "forged cancellation")).toThrow(GraphLedgerInvariantError);
    expect(ledger.getRun("run-parent-state-boundary").state).toBe("PENDING");
    ledger.close();
  });

  it("enforces the admitted retry limit at the ledger attempt boundary", () => {
    const databasePath = tempDatabasePath();
    const graphInput = validDiamondGraph();
    graphInput.nodes[0]!.retry.maxAttempts = 1;
    graphInput.nodes[0]!.retry_policy.max_attempts = 1;
    const graph = validateGraph(graphInput, { allowedAdapters: new Set(["fake"]) });
    const ledger = new SqliteGraphLedger(databasePath);
    ledger.createRun(graph, "run-retry-limit-boundary");
    const lease = claim(ledger, "run-retry-limit-boundary");
    ledger.transitionRun(lease, "RUNNING", "scheduler started");
    ledger.transitionNode(lease, "seed", "READY", "dependencies satisfied");

    const raw = new DatabaseSync(databasePath);
    raw
      .prepare("UPDATE graph_nodes SET attempt_count = 1 WHERE run_id = ? AND node_id = 'seed'")
      .run("run-retry-limit-boundary");
    raw.close();

    expect(() => ledger.startAttempt(lease, "seed")).toThrow(GraphLedgerInvariantError);
    expect(ledger.getNode("run-retry-limit-boundary", "seed").state).toBe("READY");
    ledger.close();
  });

  it("rejects malformed or status-inconsistent results before ledger mutation", () => {
    const databasePath = tempDatabasePath();
    const ledger = new SqliteGraphLedger(databasePath);
    const graph = validateGraph(validDiamondGraph(), { allowedAdapters: new Set(["fake"]) });
    ledger.createRun(graph, "run-result-boundary");
    const lease = claim(ledger, "run-result-boundary");
    ledger.transitionRun(lease, "RUNNING", "scheduler started");
    ledger.transitionNode(lease, "seed", "READY", "dependencies satisfied");
    const attempt = ledger.startAttempt(lease, "seed");

    expect(() =>
      ledger.completeAttempt({
        lease,
        nodeId: "seed",
        attemptId: attempt.attemptId,
        state: "SUCCEEDED",
        result: { status: "FAILED" } as unknown as NodeExecutionResult
      })
    ).toThrow(GraphLedgerInvariantError);
    expect(ledger.getNode("run-result-boundary", "seed").state).toBe("RUNNING");
    expect(ledger.listAttempts("run-result-boundary", "seed")[0]!.state).toBe("RUNNING");
    expect(ledger.listBudgetReservations("run-result-boundary")[0]!.state).toBe("RESERVED");
    ledger.close();
  });

  it("fails closed on an unsupported ledger schema version", () => {
    const databasePath = tempDatabasePath();
    const raw = new DatabaseSync(databasePath);
    raw.exec("CREATE TABLE graph_ledger_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    raw.prepare("INSERT INTO graph_ledger_meta (key, value) VALUES ('schema_version', '99')").run();
    raw.close();

    expect(() => new SqliteGraphLedger(databasePath)).toThrowError(GraphLedgerSchemaVersionError);
    expect(() => migrateGraphLedger(databasePath)).toThrowError(GraphLedgerSchemaVersionError);
  });

  it("enforces persisted enum, counter, usage, budget, and legal-state constraints in SQLite", () => {
    const databasePath = tempDatabasePath();
    const ledger = new SqliteGraphLedger(databasePath);
    const graph = validateGraph(validDiamondGraph(), { allowedAdapters: new Set(["fake"]) });
    ledger.createRun(graph, "run-state-constraints");
    const lease = claim(ledger, "run-state-constraints");
    ledger.transitionRun(lease, "RUNNING", "scheduler started");
    ledger.transitionNode(lease, "seed", "READY", "dependencies satisfied");
    const attempt = ledger.startAttempt(lease, "seed");

    const raw = new DatabaseSync(databasePath);
    const mustReject = (sql: string): void => {
      expect(() => raw.prepare(sql).run()).toThrow();
    };
    mustReject("UPDATE graph_nodes SET state = 'NOT_A_STATE'");
    mustReject("UPDATE graph_nodes SET side_effect = 'MAYBE'");
    mustReject("UPDATE graph_nodes SET attempt_count = -1");
    mustReject("UPDATE graph_runs SET verdict = 'MAYBE'");
    mustReject("UPDATE graph_runs SET verdict = 'PASS' WHERE state = 'RUNNING'");
    mustReject("UPDATE graph_attempts SET attempt_number = 0");
    mustReject("UPDATE graph_attempts SET input_tokens = -1");
    mustReject("UPDATE graph_attempts SET state = 'SUCCEEDED' WHERE attempt_id = '" + attempt.attemptId + "'");
    mustReject(
      "UPDATE graph_attempts SET state = 'FAILED', finished_at = '2026-01-01T00:00:00.000Z' WHERE attempt_id = '" +
        attempt.attemptId +
        "'"
    );
    mustReject("UPDATE graph_run_budgets SET token_ceiling = -1");
    mustReject("UPDATE graph_run_budgets SET reserved_tokens = token_ceiling + 1");
    raw.close();
    expect(() =>
      ledger.completeAttempt({
        lease,
        nodeId: "seed",
        attemptId: attempt.attemptId,
        state: "FAILED"
      })
    ).toThrow(GraphLedgerInvariantError);
    ledger.close();
  });

  it("rejects an active second scheduler owner and safely recovers an expired owner", () => {
    const ledger = new SqliteGraphLedger(tempDatabasePath());
    const graph = validateGraph(validDiamondGraph(), { allowedAdapters: new Set(["fake"]) });
    ledger.createRun(graph, "run-lease");

    const admittedAt = new Date("2026-01-01T00:00:00.000Z");
    const first = ledger.acquireSchedulerLease("run-lease", "owner-a", 1_000, admittedAt);
    expect(first).toEqual({
      recovered: false,
      lease: expect.objectContaining({ ownerId: "owner-a", leaseEpoch: 1 })
    });
    expect(() =>
      ledger.acquireSchedulerLease("run-lease", "owner-b", 1_000, new Date("2026-01-01T00:00:00.500Z"))
    ).toThrow(GraphSchedulerLeaseError);

    const recovered = ledger.acquireSchedulerLease("run-lease", "owner-b", 1_000, new Date("2026-01-01T00:00:01.001Z"));
    expect(recovered).toEqual({
      recovered: true,
      lease: expect.objectContaining({ ownerId: "owner-b", leaseEpoch: 2 })
    });
    expect(() => ledger.assertSchedulerLease("run-lease", "owner-a", 1, new Date("2026-01-01T00:00:01.002Z"))).toThrow(
      GraphSchedulerLeaseError
    );
    expect(
      ledger.heartbeatSchedulerLease("run-lease", "owner-b", 2, 1_000, new Date("2026-01-01T00:00:01.500Z"))
    ).toEqual(expect.objectContaining({ ownerId: "owner-b", leaseEpoch: 2 }));
    ledger.close();
  });

  it("atomically rejects run mutation from a stale scheduler epoch", () => {
    const ledger = new SqliteGraphLedger(tempDatabasePath());
    const graph = validateGraph(validDiamondGraph(), { allowedAdapters: new Set(["fake"]) });
    ledger.createRun(graph, "run-fenced");
    const stale = ledger.acquireSchedulerLease(
      "run-fenced",
      "owner-stale",
      1_000,
      new Date("2000-01-01T00:00:00.000Z")
    ).lease;
    const current = ledger.acquireSchedulerLease("run-fenced", "owner-current", 60_000).lease;
    expect(stale.leaseEpoch).toBe(1);
    expect(current.leaseEpoch).toBe(2);
    const staleToken = { runId: "run-fenced", ownerId: stale.ownerId, epoch: stale.leaseEpoch };
    const currentToken = { runId: "run-fenced", ownerId: current.ownerId, epoch: current.leaseEpoch };
    const transitionCount = ledger.listTransitions("run-fenced").length;

    expect(() => ledger.transitionRun(staleToken, "RUNNING", "stale owner write")).toThrow(GraphSchedulerLeaseError);
    expect(ledger.getRun("run-fenced").state).toBe("PENDING");
    expect(ledger.listTransitions("run-fenced")).toHaveLength(transitionCount);

    ledger.transitionRun(currentToken, "RUNNING", "current owner write");
    expect(ledger.getRun("run-fenced").state).toBe("RUNNING");
    ledger.close();
  });

  it("rejects a late stale-owner result without settling its reservation", () => {
    const databasePath = tempDatabasePath();
    const ledger = new SqliteGraphLedger(databasePath);
    const graphInput = validDiamondGraph();
    graphInput.limits.tokenCeiling = 10;
    graphInput.nodes[0]!.budget.maxTokens = 5;
    graphInput.nodes[0]!.retry.maxAttempts = 2;
    graphInput.nodes[0]!.retry_policy.max_attempts = 2;
    const graph = validateGraph(graphInput, { allowedAdapters: new Set(["fake"]) });
    ledger.createRun(graph, "run-late-result");
    const ownerA = claim(ledger, "run-late-result");
    ledger.transitionRun(ownerA, "RUNNING", "owner A started");
    ledger.transitionNode(ownerA, "seed", "READY", "dependencies satisfied");
    const attemptA = ledger.startAttempt(ownerA, "seed", undefined, graphInput.nodes[0]!.budget);
    const budgetBefore = ledger.getRunBudget("run-late-result");

    const raw = new DatabaseSync(databasePath);
    raw
      .prepare("UPDATE graph_scheduler_leases SET acquired_at = ?, heartbeat_at = ?, expires_at = ? WHERE run_id = ?")
      .run("2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z", "2000-01-01T00:00:01.000Z", "run-late-result");
    raw.close();
    const recovered = ledger.acquireSchedulerLease("run-late-result", "owner-b", 60_000).lease;
    expect(recovered.leaseEpoch).toBe(2);
    const ownerB: RunLeaseToken = {
      runId: "run-late-result",
      ownerId: recovered.ownerId,
      epoch: recovered.leaseEpoch
    };

    expect(() =>
      ledger.completeAttempt({
        lease: ownerA,
        nodeId: "seed",
        attemptId: attemptA.attemptId,
        state: "SUCCEEDED",
        result: successfulSeedResult,
        outputHash: stableHash(successfulSeedResult.output)
      })
    ).toThrow(GraphSchedulerLeaseError);
    expect(() => ledger.transitionNode(ownerA, "seed", "BLOCKED", "stale failure propagation")).toThrow(
      GraphSchedulerLeaseError
    );
    expect(() => ledger.startAttempt(ownerA, "seed", undefined, graphInput.nodes[0]!.budget)).toThrow(
      GraphSchedulerLeaseError
    );
    expect(() => ledger.reconcileInterruptedNode(ownerA, "seed")).toThrow(GraphSchedulerLeaseError);
    expect(() => ledger.releaseSchedulerLease(ownerA)).toThrow(GraphSchedulerLeaseError);
    expect(ledger.getNode("run-late-result", "seed").state).toBe("RUNNING");
    expect(ledger.listAttempts("run-late-result", "seed")[0]!.state).toBe("RUNNING");
    expect(ledger.listBudgetReservations("run-late-result")[0]!.state).toBe("RESERVED");
    expect(ledger.getRunBudget("run-late-result")).toEqual(budgetBefore);

    expect(ledger.reconcileInterruptedNode(ownerB, "seed")).toBe("REQUEUED");
    const attemptB = ledger.startAttempt(ownerB, "seed", undefined, graphInput.nodes[0]!.budget);
    ledger.completeAttempt({
      lease: ownerB,
      nodeId: "seed",
      attemptId: attemptB.attemptId,
      state: "SUCCEEDED",
      result: successfulSeedResult,
      outputHash: stableHash(successfulSeedResult.output)
    });
    expect(ledger.getNode("run-late-result", "seed").state).toBe("SUCCEEDED");
    expect(ledger.listBudgetReservations("run-late-result").map((reservation) => reservation.state)).toEqual([
      "RELEASED",
      "SETTLED"
    ]);
    ledger.close();
  });

  it("enforces atomic budget admission across SQLite connections", () => {
    const databasePath = tempDatabasePath();
    const firstLedger = new SqliteGraphLedger(databasePath);
    const graphInput = validDiamondGraph();
    graphInput.limits.tokenCeiling = 5;
    graphInput.nodes[1]!.budget.maxTokens = 5;
    graphInput.nodes[2]!.budget.maxTokens = 5;
    const graph = validateGraph(graphInput, { allowedAdapters: new Set(["fake"]) });
    firstLedger.createRun(graph, "run-cross-connection-budget");
    const lease = claim(firstLedger, "run-cross-connection-budget");
    firstLedger.transitionRun(lease, "RUNNING", "scheduler started");
    firstLedger.transitionNode(lease, "seed", "READY", "fixture ready");
    const seedAttempt = firstLedger.startAttempt(lease, "seed");
    firstLedger.completeAttempt({
      lease,
      nodeId: "seed",
      attemptId: seedAttempt.attemptId,
      state: "SUCCEEDED",
      result: successfulSeedResult,
      outputHash: stableHash(successfulSeedResult.output)
    });
    firstLedger.transitionNode(lease, "left", "READY", "fixture ready");
    firstLedger.transitionNode(lease, "right", "READY", "fixture ready");
    const secondLedger = new SqliteGraphLedger(databasePath);
    const firstAttempt = firstLedger.startAttempt(lease, "left", undefined, graphInput.nodes[1]!.budget);
    expect(firstAttempt.attemptNumber).toBe(1);
    expect(() => secondLedger.startAttempt(lease, "right", undefined, graphInput.nodes[2]!.budget)).toThrow(
      GraphBudgetAdmissionError
    );
    expect(firstLedger.getRunBudget("run-cross-connection-budget")).toEqual(
      expect.objectContaining({ reservedTokens: 5 })
    );
    expect(
      firstLedger
        .listBudgetReservations("run-cross-connection-budget")
        .filter((reservation) => reservation.maxTokens === 5)
    ).toHaveLength(1);

    secondLedger.close();
    firstLedger.close();
  });

  it("detects transition-ledger tampering", () => {
    const databasePath = tempDatabasePath();
    const graph = validateGraph(validDiamondGraph(), { allowedAdapters: new Set(["fake"]) });
    const ledger = new SqliteGraphLedger(databasePath);
    ledger.createRun(graph, "run-tamper");
    ledger.close();

    const raw = new DatabaseSync(databasePath);
    raw.prepare("UPDATE graph_transitions SET reason = 'rewritten' WHERE sequence = 1").run();
    raw.close();

    const reopened = new SqliteGraphLedger(databasePath);
    expect(reopened.verifyTransitionChain()).toEqual({ valid: false, checked: 1 });
    expect(() => reopened.createRun(graph, "run-after-tamper")).toThrowError(GraphLedgerInvariantError);
    reopened.close();
  });
});
