import { describe, expect, it } from "vitest";
import { graphEdgeId, graphNodeId, graphEdgeSchema, graphNodeSchema, GRAPH_SCHEMA_VERSION } from "./schema.js";

describe("graph schema", () => {
  it("accepts a well-formed node", () => {
    const node = {
      schemaVersion: GRAPH_SCHEMA_VERSION,
      nodeId: graphNodeId("work_item", "wrk_1"),
      nodeType: "work_item",
      sourceRecordId: "wrk_1",
      sourceRecordHash: "a".repeat(64),
      attributes: { status: "approved", risk: "low", touchedAt: null },
      projectedAt: new Date().toISOString()
    };
    expect(() => graphNodeSchema.parse(node)).not.toThrow();
  });

  it("rejects an unknown node type", () => {
    const node = {
      schemaVersion: GRAPH_SCHEMA_VERSION,
      nodeId: "node:mystery:1",
      nodeType: "mystery",
      sourceRecordId: "1",
      sourceRecordHash: "a".repeat(64),
      attributes: {},
      projectedAt: new Date().toISOString()
    };
    expect(() => graphNodeSchema.parse(node)).toThrow();
  });

  it("rejects a node missing provenance (sourceRecordId)", () => {
    const node = {
      schemaVersion: GRAPH_SCHEMA_VERSION,
      nodeId: "node:work_item:1",
      nodeType: "work_item",
      sourceRecordHash: "a".repeat(64),
      attributes: {},
      projectedAt: new Date().toISOString()
    };
    expect(() => graphNodeSchema.parse(node)).toThrow();
  });

  it("rejects a node with an extra, undeclared field", () => {
    const node = {
      schemaVersion: GRAPH_SCHEMA_VERSION,
      nodeId: "node:work_item:1",
      nodeType: "work_item",
      sourceRecordId: "1",
      sourceRecordHash: "a".repeat(64),
      attributes: {},
      projectedAt: new Date().toISOString(),
      approved: true
    };
    expect(() => graphNodeSchema.parse(node)).toThrow();
  });

  it("rejects a malformed sourceRecordHash", () => {
    const node = {
      schemaVersion: GRAPH_SCHEMA_VERSION,
      nodeId: "node:work_item:1",
      nodeType: "work_item",
      sourceRecordId: "1",
      sourceRecordHash: "not-a-hash",
      attributes: {},
      projectedAt: new Date().toISOString()
    };
    expect(() => graphNodeSchema.parse(node)).toThrow();
  });

  it("accepts a well-formed edge and rejects an unknown edge type", () => {
    const from = graphNodeId("work_item", "wrk_1");
    const to = graphNodeId("execution_plan", "plan_1");
    const edge = {
      schemaVersion: GRAPH_SCHEMA_VERSION,
      edgeId: graphEdgeId("has_execution_plan", from, to),
      edgeType: "has_execution_plan",
      fromNodeId: from,
      toNodeId: to,
      projectedAt: new Date().toISOString()
    };
    expect(() => graphEdgeSchema.parse(edge)).not.toThrow();
    expect(() => graphEdgeSchema.parse({ ...edge, edgeType: "authorizes" })).toThrow();
  });

  it("produces deterministic node and edge ids for the same source record", () => {
    expect(graphNodeId("work_item", "wrk_1")).toBe(graphNodeId("work_item", "wrk_1"));
    expect(graphNodeId("work_item", "wrk_1")).not.toBe(graphNodeId("execution_plan", "wrk_1"));
    const from = graphNodeId("work_item", "wrk_1");
    const to = graphNodeId("execution_plan", "plan_1");
    expect(graphEdgeId("has_execution_plan", from, to)).toBe(graphEdgeId("has_execution_plan", from, to));
  });
});
