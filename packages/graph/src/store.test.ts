import { ControlStackError } from "@agent-control-stack/shared";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { graphEdgeId, graphNodeId, GRAPH_SCHEMA_VERSION, type GraphEdge, type GraphNode } from "./schema.js";
import { SqliteGraphStore } from "./store.js";

function makeNode(nodeType: string, sourceRecordId: string, hash = "a".repeat(64)): GraphNode {
  return {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    nodeId: graphNodeId(nodeType as never, sourceRecordId),
    nodeType: nodeType as never,
    sourceRecordId,
    sourceRecordHash: hash,
    attributes: { touched: "true" },
    projectedAt: new Date().toISOString()
  };
}

function makeEdge(edgeType: string, from: string, to: string): GraphEdge {
  return {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    edgeId: graphEdgeId(edgeType as never, from, to),
    edgeType: edgeType as never,
    fromNodeId: from,
    toNodeId: to,
    projectedAt: new Date().toISOString()
  };
}

describe("SqliteGraphStore", () => {
  let directory: string | undefined;

  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
    directory = undefined;
  });

  function createStore(): SqliteGraphStore {
    directory = mkdtempSync(join(tmpdir(), "acs-graph-store-"));
    return new SqliteGraphStore(join(directory, "graph.db"));
  }

  it("persists and reads back a node", () => {
    const store = createStore();
    const node = makeNode("work_item", "wrk_1");
    store.upsertNode(node);
    expect(store.getNode(node.nodeId)).toEqual(node);
    store.close();
  });

  it("upserting the same node id twice updates in place rather than duplicating (duplicate projection handling)", () => {
    const store = createStore();
    const node = makeNode("work_item", "wrk_1", "a".repeat(64));
    store.upsertNode(node);
    store.upsertNode({ ...node, sourceRecordHash: "b".repeat(64) });
    expect(store.nodeCount()).toBe(1);
    expect(store.getNode(node.nodeId)?.sourceRecordHash).toBe("b".repeat(64));
    store.close();
  });

  it("rejects an edge that references a node not present in the store (invalid edge rejection)", () => {
    const store = createStore();
    const edge = makeEdge("has_execution_plan", graphNodeId("work_item", "wrk_1"), graphNodeId("execution_plan", "plan_1"));
    expect(() => store.upsertEdge(edge)).toThrow(ControlStackError);
    expect(store.edgeCount()).toBe(0);
    store.close();
  });

  it("accepts an edge once both endpoint nodes exist, and upserting it twice does not duplicate it", () => {
    const store = createStore();
    const workItemNode = makeNode("work_item", "wrk_1");
    const planNode = makeNode("execution_plan", "plan_1");
    store.upsertNode(workItemNode);
    store.upsertNode(planNode);
    const edge = makeEdge("has_execution_plan", workItemNode.nodeId, planNode.nodeId);
    store.upsertEdge(edge);
    store.upsertEdge(edge);
    expect(store.edgeCount()).toBe(1);
    expect(store.getEdge(edge.edgeId)).toEqual(edge);
    store.close();
  });

  it("lists edges by from/to node id", () => {
    const store = createStore();
    const workItemNode = makeNode("work_item", "wrk_1");
    const planNode = makeNode("execution_plan", "plan_1");
    store.upsertNode(workItemNode);
    store.upsertNode(planNode);
    const edge = makeEdge("has_execution_plan", workItemNode.nodeId, planNode.nodeId);
    store.upsertEdge(edge);
    expect(store.listEdgesFrom(workItemNode.nodeId)).toEqual([edge]);
    expect(store.listEdgesTo(planNode.nodeId)).toEqual([edge]);
    expect(store.listEdgesFrom(planNode.nodeId)).toEqual([]);
    store.close();
  });

  it("lists nodes by type", () => {
    const store = createStore();
    store.upsertNode(makeNode("work_item", "wrk_1"));
    store.upsertNode(makeNode("work_item", "wrk_2"));
    store.upsertNode(makeNode("execution_plan", "plan_1"));
    expect(store.listNodesByType("work_item")).toHaveLength(2);
    expect(store.listNodesByType("execution_plan")).toHaveLength(1);
    expect(store.listNodesByType("attempt")).toHaveLength(0);
    store.close();
  });

  it("clear() wipes all nodes and edges without throwing, and the store remains usable afterward", () => {
    const store = createStore();
    const workItemNode = makeNode("work_item", "wrk_1");
    const planNode = makeNode("execution_plan", "plan_1");
    store.upsertNode(workItemNode);
    store.upsertNode(planNode);
    store.upsertEdge(makeEdge("has_execution_plan", workItemNode.nodeId, planNode.nodeId));
    expect(store.nodeCount()).toBe(2);
    expect(store.edgeCount()).toBe(1);

    store.clear();

    expect(store.nodeCount()).toBe(0);
    expect(store.edgeCount()).toBe(0);
    store.upsertNode(workItemNode);
    expect(store.nodeCount()).toBe(1);
    store.close();
  });

  it("has no method resembling authorization, approval, or lease granting (structural non-authority proof)", () => {
    const store = createStore();
    const methodNames = Object.getOwnPropertyNames(Object.getPrototypeOf(store));
    const forbidden = /approve|authoriz|grant|lease|claim/iu;
    const suspicious = methodNames.filter((name) => forbidden.test(name));
    expect(suspicious).toEqual([]);
    store.close();
  });
});
