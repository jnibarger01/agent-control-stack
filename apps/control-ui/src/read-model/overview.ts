import {
  OVERVIEW_SCHEMA_VERSION,
  type NetworkEdge,
  type NetworkNode,
  type OverviewReadModel,
  type PipelineItem,
  type PipelineStage
} from "@agent-control-stack/mission-control-contract";
import type { WorkItem } from "@agent-control-stack/work-items";
import { redactSecrets, redactedAttributesJson } from "../redaction.js";
import { dashboardAgents } from "../render/fragments.js";
import { executionStage } from "../render/operations.js";
import type { MissionControlAgent, MissionControlViewModel } from "../types.js";

/**
 * Pure projection of the existing MissionControlViewModel into the JSON read
 * model consumed by the React app. It performs no store reads and only copies
 * whitelisted fields: no lease token hashes, no host paths (`target.cwd`,
 * `target.files`), no free-form `result`, no work-item params or metadata.
 */

const MAX_ITEMS_PER_STAGE = 25;
const MAX_NEEDS_YOU = 25;
const MAX_ACTIVITY = 50;
const MAX_NODES = 200;
const BACKEND_LABEL = /^[a-z0-9_.-]{1,64}$/i;

const CORE_STAGES: WorkItem["status"][] = [
  "draft",
  "pending_policy",
  "needs_approval",
  "approved",
  "running",
  "succeeded",
  "failed"
];
const EXCEPTIONAL_STAGES: WorkItem["status"][] = [
  "blocked",
  "quarantined",
  "unknown",
  "cancelling",
  "cancelled",
  "rejected"
];

function text(value: unknown, max: number): string {
  const redacted = redactSecrets(value);
  return redacted.length > max ? `${redacted.slice(0, max - 1)}…` : redacted;
}

function stageLabel(status: WorkItem["status"]): string {
  return executionStage({ status } as WorkItem);
}

function toIsoFromNanos(nanos: string): string {
  try {
    const ms = Number(BigInt(nanos) / 1_000_000n);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : "";
  } catch {
    return "";
  }
}

/** Same rule as the legacy console: active, not yet expired, within max(60s, 20% of observed TTL). */
function leaseExpiringSoon(
  lease: { status: string; expiresAt: string; lastRenewedAt?: string; issuedAt?: string },
  nowMs: number
): boolean {
  if (lease.status !== "active") return false;
  const expiresMs = Date.parse(lease.expiresAt);
  if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) return false;
  const startMs = Date.parse(lease.lastRenewedAt ?? lease.issuedAt ?? "");
  const ttl = Number.isFinite(startMs) ? Math.max(0, expiresMs - startMs) : 0;
  return expiresMs - nowMs <= Math.max(60_000, 0.2 * ttl);
}

function livenessOf(agent: MissionControlAgent): NetworkNode["liveness"] {
  return agent.status === "online" || agent.status === "stale" || agent.status === "offline" || agent.status === "observed"
    ? agent.status
    : "unknown";
}

