import {
  DEFAULT_HEARTBEAT_TTL_MS,
  isHeartbeatExpired,
  SqliteWorkItemStore,
  type AcpRole,
  type RegistryAgentDetail
} from "@agent-control-stack/work-items";
import { isWorkerCapacityTarget } from "./discover-actors.js";

/**
 * Compatibility actor record for `acs actor list --available --json`.
 * Shape matches scheduler.py's Herdr fallback objects so json.loads(stdout) works.
 * capacity is a fixed shim (1), not an ACS capacity model.
 */
export interface CompatibilityAvailableActor {
  actor_id: string;
  role: "coder" | "researcher" | "operator";
  status: "AVAILABLE";
  agent_type: string;
  pane_id: string;
  capacity: 1;
}

export interface ListAvailableActorsOptions {
  dbPath?: string;
  now?: Date;
  heartbeatTtlMs?: number;
}

export function compatibilityRole(acpRole: AcpRole): CompatibilityAvailableActor["role"] {
  if (acpRole === "IMPLEMENTATION_AGENT" || acpRole === "LOCAL_CODING_AGENT") {
    return "coder";
  }
  if (acpRole === "RESEARCH_BROAD_SCAN_AGENT") {
    return "researcher";
  }
  return "operator";
}

export function toCompatibilityActor(agent: RegistryAgentDetail): CompatibilityAvailableActor {
  return {
    actor_id: agent.id,
    role: compatibilityRole(agent.acpRole),
    status: "AVAILABLE",
    agent_type: agent.provider ?? agent.kind,
    pane_id: agent.id,
    capacity: 1
  };
}

export function isAvailableFreshAgent(
  agent: RegistryAgentDetail,
  now: Date,
  heartbeatTtlMs = DEFAULT_HEARTBEAT_TTL_MS
): boolean {
  return (
    agent.status === "AVAILABLE" && !isHeartbeatExpired(agent.lastHeartbeatAt, agent.updatedAt, now, heartbeatTtlMs)
  );
}

export function listAvailableActors(options: ListAvailableActorsOptions = {}): CompatibilityAvailableActor[] {
  const dbPath = options.dbPath ?? process.env.ACS_DB_PATH ?? "storage/local.db";
  const now = options.now ?? new Date();
  const heartbeatTtlMs = options.heartbeatTtlMs ?? DEFAULT_HEARTBEAT_TTL_MS;
  const store = new SqliteWorkItemStore(dbPath, { heartbeatTtlMs });
  try {
    return store
      .listRegistryAgents()
      .filter((agent) => isAvailableFreshAgent(agent, now, heartbeatTtlMs) && isWorkerCapacityTarget(agent.id))
      .map(toCompatibilityActor);
  } finally {
    store.close();
  }
}
