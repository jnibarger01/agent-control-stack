import { DatabaseSync } from "node:sqlite";
import { ControlStackError } from "@agent-control-stack/shared";
import { GRAPH_SCHEMA_VERSION, type GraphEdge, type GraphEdgeType, type GraphNode, type GraphNodeType } from "./schema.js";
import { assertWellFormedEdgeEndpoints, validateGraphEdge, validateGraphNode } from "./validator.js";

/**
 * A derived, query-only view over authoritative ACS records. GraphStore
 * intentionally exposes no method that grants, checks, or consumes
 * authorization -- there is no approve/authorize/lease/claim method here.
 * Every method either writes a fact already decided by an authoritative
 * store (upsertNode/upsertEdge, called only from projector.ts) or reads
 * facts already written. See docs/graph-foundation-v2.md.
 */
export interface GraphStore {
  upsertNode(node: GraphNode): void;
  upsertEdge(edge: GraphEdge): void;
  getNode(nodeId: string): GraphNode | undefined;
  getEdge(edgeId: string): GraphEdge | undefined;
  listNodesByType(nodeType: GraphNodeType): GraphNode[];
  listEdgesFrom(nodeId: string): GraphEdge[];
  listEdgesTo(nodeId: string): GraphEdge[];
  nodeCount(): number;
  edgeCount(): number;
  /**
   * Wipes every node and edge. Safe by construction: this store owns a
   * SQLite file wholly separate from the control-plane database, so
   * clearing or deleting it cannot touch work-item, policy, approval,
   * lease, or audit state. A full rebuild is: clear(), then re-run the
   * projector over the authoritative store.
   */
  clear(): void;
  close(): void;
}

interface GraphNodeRow {
  node_id: string;
  node_type: string;
  schema_version: number;
  source_record_id: string;
  source_record_hash: string;
  attributes_json: string;
  projected_at: string;
}

interface GraphEdgeRow {
  edge_id: string;
  edge_type: string;
  schema_version: number;
  from_node_id: string;
  to_node_id: string;
  projected_at: string;
}