export function toOverviewReadModel(model: MissionControlViewModel): OverviewReadModel {
  const now = model.now ?? new Date();
  const nowMs = now.getTime();
  const agents = dashboardAgents(model);
  const attempts = model.executionAttemptsByWorkItem ?? {};
  const leases = model.attemptLeasesByWorkItem ?? {};
  const counts = model.statusCounts;
  const countOf = (status: string): number =>
    counts && Number.isFinite(counts[status]) ? Math.max(0, Math.floor(counts[status] as number)) : model.workItems.filter((i) => i.status === status).length;

  // ── execution banner ────────────────────────────────────────────────
  const backend = model.executionBackend && BACKEND_LABEL.test(model.executionBackend) ? model.executionBackend : undefined;
  const execution: OverviewReadModel["execution"] = {
    mode: model.executionMode ?? "unknown",
    ...(model.executionModeProblem ? { modeProblem: model.executionModeProblem } : {}),
    ...(backend ? { backend } : {}),
    dryRun: backend === undefined ? "unknown" : backend === "dry_run" ? "yes" : "no"
  };

  // ── needs you ──────────────────────────────────────────────────────
  const attention = model.workItems
    .filter(
      (i): i is WorkItem & { status: "needs_approval" | "blocked" | "quarantined" } =>
        i.status === "needs_approval" || i.status === "blocked" || i.status === "quarantined"
    )
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  const expiringLeases: OverviewReadModel["needsYou"]["expiringLeases"] = [];
  for (const [workItemId, list] of Object.entries(leases)) {
    for (const lease of list) {
      if (leaseExpiringSoon(lease, nowMs)) {
        expiringLeases.push({
          leaseId: lease.leaseId,
          workItemId,
          workerId: lease.workerId,
          fencingEpoch: lease.fencingEpoch,
          expiresAt: lease.expiresAt
        });
      }
    }
  }
  expiringLeases.sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));

  // ── agent network: canonical bindings only ─────────────────────────
  const nodes = new Map<string, NetworkNode>();
  const edges: NetworkEdge[] = [];
  const edgeKeys = new Set<string>();
  const workById = new Map(model.workItems.map((i) => [i.id, i] as const));
  const executorIds = new Set((model.executorSummaries ?? []).map((e) => e.id));
  for (const executor of model.executorSummaries ?? []) {
    nodes.set(`executor:${executor.id}`, {
      id: `executor:${executor.id}`,
      kind: "executor",
      label: text(executor.displayName, 200),
      detail: executor.configured ? `configured · ${text(executor.status, 60)}` : `not configured · ${text(executor.status, 60)}`
    });
  }
  for (const connector of model.connectorSummaries ?? []) {
    nodes.set(`connector:${connector.id}`, {
      id: `connector:${connector.id}`,
      kind: "connector",
      label: text(connector.displayName, 200),
      detail: `${text(connector.status, 40)} · ${Math.max(0, Math.floor(connector.activeSessionCount))} active session${connector.activeSessionCount === 1 ? "" : "s"}`
    });
  }
  const agentNode = (id: string): NetworkNode => {
    // A lease held by an executor identity is drawn from that executor, never from a lookalike agent.
    if (executorIds.has(id)) return nodes.get(`executor:${id}`)!;
    const key = `agent:${id}`;
    let node = nodes.get(key);
    if (!node) {
      node = { id: key, kind: "agent", label: text(id, 200), liveness: "unknown", detail: "observed worker" };
      nodes.set(key, node);
    }
    return node;
  };
  for (const agent of agents) {
    nodes.set(`agent:${agent.id}`, {
      id: `agent:${agent.id}`,
      kind: "agent",
      label: text(agent.displayName, 200),
      liveness: livenessOf(agent),
      detail: text(agent.kind, 200),
      ...(agent.capabilities.length ? { capabilities: agent.capabilities.slice(0, 32).map((c) => text(c, 80)) } : {}),
      ...(agent.lastHeartbeatAt ? { lastHeartbeatAt: agent.lastHeartbeatAt } : {})
    });
  }
  const workNode = (item: WorkItem): string => {
    const key = `work:${item.id}`;
    if (!nodes.has(key)) {
      nodes.set(key, { id: key, kind: "work_item", label: text(item.title, 200), detail: item.status });
    }
    return key;
  };
  const addEdge = (edge: NetworkEdge) => {
    const key = `${edge.from}|${edge.to}`;
    if (edgeKeys.has(key) || nodes.size > MAX_NODES) return;
    edgeKeys.add(key);
    edges.push(edge);
  };
  // Only the active lease with the highest fencing epoch is current authority;
  // a lower-epoch lease is stale and is never drawn as current ownership.
  for (const [workItemId, list] of Object.entries(leases)) {
    const item = workById.get(workItemId);
    if (!item) continue;
    const active = list.filter((l) => l.status === "active");
    if (!active.length) continue;
    const current = active.reduce((a, b) => (b.fencingEpoch > a.fencingEpoch ? b : a));
    const agent = agentNode(current.workerId);
    addEdge({ from: agent.id, to: workNode(item), kind: "active_lease", fencingEpoch: current.fencingEpoch });
  }
  for (const agent of agents) {
    const item = agent.currentWorkItemId ? workById.get(agent.currentWorkItemId) : undefined;
    if (item) addEdge({ from: `agent:${agent.id}`, to: workNode(item), kind: "reported_task" });
  }

  // ── pipeline ───────────────────────────────────────────────────────
  const itemsByStatus = new Map<string, WorkItem[]>();
  for (const item of model.workItems) {
    const list = itemsByStatus.get(item.status) ?? [];
    list.push(item);
    itemsByStatus.set(item.status, list);
  }
  const stages: PipelineStage[] = [...CORE_STAGES, ...EXCEPTIONAL_STAGES]
    .map((status): PipelineStage | null => {
      const windowItems = itemsByStatus.get(status) ?? [];
      const count = countOf(status);
      if (EXCEPTIONAL_STAGES.includes(status) && count === 0 && windowItems.length === 0) return null;
      const items: PipelineItem[] = [...windowItems]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, MAX_ITEMS_PER_STAGE)
        .map((item) => {
          const latest = attempts[item.id]?.at(-1);
          const lease = (leases[item.id] ?? []).filter((l) => l.status === "active").at(-1);
          const agentId = lease?.workerId ?? latest?.claimedByWorkerId;
          return {
            id: item.id,
            title: text(item.title, 300),
            intent: text(item.intent, 500),
            risk: item.risk,
            status: item.status,
            updatedAt: item.updatedAt,
            ...(latest ? { attemptStatus: latest.status, attemptNumber: latest.attemptNumber } : {}),
            ...(agentId ? { agentId: text(agentId, 200) } : {})
          };
        });
      return { key: status, label: stageLabel(status), count, countSource: counts ? "store" : "window", items };
    })
    .filter((s): s is PipelineStage => s !== null);

  // ── activity ───────────────────────────────────────────────────────
  const events = [...(model.events ?? [])].sort((a, b) => b.sequence - a.sequence);
  const activity = events.slice(0, MAX_ACTIVITY).map((event) => ({
    sequence: event.sequence,
    id: event.id,
    name: event.name,
    at: toIsoFromNanos(event.timeUnixNano),
    summary: text(redactedAttributesJson(event.attributes), 400)
  }));

  // ── observability / readiness / sections ───────────────────────────
  const telemetry = model.executionTelemetry ?? null;
  const admission = model.infrastructure?.admission ?? null;
  const readiness = model.readiness
    ? {
        ok: model.readiness.ok,
        checks: Object.entries(model.readiness.checks).map(([name, check]) => ({
          name,
          ok: check.ok,
          ...(check.code ? { code: check.code } : {})
        }))
      }
    : null;
  const section = (present: boolean, reason: string) => (present ? { status: "ok" as const } : { status: "unavailable" as const, reason });

  return {
    schemaVersion: OVERVIEW_SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    eventSequence: events.length ? (events[0] as { sequence: number }).sequence : null,
    execution,
    sections: {
      needsYou: { status: "ok" },
      network: { status: "ok" },
      pipeline: { status: "ok" },
      observability: section(telemetry !== null || admission !== null, "telemetry_absent"),
      activity: section(model.events !== undefined, "events_absent"),
      readiness: section(readiness !== null, "readiness_absent")
    },
    needsYou: {
      approvals: countOf("needs_approval"),
      blocked: countOf("blocked"),
      quarantined: countOf("quarantined"),
      items: attention.slice(0, MAX_NEEDS_YOU).map((item) => ({
        workItemId: item.id,
        title: text(item.title, 300),
        status: item.status,
        risk: item.risk,
        since: item.updatedAt
      })),
      expiringLeases: expiringLeases.slice(0, MAX_NEEDS_YOU)
    },
    network: { nodes: [...nodes.values()].slice(0, MAX_NODES), edges },
    pipeline: {
      stages,
      ...(model.finishedWorkItems ? { finishedWindow: { shown: model.finishedWorkItems.shown, total: model.finishedWorkItems.total } } : {})
    },
    observability: { telemetry, admission },
    infrastructure: model.infrastructure
      ? {
          agents: model.infrastructure.agents,
          executors: model.infrastructure.executors,
          connectors: model.infrastructure.connectors
        }
      : null,
    activity,
    readiness
  };
}
