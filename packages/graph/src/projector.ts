import { ControlStackError, stableHash } from "@agent-control-stack/shared";
import type {
  CommandAuthority,
  ExecutionAttempt,
  ExecutionPlanRecord,
  WorkItem,
  WorkItemStore,
  WorkspaceAllocation
} from "@agent-control-stack/work-items";
import { GRAPH_SCHEMA_VERSION, graphEdgeId, graphNodeId, type GraphEdge, type GraphNode } from "./schema.js";

/**
 * Pure projection functions: given an authoritative record already read
 * from WorkItemStore, produce the graph node/edge that describes it. None
 * of these functions call the store, mutate anything, or make a decision --
 * they only reshape a record ACS already decided into a graph fact. See
 * docs/graph-foundation-v2.md for why this direction (authoritative record
 * -> graph fact, never the reverse) is the whole point of this package.
 */

export function projectWorkItemNode(workItem: WorkItem, projectedAt: string): GraphNode {
  return {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    nodeId: graphNodeId("work_item", workItem.id),
    nodeType: "work_item",
    sourceRecordId: workItem.id,
    sourceRecordHash: stableHash(workItem),
    attributes: {
      status: workItem.status,
      risk: workItem.risk,
      requester: workItem.requester,
      lineageType: workItem.lineageType ?? null,
      sourceWorkItemId: workItem.sourceWorkItemId ?? null,
      rootWorkItemId: workItem.rootWorkItemId ?? null,
      createdAt: workItem.createdAt,
      updatedAt: workItem.updatedAt
    },
    projectedAt
  };
}

export function projectExecutionPlanNode(plan: ExecutionPlanRecord, projectedAt: string): GraphNode {
  return {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    nodeId: graphNodeId("execution_plan", plan.planId),
    nodeType: "execution_plan",
    sourceRecordId: plan.planId,
    sourceRecordHash: stableHash(plan),
    attributes: {
      workItemId: plan.workItemId,
      planNumber: plan.planNumber,
      planHash: plan.planHash,
      createdAt: plan.createdAt
    },
    projectedAt
  };
}

export function projectAttemptNode(attempt: ExecutionAttempt, projectedAt: string): GraphNode {
  return {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    nodeId: graphNodeId("attempt", attempt.attemptId),
    nodeType: "attempt",
    sourceRecordId: attempt.attemptId,
    sourceRecordHash: stableHash(attempt),
    attributes: {
      workItemId: attempt.workItemId,
      planId: attempt.planId,
      attemptNumber: attempt.attemptNumber,
      status: attempt.status,
      claimedByWorkerId: attempt.claimedByWorkerId ?? null,
      createdAt: attempt.createdAt,
      updatedAt: attempt.updatedAt
    },
    projectedAt
  };
}

export function projectAttemptLeaseNode(lease: CommandAuthority["lease"], projectedAt: string): GraphNode {
  return {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    nodeId: graphNodeId("attempt_lease", lease.leaseId),
    nodeType: "attempt_lease",
    sourceRecordId: lease.leaseId,
    sourceRecordHash: stableHash(lease),
    attributes: {
      attemptId: lease.attemptId,
      workerId: lease.workerId,
      status: lease.status,
      issuedAt: lease.issuedAt,
      expiresAt: lease.expiresAt
    },
    projectedAt
  };
}

export function projectWorkspaceAllocationNode(allocation: WorkspaceAllocation, projectedAt: string): GraphNode {
  return {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    nodeId: graphNodeId("workspace_allocation", allocation.allocationId),
    nodeType: "workspace_allocation",
    sourceRecordId: allocation.allocationId,
    sourceRecordHash: stableHash(allocation),
    attributes: {
      workItemId: allocation.workItemId,
      branch: allocation.branch,
      baseRef: allocation.baseRef,
      status: allocation.status,
      createdAt: allocation.createdAt
    },
    projectedAt
  };
}

export function projectHasExecutionPlanEdge(workItem: WorkItem, plan: ExecutionPlanRecord, projectedAt: string): GraphEdge {
  const fromNodeId = graphNodeId("work_item", workItem.id);
  const toNodeId = graphNodeId("execution_plan", plan.planId);
  return {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    edgeId: graphEdgeId("has_execution_plan", fromNodeId, toNodeId),
    edgeType: "has_execution_plan",
    fromNodeId,
    toNodeId,
    projectedAt
  };
}

export function projectHasAttemptEdge(plan: ExecutionPlanRecord, attempt: ExecutionAttempt, projectedAt: string): GraphEdge {
  const fromNodeId = graphNodeId("execution_plan", plan.planId);
  const toNodeId = graphNodeId("attempt", attempt.attemptId);
  return {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    edgeId: graphEdgeId("has_attempt", fromNodeId, toNodeId),
    edgeType: "has_attempt",
    fromNodeId,
    toNodeId,
    projectedAt
  };
}

export function projectHasLeaseEdge(attempt: ExecutionAttempt, lease: CommandAuthority["lease"], projectedAt: string): GraphEdge {
  const fromNodeId = graphNodeId("attempt", attempt.attemptId);
  const toNodeId = graphNodeId("attempt_lease", lease.leaseId);
  return {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    edgeId: graphEdgeId("has_lease", fromNodeId, toNodeId),
    edgeType: "has_lease",
    fromNodeId,
    toNodeId,
    projectedAt
  };
}

export function projectUsesWorkspaceEdge(workItem: WorkItem, allocation: WorkspaceAllocation, projectedAt: string): GraphEdge {
  const fromNodeId = graphNodeId("work_item", workItem.id);
  const toNodeId = graphNodeId("workspace_allocation", allocation.allocationId);
  return {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    edgeId: graphEdgeId("uses_workspace", fromNodeId, toNodeId),
    edgeType: "uses_workspace",
    fromNodeId,
    toNodeId,
    projectedAt
  };
}

