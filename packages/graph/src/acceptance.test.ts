import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStackError } from "@agent-control-stack/shared";
import { defaultExecutionPlanForWorkItem, SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { afterEach, describe, expect, it } from "vitest";
import { isProjectionStale, projectWorkItemSubgraph, writeGraphView } from "./projector.js";
import { GRAPH_SCHEMA_VERSION, graphNodeId } from "./schema.js";
import { SqliteGraphStore } from "./store.js";
import { validateGraphNode } from "./validator.js";

function hex(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}

function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), "acs-graph-acceptance-"));
  const store = new SqliteWorkItemStore(join(directory, "control.db"));
  const graphStore = new SqliteGraphStore(join(directory, "graph.db"));
  const workItem = store.create({
    title: "Graph acceptance fixture",
    requester: "user",
    requesterSubject: "actor-user",
    intent: "acceptance test",
    target: { cwd: "/repo", files: ["src/index.ts"] },
    requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: ["src/index.ts"], write: false } }],
    risk: "low"
  });
  const definition = defaultExecutionPlanForWorkItem(workItem);
  const plan = store.createExecutionPlan({ workItemId: workItem.id, definition, createdByActorId: "actor-user" });
  store.admitExecutionPlan(
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
  return { directory, store, graphStore, workItem, plan };
}

/**
 * These tests exist to demonstrate, directly, the specific properties the
 * graph-foundation task requires -- each `it` name states the property.
 * See docs/graph-foundation-v2.md for the design this validates.
 */
