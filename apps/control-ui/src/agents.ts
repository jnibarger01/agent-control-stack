import {
  DEFAULT_HEARTBEAT_ONLINE_WINDOW_MS,
  DEFAULT_HEARTBEAT_TTL_MS,
  type RegistryAgentDetail,
  type StoredAuditEvent,
  type WorkItem
} from "@agent-control-stack/work-items";
import { nanoToIso } from "./format.js";
import { type MissionControlAgent } from "./types.js";

export function projectAgents(
  workItems: WorkItem[],
  events: StoredAuditEvent[],
  now = new Date(),
  registeredAgents: RegistryAgentDetail[] = []
): MissionControlAgent[] {
  const agents = new Map<string, MissionControlAgent>();
  const touch = (id: string, patch: Partial<MissionControlAgent>) => {
    const current = agents.get(id) ?? {
      id,
      displayName: id,
      kind: "observed",
      status: "observed" as const,
      health: "unknown" as const,
      capabilities: [],
      metadata: {}
    };
    const capabilities = patch.capabilities
      ? [...new Set([...current.capabilities, ...patch.capabilities])]
      : current.capabilities;
    agents.set(id, {
      ...current,
      ...patch,
      capabilities,
      metadata: { ...current.metadata, ...(patch.metadata ?? {}) }
    });
  };

  for (const agent of registeredAgents) {
    const projected = registryStatus(agent.status);
    touch(agent.id, {
      displayName: agent.name,
      kind: agent.kind,
      status: projected.status,
      health: projected.health,
      capabilities: agent.capabilities.map((capability) => capability.name),
      lastHeartbeatAt: agent.lastHeartbeatAt,
      lastEventAt: agent.lastHeartbeatAt ?? agent.updatedAt,
      lastError: agent.lastError,
      metadata: { registryStatus: agent.status, registered: "true" }
    });
  }

  for (const item of workItems) {
    const target = item.target.services?.[0] ?? item.target.repo ?? item.target.cwd;
    if (target) touch(target, { kind: "target", currentTask: item.title, currentWorkItemId: item.id });
    if (item.requester === "agent") touch("agent", { kind: "requester" });
  }

  for (const event of events) {
    const body = asRecord(event.body);
    const attrs = event.attributes ?? {};
    const ids = [
      attrs["worker.id"],
      attrs["connector.id"],
      attrs["auth.connector_id"],
      body.connectorId,
      body.workerId
    ].filter((value): value is string => typeof value === "string" && value.length > 0);
    for (const id of ids) {
      touch(id, eventPatch(id, event, body));
    }
  }

  return [...agents.values()]
    .map((agent) => finalizeAgent(agent, now))
    .sort(
      (left, right) =>
        statusRank(left.status) - statusRank(right.status) || left.displayName.localeCompare(right.displayName)
    );
}
function eventPatch(id: string, event: StoredAuditEvent, body: Record<string, unknown>): Partial<MissionControlAgent> {
  const patch: Partial<MissionControlAgent> = { lastEventAt: nanoToIso(event.timeUnixNano) };
  if (typeof body.displayName === "string") patch.displayName = body.displayName;
  if (event.name.includes("heartbeat")) patch.lastHeartbeatAt = patch.lastEventAt;
  if (event.name.includes("revoked")) patch.status = "offline";
  if (event.name.includes("failed") || event.name.includes("error")) {
    patch.health = "unhealthy";
    patch.lastError = typeof body.error === "string" ? body.error : event.name;
  }
  if (event.name === "connector.registered") {
    patch.kind = "connector";
    patch.status = "observed";
    patch.capabilities = Array.isArray(body.allowedScopes) ? body.allowedScopes.filter(isString) : [];
    patch.metadata = { connectorId: id };
  }
  if (event.name === "tunnel_session.heartbeat") {
    patch.kind = "tunnel";
    patch.status = "online";
    patch.health = "healthy";
  }
  return patch;
}

function finalizeAgent(agent: MissionControlAgent, now: Date): MissionControlAgent {
  const heartbeatAgeMs = agent.lastHeartbeatAt
    ? now.getTime() - Date.parse(agent.lastHeartbeatAt)
    : Number.POSITIVE_INFINITY;
  const eventAgeMs = agent.lastEventAt ? now.getTime() - Date.parse(agent.lastEventAt) : Number.POSITIVE_INFINITY;
  let status = agent.status;
  let health = agent.health;
  if (agent.lastHeartbeatAt) {
    status =
      heartbeatAgeMs <= DEFAULT_HEARTBEAT_ONLINE_WINDOW_MS
        ? "online"
        : heartbeatAgeMs <= DEFAULT_HEARTBEAT_TTL_MS
          ? "stale"
          : "offline";
    health =
      status === "online"
        ? "healthy"
        : status === "stale"
          ? "warning"
          : health === "unhealthy"
            ? "unhealthy"
            : "unknown";
  } else if (status !== "offline" && eventAgeMs > DEFAULT_HEARTBEAT_TTL_MS) {
    status = "stale";
  }
  return { ...agent, status, health };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function statusRank(status: MissionControlAgent["status"]): number {
  return { online: 0, observed: 1, stale: 2, offline: 3 }[status];
}

function registryStatus(status: RegistryAgentDetail["status"]): Pick<MissionControlAgent, "status" | "health"> {
  if (status === "ERROR") return { status: "offline", health: "unhealthy" };
  if (status === "OFFLINE") return { status: "offline", health: "unknown" };
  if (status === "DEGRADED") return { status: "observed", health: "warning" };
  return { status: "observed", health: "unknown" };
}