export function projectLineageEdge(workItem: WorkItem, projectedAt: string): GraphEdge | undefined {
  if (!workItem.sourceWorkItemId || !workItem.lineageType) return undefined;
  const fromNodeId = graphNodeId("work_item", workItem.sourceWorkItemId);
  const toNodeId = graphNodeId("work_item", workItem.id);
  const edgeType = workItem.lineageType === "retry" ? "retried_as" : "cloned_as";
  return {
    schemaVersion: GRAPH_SCHEMA_VERSION,
    edgeId: graphEdgeId(edgeType, fromNodeId, toNodeId),
    edgeType,
    fromNodeId,
    toNodeId,
    projectedAt
  };
}

export interface WorkItemGraphView {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/**
 * Reads a work item, its full retry/clone ancestor chain, its execution
 * plans, and its active workspace allocation from the authoritative store,
 * and returns the corresponding graph view. Every edge in the result
 * references a node also present in the result, so the view can be written
 * to a GraphStore in any order (write all nodes, then all edges) without
 * a dangling-reference error -- see writeWorkItemGraph below.
 *
 * Attempts and leases are deliberately not included here: WorkItemStore
 * has no "list attempts for a work item" read method (attempts are looked
 * up by id, or joined via getCommandAuthority once a caller already knows
 * the full claimed identity set), so they are projected separately via
 * projectCommandAuthoritySubgraph once an attempt id is known (e.g. from
 * an audit event).
 */
export function projectWorkItemSubgraph(
  store: WorkItemStore,
  workItemId: string,
  projectedAt: string = new Date().toISOString()
): WorkItemGraphView {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const visited = new Set<string>();

  function visit(id: string): WorkItem | undefined {
    if (visited.has(id)) return store.get(id);
    const workItem = store.get(id);
    if (!workItem) return undefined;
    visited.add(id);
    nodes.push(projectWorkItemNode(workItem, projectedAt));

    if (workItem.sourceWorkItemId && workItem.lineageType) {
      const ancestor = visit(workItem.sourceWorkItemId);
      if (ancestor) {
        const lineageEdge = projectLineageEdge(workItem, projectedAt);
        if (lineageEdge) edges.push(lineageEdge);
      }
    }

    for (const plan of store.listExecutionPlans(id)) {
      nodes.push(projectExecutionPlanNode(plan, projectedAt));
      edges.push(projectHasExecutionPlanEdge(workItem, plan, projectedAt));
    }

    const allocation = store.getActiveWorkspaceAllocationForWorkItem(id);
    if (allocation) {
      nodes.push(projectWorkspaceAllocationNode(allocation, projectedAt));
      edges.push(projectUsesWorkspaceEdge(workItem, allocation, projectedAt));
    }

    return workItem;
  }

  const root = visit(workItemId);
  if (!root) {
    throw new ControlStackError("graph_projection_source_missing", `no work item ${workItemId} to project`);
  }
  return { nodes, edges };
}

/**
 * Projects an attempt, its lease, its plan, and its work item from a single
 * getCommandAuthority lookup -- the one join packages/work-items already
 * exposes for this exact identity set, rather than inventing a new one.
 */
export function projectCommandAuthoritySubgraph(
  store: WorkItemStore,
  input: {
    workItemId: string;
    attemptId: string;
    leaseId: string;
    workerId: string;
    fencingToken: number;
    workspaceAllocationId: string;
  },
  projectedAt: string = new Date().toISOString()
): WorkItemGraphView {
  const authority = store.getCommandAuthority(input);
  if (!authority) {
    throw new ControlStackError(
      "graph_projection_source_missing",
      `no persisted command authority for attempt ${input.attemptId}`
    );
  }
  const { attempt, lease, workspaceAllocation } = authority;
  const plan = store.getExecutionPlan(attempt.planId);
  const workItem = store.get(attempt.workItemId);
  if (!plan || !workItem) {
    throw new ControlStackError(
      "graph_projection_source_missing",
      `command authority for attempt ${input.attemptId} references a plan or work item that no longer exists`
    );
  }

  const nodes: GraphNode[] = [
    projectWorkItemNode(workItem, projectedAt),
    projectExecutionPlanNode(plan, projectedAt),
    projectAttemptNode(attempt, projectedAt),
    projectAttemptLeaseNode(lease, projectedAt),
    projectWorkspaceAllocationNode(workspaceAllocation, projectedAt)
  ];
  const edges: GraphEdge[] = [
    projectHasExecutionPlanEdge(workItem, plan, projectedAt),
    projectHasAttemptEdge(plan, attempt, projectedAt),
    projectHasLeaseEdge(attempt, lease, projectedAt),
    projectUsesWorkspaceEdge(workItem, workspaceAllocation, projectedAt)
  ];
  return { nodes, edges };
}

/** Writes a projected view to a GraphStore: all nodes first, then all edges. */
export function writeGraphView(graphStore: { upsertNode(node: GraphNode): void; upsertEdge(edge: GraphEdge): void }, view: WorkItemGraphView): void {
  for (const node of view.nodes) graphStore.upsertNode(node);
  for (const edge of view.edges) graphStore.upsertEdge(edge);
}

/**
 * Re-fetches the authoritative record a node claims to be a projection of
 * and compares its current hash to the one stored at projection time. A
 * mismatch means the graph's view is stale -- it does not mean the
 * authoritative record is wrong; the authoritative record is always
 * trusted over the graph.
 */
export function isProjectionStale(node: GraphNode, currentSourceRecord: unknown): boolean {
  return stableHash(currentSourceRecord) !== node.sourceRecordHash;
}