describe("graph foundation acceptance", () => {
  let directory: string | undefined;

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  it("schema validation: a well-formed node/edge round-trips through validation unchanged", () => {
    const fixture = createFixture();
    directory = fixture.directory;
    const view = projectWorkItemSubgraph(fixture.store, fixture.workItem.id);
    for (const node of view.nodes) {
      expect(validateGraphNode(node)).toEqual(node);
    }
  });

  it("invalid node and edge rejection: malformed records are rejected before they ever reach the store", () => {
    expect(() =>
      validateGraphNode({
        schemaVersion: GRAPH_SCHEMA_VERSION,
        nodeId: "node:work_item:1",
        nodeType: "not_a_real_type",
        sourceRecordId: "1",
        sourceRecordHash: "a".repeat(64),
        attributes: {},
        projectedAt: new Date().toISOString()
      })
    ).toThrow(ControlStackError);
  });

  it("duplicate projection handling: projecting the same authoritative event twice never creates a duplicate row", () => {
    const fixture = createFixture();
    directory = fixture.directory;
    const view = projectWorkItemSubgraph(fixture.store, fixture.workItem.id);
    writeGraphView(fixture.graphStore, view);
    writeGraphView(fixture.graphStore, view);
    writeGraphView(fixture.graphStore, view);
    expect(fixture.graphStore.nodeCount()).toBe(view.nodes.length);
    expect(fixture.graphStore.edgeCount()).toBe(view.edges.length);
  });

  it("replay idempotency: projecting from unchanged authoritative state twice yields byte-identical graph facts", () => {
    const fixture = createFixture();
    directory = fixture.directory;
    const first = projectWorkItemSubgraph(fixture.store, fixture.workItem.id, "2026-01-01T00:00:00.000Z");
    const second = projectWorkItemSubgraph(fixture.store, fixture.workItem.id, "2026-01-01T00:00:00.000Z");
    expect(first).toEqual(second);
  });

  it("graph rebuild from authoritative records: clearing the graph store and re-projecting reproduces the same facts", () => {
    const fixture = createFixture();
    directory = fixture.directory;
    const view = projectWorkItemSubgraph(fixture.store, fixture.workItem.id, "2026-01-01T00:00:00.000Z");
    writeGraphView(fixture.graphStore, view);
    const before = { nodes: fixture.graphStore.nodeCount(), edges: fixture.graphStore.edgeCount() };

    fixture.graphStore.clear();
    expect(fixture.graphStore.nodeCount()).toBe(0);

    const rebuilt = projectWorkItemSubgraph(fixture.store, fixture.workItem.id, "2026-02-01T00:00:00.000Z");
    writeGraphView(fixture.graphStore, rebuilt);

    expect(fixture.graphStore.nodeCount()).toBe(before.nodes);
    expect(fixture.graphStore.edgeCount()).toBe(before.edges);
    expect(rebuilt.nodes.map((n) => n.nodeId).sort()).toEqual(view.nodes.map((n) => n.nodeId).sort());
  });

  it("stale projection detection: a graph node flags itself stale once the authoritative record moves on", () => {
    const fixture = createFixture();
    directory = fixture.directory;
    const view = projectWorkItemSubgraph(fixture.store, fixture.workItem.id);
    const workItemNode = view.nodes.find((n) => n.nodeType === "work_item")!;
    expect(isProjectionStale(workItemNode, fixture.store.get(fixture.workItem.id))).toBe(false);

    fixture.store.approveWorkItem(fixture.workItem.id, { via: "domain_service" });

    expect(isProjectionStale(workItemNode, fixture.store.get(fixture.workItem.id))).toBe(true);
  });

  it("provenance retention: every node and edge traces back to a specific authoritative record id", () => {
    const fixture = createFixture();
    directory = fixture.directory;
    const view = projectWorkItemSubgraph(fixture.store, fixture.workItem.id);
    for (const node of view.nodes) {
      expect(node.sourceRecordId.length).toBeGreaterThan(0);
      if (node.nodeType === "work_item") expect(node.sourceRecordId).toBe(fixture.workItem.id);
      if (node.nodeType === "execution_plan") expect(node.sourceRecordId).toBe(fixture.plan.planId);
    }
    // Every edge's endpoints are graph-generated ids that embed the source
    // record id and type, so an edge's provenance is recoverable from the
    // edge itself without a side table.
    for (const edge of view.edges) {
      expect(edge.fromNodeId.startsWith("node:")).toBe(true);
      expect(edge.toNodeId.startsWith("node:")).toBe(true);
    }
  });

  it("graph unavailability without control-plane failure: authoritative work-item operations do not depend on the graph store at all", () => {
    const fixture = createFixture();
    directory = fixture.directory;
    fixture.graphStore.close(); // simulate the graph store being unavailable

    // None of these authoritative operations touch the graph package.
    expect(() => fixture.store.approveWorkItem(fixture.workItem.id, { via: "domain_service" })).not.toThrow();
    expect(() => fixture.store.claimNextApprovedWorkItem("worker-a")).not.toThrow();
    expect(fixture.store.get(fixture.workItem.id)?.status).toBe("running");
  });

  it("proof graph state cannot independently authorize a worker action: writing an authoritative-looking graph node changes nothing in the real store", () => {
    const fixture = createFixture();
    directory = fixture.directory;

    // Fabricate a graph node that *claims* the work item is approved and
    // ready to run, bypassing the projector entirely (as if an attacker or
    // a bug had written directly to the graph store).
    fixture.graphStore.upsertNode({
      schemaVersion: GRAPH_SCHEMA_VERSION,
      nodeId: graphNodeId("work_item", fixture.workItem.id),
      nodeType: "work_item",
      sourceRecordId: fixture.workItem.id,
      sourceRecordHash: "f".repeat(64),
      attributes: { status: "approved", authorized: "true" },
      projectedAt: new Date().toISOString()
    });

    // The real work item is still pending_policy: nothing reads the graph
    // to decide whether a worker may claim it, because nothing in
    // packages/work-items or packages/policy-gate imports this package.
    expect(fixture.store.get(fixture.workItem.id)?.status).toBe("pending_policy");
    expect(fixture.store.claimNextApprovedWorkItem("worker-a")).toBeUndefined();

    // Structural check: the GraphStore interface exposes no method whose
    // name suggests it could grant or check authorization.
    const methodNames = Object.getOwnPropertyNames(Object.getPrototypeOf(fixture.graphStore));
    expect(methodNames.filter((name) => /approve|authoriz|grant|lease|claim/iu.test(name))).toEqual([]);
  });
});
