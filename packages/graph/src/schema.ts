import { z } from "zod";

/**
 * Schema version for the graph's own node/edge record shape (not the
 * schema version of whatever authoritative record a node was projected
 * from). Bump this whenever graphNodeSchema/graphEdgeSchema change shape.
 */
export const GRAPH_SCHEMA_VERSION = 1;

const identifierSchema = z.string().min(1).max(256);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const timestampSchema = z.string().datetime({ offset: true }).max(64);

/**
 * Every node type here corresponds 1:1 to an authoritative record type in
 * packages/work-items. There is deliberately no node type for anything the
 * graph itself would have to originate (no "decision", "verdict", or
 * "lease-grant" node) -- see docs/graph-foundation-v2.md.
 */
export const graphNodeTypeSchema = z.enum([
  "work_item",
  "execution_plan",
  "attempt",
  "attempt_lease",
  "workspace_allocation"
]);

/**
 * Every edge type describes a relationship that already exists between two
 * authoritative records (a plan belongs to a work item, an attempt was
 * created against a plan, ...). No edge type expresses an authorization
 * decision (no "approved_for", no "authorized_to_run").
 */
export const graphEdgeTypeSchema = z.enum([
  "has_execution_plan",
  "has_attempt",
  "has_lease",
  "uses_workspace",
  "retried_as",
  "cloned_as"
]);

/**
 * A node's attributes are a minimal, structural projection of its source
 * record -- status/timing/identity fields useful for graph queries, never
 * free-text content (title, intent, result payloads) and never secret
 * material. Keeping this bounded avoids the graph becoming a second copy
 * of work-item content with its own staleness/leak surface.
 */
export const graphNodeAttributesSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));

export const graphNodeSchema = z
  .object({
    schemaVersion: z.literal(GRAPH_SCHEMA_VERSION),
    nodeId: identifierSchema,
    nodeType: graphNodeTypeSchema,
    /** The authoritative record's own identifier (e.g. a work item id). */
    sourceRecordId: identifierSchema,
    /**
     * stableHash() of the authoritative record at projection time. Used to
     * detect a stale projection: re-fetch the record, recompute this hash,
     * and compare -- see isProjectionStale in projector.ts.
     */
    sourceRecordHash: hashSchema,
    attributes: graphNodeAttributesSchema,
    projectedAt: timestampSchema
  })
  .strict();

export const graphEdgeSchema = z
  .object({
    schemaVersion: z.literal(GRAPH_SCHEMA_VERSION),
    edgeId: identifierSchema,
    edgeType: graphEdgeTypeSchema,
    fromNodeId: identifierSchema,
    toNodeId: identifierSchema,
    projectedAt: timestampSchema
  })
  .strict();

export type GraphNodeType = z.infer<typeof graphNodeTypeSchema>;
export type GraphEdgeType = z.infer<typeof graphEdgeTypeSchema>;
export type GraphNode = z.infer<typeof graphNodeSchema>;
export type GraphEdge = z.infer<typeof graphEdgeSchema>;

/** Deterministic node id: same source record always projects to the same node id. */
export function graphNodeId(nodeType: GraphNodeType, sourceRecordId: string): string {
  return `node:${nodeType}:${sourceRecordId}`;
}

/** Deterministic edge id: projecting the same relationship twice never creates a duplicate row. */
export function graphEdgeId(edgeType: GraphEdgeType, fromNodeId: string, toNodeId: string): string {
  return `edge:${edgeType}:${fromNodeId}->${toNodeId}`;
}
