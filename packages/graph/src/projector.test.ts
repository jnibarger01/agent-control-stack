import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultExecutionPlanForWorkItem, SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { afterEach, describe, expect, it } from "vitest";
import { isProjectionStale, projectCommandAuthoritySubgraph, projectWorkItemSubgraph, writeGraphView } from "./projector.js";
import { SqliteGraphStore } from "./store.js";

function hex(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}

function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), "acs-graph-projector-"));
  const store = new SqliteWorkItemStore(join(directory, "control.db"));
  const graphStore = new SqliteGraphStore(join(directory, "graph.db"));
  const workItem = store.create({
    title: "Graph projector fixture",
    requester: "user",
    requesterSubject: "actor-user",
    intent: "prove graph projection is derived, not authoritative",
    target: { cwd: "/repo", files: ["src/index.ts"] },
    requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: ["src/index.ts"], write: false } }],
    risk: "low"
  });
  const definition = defaultExecutionPlanForWorkItem(workItem);
  const plan = store.createExecutionPlan({ workItemId: workItem.id, definition, createdByActorId: "actor-user" });
  const admission = store.admitExecutionPlan(
    {
      workItemId: workItem.id,
      planHash: plan.planHash,
      policyVersion: "acs.policy.v1",
      policyDecisionHash: hex("1"),
      requiresApproval: false,
      admittedByActorId: "policy-gate"
    },
    { via: "policy_gate" }
  );
  return { directory, store, graphStore, workItem, plan, admission };
}

describe("projectWorkItemSubgraph", () => {
  let directory: string | undefined;

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("projects a work item and its execution plan with a referentially valid edge", () => {
    const fixture = createFixture();
    directory = fixture.directory;

    const view = projectWorkItemSubgraph(fixture.store, fixture.workItem.id, "2026-01-01T00:00:00.000Z");

    expect(view.nodes).toHaveLength(2);
    expect(view.nodes.map((n) => n.nodeType).sort()).toEqual(["execution_plan", "work_item"]);
    expect(view.edges).toHaveLength(1);
    expect(view.edges[0]?.edgeType).toBe("has_execution_plan");

    writeGraphView(fixture.graphStore, view);
    expect(fixture.graphStore.nodeCount()).toBe(2);
    expect(fixture.graphStore.edgeCount()).toBe(1);
  });

  it("re-projecting the same work item twice is idempotent (replay idempotency)", () => {
    const fixture = createFixture();
    directory = fixture.directory;

    const first = projectWorkItemSubgraph(fixture.store, fixture.workItem.id, "2026-01-01T00:00:00.000Z");
    writeGraphView(fixture.graphStore, first);
    const second = projectWorkItemSubgraph(fixture.store, fixture.workItem.id, "2026-01-01T00:05:00.000Z");
    writeGraphView(fixture.graphStore, second);

    expect(fixture.graphStore.nodeCount()).toBe(2);
    expect(fixture.graphStore.edgeCount()).toBe(1);
    expect(first.nodes.map((n) => n.nodeId).sort()).toEqual(second.nodes.map((n) => n.nodeId).sort());
    expect(first.edges.map((e) => e.edgeId).sort()).toEqual(second.edges.map((e) => e.edgeId).sort());
  });

  it("projects a retry lineage chain with both work items and a retried_as edge", () => {
    const fixture = createFixture();
    directory = fixture.directory;

    fixture.store.approveWorkItem(fixture.workItem.id, { via: "domain_service" });
    const claimed = fixture.store.claimNextApprovedWorkItem("worker-a");
    if (!claimed) throw new Error("expected to claim the fixture work item");
    fixture.store.submitWorkResult({
      workItemId: claimed.id,
      leaseId: claimed.leaseId,
      workerId: claimed.workerId,
      actionHash: claimed.actionHash,
      idempotencyKey: hex("result"),
      outcome: "succeeded",
      startedAt: claimed.startedAt,
      finishedAt: new Date(Date.parse(claimed.startedAt) + 10).toISOString(),
      exitCode: 0,
      summary: "fixture work item completed in dry-run",
      structuredOutput: { simulated: true },
      artifacts: [],
      simulationMetadata: { executionMode: "dry_run", simulated: true }
    });
    const retry = fixture.store.retryWorkItem(fixture.workItem.id, { actor: "actor-user", reason: "prove retry lineage projects" });

    const view = projectWorkItemSubgraph(fixture.store, retry.id, "2026-01-01T00:00:00.000Z");
    const workItemNodeIds = view.nodes.filter((n) => n.nodeType === "work_item").map((n) => n.sourceRecordId);
    expect(workItemNodeIds.sort()).toEqual([fixture.workItem.id, retry.id].sort());
    expect(view.edges.some((e) => e.edgeType === "retried_as")).toBe(true);

    writeGraphView(fixture.graphStore, view);
    expect(fixture.graphStore.nodeCount()).toBeGreaterThanOrEqual(2);
  });

  it("detects a stale projection when the source record changes after projection", () => {
    const fixture = createFixture();
    directory = fixture.directory;

    const view = projectWorkItemSubgraph(fixture.store, fixture.workItem.id, "2026-01-01T00:00:00.000Z");
    const workItemNode = view.nodes.find((n) => n.nodeType === "work_item")!;
    expect(isProjectionStale(workItemNode, fixture.store.get(fixture.workItem.id))).toBe(false);

    fixture.store.approveWorkItem(fixture.workItem.id, { via: "domain_service" });

    expect(isProjectionStale(workItemNode, fixture.store.get(fixture.workItem.id))).toBe(true);
  });
});