export class SqliteGraphStore implements GraphStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.applyMigrations();
  }

  private applyMigrations(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS graph_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        schema_version INTEGER NOT NULL
      );
    `);
    const existing = this.db.prepare(`SELECT schema_version FROM graph_meta WHERE id = 1`).get() as
      | { schema_version: number }
      | undefined;
    if (existing) {
      if (existing.schema_version !== GRAPH_SCHEMA_VERSION) {
        throw new ControlStackError(
          "graph_schema_version_mismatch",
          `graph store schema version ${existing.schema_version} does not match package version ${GRAPH_SCHEMA_VERSION}; rebuild the graph store`
        );
      }
      return;
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS graph_nodes (
        node_id TEXT PRIMARY KEY,
        node_type TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        source_record_id TEXT NOT NULL,
        source_record_hash TEXT NOT NULL,
        attributes_json TEXT NOT NULL,
        projected_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_graph_nodes_type ON graph_nodes(node_type);

      CREATE TABLE IF NOT EXISTS graph_edges (
        edge_id TEXT PRIMARY KEY,
        edge_type TEXT NOT NULL,
        schema_version INTEGER NOT NULL,
        from_node_id TEXT NOT NULL REFERENCES graph_nodes(node_id),
        to_node_id TEXT NOT NULL REFERENCES graph_nodes(node_id),
        projected_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_graph_edges_from ON graph_edges(from_node_id);
      CREATE INDEX IF NOT EXISTS idx_graph_edges_to ON graph_edges(to_node_id);
    `);
    this.db.prepare(`INSERT INTO graph_meta (id, schema_version) VALUES (1, ?)`).run(GRAPH_SCHEMA_VERSION);
  }

  upsertNode(candidate: GraphNode): void {
    const node = validateGraphNode(candidate);
    this.db
      .prepare(
        `INSERT INTO graph_nodes (node_id, node_type, schema_version, source_record_id, source_record_hash, attributes_json, projected_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(node_id) DO UPDATE SET
           source_record_hash = excluded.source_record_hash,
           attributes_json = excluded.attributes_json,
           projected_at = excluded.projected_at`
      )
      .run(
        node.nodeId,
        node.nodeType,
        node.schemaVersion,
        node.sourceRecordId,
        node.sourceRecordHash,
        JSON.stringify(node.attributes),
        node.projectedAt
      );
  }

  upsertEdge(candidate: GraphEdge): void {
    const edge = validateGraphEdge(candidate);
    assertWellFormedEdgeEndpoints(edge);
    if (!this.getNode(edge.fromNodeId)) {
      throw new ControlStackError("graph_edge_dangling", `edge ${edge.edgeId} references unknown fromNodeId ${edge.fromNodeId}`);
    }
    if (!this.getNode(edge.toNodeId)) {
      throw new ControlStackError("graph_edge_dangling", `edge ${edge.edgeId} references unknown toNodeId ${edge.toNodeId}`);
    }
    this.db
      .prepare(
        `INSERT INTO graph_edges (edge_id, edge_type, schema_version, from_node_id, to_node_id, projected_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(edge_id) DO UPDATE SET projected_at = excluded.projected_at`
      )
      .run(edge.edgeId, edge.edgeType, edge.schemaVersion, edge.fromNodeId, edge.toNodeId, edge.projectedAt);
  }

  getNode(nodeId: string): GraphNode | undefined {
    const row = this.db.prepare(`SELECT * FROM graph_nodes WHERE node_id = ?`).get(nodeId) as
      | GraphNodeRow
      | undefined;
    return row ? rowToNode(row) : undefined;
  }

  getEdge(edgeId: string): GraphEdge | undefined {
    const row = this.db.prepare(`SELECT * FROM graph_edges WHERE edge_id = ?`).get(edgeId) as
      | GraphEdgeRow
      | undefined;
    return row ? rowToEdge(row) : undefined;
  }

  listNodesByType(nodeType: GraphNodeType): GraphNode[] {
    const rows = this.db.prepare(`SELECT * FROM graph_nodes WHERE node_type = ? ORDER BY node_id`).all(
      nodeType
    ) as unknown as GraphNodeRow[];
    return rows.map(rowToNode);
  }

  listEdgesFrom(nodeId: string): GraphEdge[] {
    const rows = this.db.prepare(`SELECT * FROM graph_edges WHERE from_node_id = ? ORDER BY edge_id`).all(
      nodeId
    ) as unknown as GraphEdgeRow[];
    return rows.map(rowToEdge);
  }

  listEdgesTo(nodeId: string): GraphEdge[] {
    const rows = this.db.prepare(`SELECT * FROM graph_edges WHERE to_node_id = ? ORDER BY edge_id`).all(
      nodeId
    ) as unknown as GraphEdgeRow[];
    return rows.map(rowToEdge);
  }

  nodeCount(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM graph_nodes`).get() as { n: number }).n;
  }

  edgeCount(): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM graph_edges`).get() as { n: number }).n;
  }

  clear(): void {
    this.db.exec("DELETE FROM graph_edges; DELETE FROM graph_nodes;");
  }

  close(): void {
    this.db.close();
  }
}

function rowToNode(row: GraphNodeRow): GraphNode {
  return validateGraphNode({
    schemaVersion: row.schema_version,
    nodeId: row.node_id,
    nodeType: row.node_type,
    sourceRecordId: row.source_record_id,
    sourceRecordHash: row.source_record_hash,
    attributes: JSON.parse(row.attributes_json) as Record<string, string | number | boolean | null>,
    projectedAt: row.projected_at
  });
}

function rowToEdge(row: GraphEdgeRow): GraphEdge {
  return validateGraphEdge({
    schemaVersion: row.schema_version,
    edgeId: row.edge_id,
    edgeType: row.edge_type as GraphEdgeType,
    fromNodeId: row.from_node_id,
    toNodeId: row.to_node_id,
    projectedAt: row.projected_at
  });
}
