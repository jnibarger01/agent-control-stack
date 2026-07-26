import { ControlStackError } from "@agent-control-stack/shared";
import { describe, expect, it } from "vitest";
import { GRAPH_SCHEMA_VERSION, graphEdgeId, graphNodeId } from "./schema.js";
import { assertWellFormedEdgeEndpoints, validateGraphEdge, validateGraphNode } from "./validator.js";

function validNode(nodeType = "work_item", sourceRecordId = "wrk_1") {
  return {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    nodeId: graphNodeId(nodeType as never, sourceRecordId),
    nodeType,
    sourceRecordId,
    sourceRecordHash: "a".repeat(64),
    attributes: {},
    projectedAt: new Date().toISOString()
  };
}

describe("validateGraphNode / validateGraphEdge", () => {
  it("returns the parsed node for valid input", () => {
    expect(validateGraphNode(validNode())).toMatchObject({ nodeType: "work_item" });
  });

  it("throws a ControlStackError, not a raw ZodError, for invalid input", () => {
    expect(() => validateGraphNode({ ...validNode(), nodeType: "not-a-real-type" })).toThrow(ControlStackError);
  });

  it("rejects an edge whose endpoints are not graph-generated node ids", () => {
    const edge = {
      schemaVersion: GRAPH_SCHEMA_VERSION,
      edgeId: "edge:has_execution_plan:x->y",
      edgeType: "has_execution_plan",
      fromNodeId: "wrk_1",
      toNodeId: "plan_1",
      projectedAt: new Date().toISOString()
    };
    const parsed = validateGraphEdge(edge);
    expect(() => assertWellFormedEdgeEndpoints(parsed)).toThrow(ControlStackError);
  });

  it("rejects a self-loop edge", () => {
    const nodeId = graphNodeId("work_item", "wrk_1");
    const edge = validateGraphEdge({
      schemaVersion: GRAPH_SCHEMA_VERSION,
      edgeId: graphEdgeId("has_execution_plan", nodeId, nodeId),
      edgeType: "has_execution_plan",
      fromNodeId: nodeId,
      toNodeId: nodeId,
      projectedAt: new Date().toISOString()
    });
    expect(() => assertWellFormedEdgeEndpoints(edge)).toThrow(ControlStackError);
  });

  it("accepts a well-formed edge between two distinct graph-generated node ids", () => {
    const from = graphNodeId("work_item", "wrk_1");
    const to = graphNodeId("execution_plan", "plan_1");
    const edge = validateGraphEdge({
      schemaVersion: GRAPH_SCHEMA_VERSION,
      edgeId: graphEdgeId("has_execution_plan", from, to),
      edgeType: "has_execution_plan",
      fromNodeId: from,
      toNodeId: to,
      projectedAt: new Date().toISOString()
    });
    expect(() => assertWellFormedEdgeEndpoints(edge)).not.toThrow();
  });
});
