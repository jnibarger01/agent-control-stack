import { ControlStackError } from "@agent-control-stack/shared";
import { graphEdgeSchema, graphNodeSchema, type GraphEdge, type GraphNode } from "./schema.js";

/**
 * Fail closed: an unrecognized node type, a missing provenance field, or an
 * extra field the strict schema doesn't declare all throw rather than being
 * coerced or silently dropped.
 */
export function validateGraphNode(candidate: unknown): GraphNode {
  const result = graphNodeSchema.safeParse(candidate);
  if (!result.success) {
    throw new ControlStackError("graph_node_invalid", `graph node failed validation: ${result.error.message}`);
  }
  return result.data;
}

export function validateGraphEdge(candidate: unknown): GraphEdge {
  const result = graphEdgeSchema.safeParse(candidate);
  if (!result.success) {
    throw new ControlStackError("graph_edge_invalid", `graph edge failed validation: ${result.error.message}`);
  }
  return result.data;
}

/**
 * Structural self-consistency an edge must have before it is even worth
 * asking the store to check referential integrity: it must not be a
 * self-loop with an edge type that only makes sense between two distinct
 * records, and its node ids must look like node ids this package would
 * actually generate (see graphNodeId in schema.ts) rather than an
 * arbitrary caller-supplied string.
 */
const NODE_ID_PATTERN = /^node:[a-z_]+:.+$/u;

export function assertWellFormedEdgeEndpoints(edge: GraphEdge): void {
  if (!NODE_ID_PATTERN.test(edge.fromNodeId) || !NODE_ID_PATTERN.test(edge.toNodeId)) {
    throw new ControlStackError("graph_edge_invalid", "edge endpoints must be graph-generated node ids");
  }
  if (edge.fromNodeId === edge.toNodeId) {
    throw new ControlStackError("graph_edge_invalid", "edge endpoints must reference two distinct nodes");
  }
}
