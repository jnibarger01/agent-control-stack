import type { Liveness, NetworkEdge, NetworkNode } from "@agent-control-stack/mission-control-contract";

export interface PlacedNode {
  node: NetworkNode;
  x: number;
  y: number;
}
export interface PlacedEdge {
  edge: NetworkEdge;
  d: string;
  midX: number;
  midY: number;
}
export interface NetworkLayout {
  width: number;
  height: number;
  /** Left lane: agents, then executors, then connectors. Work items are on the right. */
  lane: PlacedNode[];
  works: PlacedNode[];
  edges: PlacedEdge[];
  agentX: number;
  workX: number;
}

const KIND_ORDER: Record<NetworkNode["kind"], number> = { agent: 0, executor: 1, connector: 2, work_item: 3 };
const LIVENESS_ORDER: Record<Liveness, number> = { online: 0, stale: 1, observed: 2, offline: 3, unknown: 4 };
const WORK_STATUS_ORDER = ["running", "approved", "needs_approval", "blocked", "quarantined", "pending_policy", "draft", "failed", "succeeded"];

export const NETWORK_WIDTH = 920;
export const ROW_GAP = 46;
const PAD = 30;
const AGENT_X = 262;
const WORK_W = 292;

/**
 * Deterministic two-lane layout: agents on the left, the work items they are
 * provably bound to on the right. The same input always yields the same output,
 * so the view does not jump between live refreshes. Edges exist only where the
 * read model carries a canonical binding; this function never adds any.
 */
export function layoutNetwork(nodes: NetworkNode[], edges: NetworkEdge[], width = NETWORK_WIDTH): NetworkLayout {
  const workX = width - WORK_W - 24;
  const bound = new Set<string>();
  for (const e of edges) {
    bound.add(e.from);
    bound.add(e.to);
  }
  const agentNodes = nodes
    .filter((n) => n.kind !== "work_item")
    .sort(
      (a, b) =>
        Number(bound.has(b.id)) - Number(bound.has(a.id)) ||
        KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
        LIVENESS_ORDER[a.liveness ?? "unknown"] - LIVENESS_ORDER[b.liveness ?? "unknown"] ||
        a.label.localeCompare(b.label) ||
        a.id.localeCompare(b.id)
    );
  const agentIndex = new Map(agentNodes.map((n, i) => [n.id, i] as const));
  const minAgentRow = (workId: string) => Math.min(...edges.filter((e) => e.to === workId).map((e) => agentIndex.get(e.from) ?? Infinity));
  const stageRank = (n: NetworkNode) => {
    const r = WORK_STATUS_ORDER.indexOf(n.detail ?? "");
    return r === -1 ? WORK_STATUS_ORDER.length : r;
  };
  const workNodes = nodes
    .filter((n) => n.kind === "work_item")
    .sort((a, b) => minAgentRow(a.id) - minAgentRow(b.id) || stageRank(a) - stageRank(b) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id));

  const lane = agentNodes.map((node, i) => ({ node, x: AGENT_X, y: PAD + i * ROW_GAP + ROW_GAP / 2 }));
  const works = workNodes.map((node, i) => ({ node, x: workX, y: PAD + i * ROW_GAP + ROW_GAP / 2 }));
  const pos = new Map<string, PlacedNode>([...lane, ...works].map((p) => [p.node.id, p] as const));
  const placedEdges: PlacedEdge[] = [];
  for (const edge of edges) {
    const a = pos.get(edge.from);
    const w = pos.get(edge.to);
    if (!a || !w) continue; // an edge whose endpoint is not drawn is dropped, never invented
    const x1 = a.x + 12;
    const x2 = w.x;
    const mid = (x1 + x2) / 2;
    placedEdges.push({ edge, d: `M ${x1} ${a.y} C ${mid} ${a.y}, ${mid} ${w.y}, ${x2} ${w.y}`, midX: mid, midY: (a.y + w.y) / 2 });
  }
  const rows = Math.max(lane.length, works.length, 1);
  return { width, height: PAD * 2 + rows * ROW_GAP, lane, works, edges: placedEdges, agentX: AGENT_X, workX };
}

/** Node ids highlighted when `focus` is hovered/selected: itself plus real neighbours only. */
export function neighbourhood(focus: string | null, edges: NetworkEdge[]): Set<string> | null {
  if (!focus) return null;
  const set = new Set<string>([focus]);
  for (const e of edges) {
    if (e.from === focus) set.add(e.to);
    if (e.to === focus) set.add(e.from);
  }
  return set;
}