describe("projectCommandAuthoritySubgraph", () => {
  let directory: string | undefined;

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("projects work item, plan, attempt, lease, and workspace allocation from one command-authority lookup", () => {
    const fixture = createFixture();
    directory = fixture.directory;

    const attempt = fixture.store.createAttempt(
      { workItemId: fixture.workItem.id, planHash: fixture.plan.planHash, inputHash: hex("a") },
      { via: "domain_service" }
    );
    const lease = fixture.store.leaseAttempt(
      {
        attemptId: attempt.attemptId,
        workItemId: fixture.workItem.id,
        admissionId: fixture.admission.admissionId,
        workerId: "worker-1",
        leaseToken: "a".repeat(32),
        policyVersion: "acs.policy.v1",
        policyDecisionHash: hex("1"),
        ttlMs: 60_000
      },
      { via: "domain_service" }
    );
    const allocation = fixture.store.recordWorkspaceAllocation(
      { allocationId: "workspace_1", workItemId: fixture.workItem.id, hostPath: "/repo/wrk_1", branch: "acs/job/wrk_1", baseRef: "main" },
      { via: "domain_service" }
    );

    const view = projectCommandAuthoritySubgraph(
      fixture.store,
      {
        workItemId: fixture.workItem.id,
        attemptId: attempt.attemptId,
        leaseId: lease.leaseId,
        workerId: "worker-1",
        fencingToken: 1,
        workspaceAllocationId: allocation.allocationId
      },
      "2026-01-01T00:00:00.000Z"
    );

    expect(view.nodes.map((n) => n.nodeType).sort()).toEqual(
      ["attempt", "attempt_lease", "execution_plan", "work_item", "workspace_allocation"].sort()
    );
    writeGraphView(fixture.graphStore, view);
    expect(fixture.graphStore.nodeCount()).toBe(5);
    expect(fixture.graphStore.edgeCount()).toBe(4);
  });

  it("throws rather than fabricating a projection when no command authority is persisted", () => {
    const fixture = createFixture();
    directory = fixture.directory;

    expect(() =>
      projectCommandAuthoritySubgraph(fixture.store, {
        workItemId: fixture.workItem.id,
        attemptId: "attempt_does_not_exist",
        leaseId: "lease_does_not_exist",
        workerId: "worker-1",
        fencingToken: 1,
        workspaceAllocationId: "workspace_does_not_exist"
      })
    ).toThrow();
  });
});
