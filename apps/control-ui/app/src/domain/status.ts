import type { ExecutionAttempt, RegistryAgentView, WorkItem } from "../api/types";

/** The only place status → colour semantics are decided. Text always accompanies colour. */
export type Tone = "success" | "info" | "warning" | "danger" | "neutral" | "muted";

export interface StatusMeta {
  label: string;
  tone: Tone;
}

const WORK_ITEM_STATUS: Record<WorkItem["status"], StatusMeta> = {
  draft: { label: "Draft", tone: "muted" },
  pending_policy: { label: "Pending policy", tone: "info" },
  needs_approval: { label: "Needs approval", tone: "warning" },
  approved: { label: "Approved", tone: "info" },
  running: { label: "Running", tone: "info" },
  cancelling: { label: "Cancelling", tone: "warning" },
  succeeded: { label: "Succeeded", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  blocked: { label: "Blocked", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "muted" },
  rejected: { label: "Rejected", tone: "muted" },
  unknown: { label: "Unknown", tone: "danger" },
  quarantined: { label: "Quarantined", tone: "danger" }
};

export function workItemStatusMeta(status: string): StatusMeta {
  return WORK_ITEM_STATUS[status as WorkItem["status"]] ?? { label: humanize(status), tone: "neutral" };
}

const RISK: Record<WorkItem["risk"], StatusMeta> = {
  low: { label: "Low", tone: "success" },
  medium: { label: "Medium", tone: "info" },
  high: { label: "High", tone: "warning" },
  critical: { label: "Critical", tone: "danger" }
};

export function riskMeta(risk: string): StatusMeta {
  return RISK[risk as WorkItem["risk"]] ?? { label: humanize(risk), tone: "neutral" };
}

const ATTEMPT: Record<ExecutionAttempt["status"], StatusMeta> = {
  pending: { label: "Queued", tone: "muted" },
  leased: { label: "Leased", tone: "info" },
  running: { label: "Running", tone: "info" },
  cancellation_requested: { label: "Cancelling", tone: "warning" },
  interrupted: { label: "Interrupted", tone: "warning" },
  succeeded: { label: "Succeeded", tone: "success" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "muted" },
  unknown: { label: "Unknown", tone: "danger" },
  quarantined: { label: "Quarantined", tone: "danger" }
};

export function attemptStatusMeta(status: string): StatusMeta {
  return ATTEMPT[status as ExecutionAttempt["status"]] ?? { label: humanize(status), tone: "neutral" };
}

const LEASE: Record<string, StatusMeta> = {
  active: { label: "Active", tone: "success" },
  consumed: { label: "Consumed", tone: "muted" },
  expired: { label: "Expired", tone: "warning" },
  revoked: { label: "Revoked", tone: "danger" }
};

export function leaseStatusMeta(status: string): StatusMeta {
  return LEASE[status] ?? { label: humanize(status), tone: "neutral" };
}

export function humanize(value: string): string {
  const spaced = value.replaceAll("_", " ").replaceAll(".", " ").trim();
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : value;
}

/** Statuses that need a human to look at them. Mirrors the legacy dashboard's attention set plus failures. */
const ATTENTION: ReadonlySet<string> = new Set(["needs_approval", "blocked", "quarantined", "failed", "unknown"]);

export function needsAttention(status: string): boolean {
  return ATTENTION.has(status);
}

export const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "rejected",
  "quarantined"
]);

// --- agent liveness ---------------------------------------------------------

export type AgentLiveness = "online" | "stale" | "offline" | "unknown";

/**
 * Liveness is taken from the gateway's own projection (`effectiveStatus`,
 * `isStale`, `heartbeatAgeMs`), which applies ACS's heartbeat TTL. This code
 * never re-implements the window, and never infers "online" from existence:
 * a registered agent with no heartbeat evidence is `unknown`.
 */
export function agentLiveness(
  agent: Pick<RegistryAgentView, "effectiveStatus" | "isStale" | "lastHeartbeatAt">
): AgentLiveness {
  if (!agent.lastHeartbeatAt) return agent.effectiveStatus === "OFFLINE" ? "offline" : "unknown";
  if (agent.effectiveStatus === "OFFLINE") return "offline";
  if (agent.isStale) return "stale";
  if (agent.effectiveStatus === "UNKNOWN") return "unknown";
  return "online";
}

export function livenessMeta(liveness: AgentLiveness): StatusMeta {
  switch (liveness) {
    case "online":
      return { label: "Online", tone: "success" };
    case "stale":
      return { label: "Stale", tone: "warning" };
    case "offline":
      return { label: "Offline", tone: "muted" };
    default:
      return { label: "Unknown", tone: "neutral" };
  }
}

export function agentHealthMeta(agent: Pick<RegistryAgentView, "effectiveStatus" | "lastError">): StatusMeta {
  switch (agent.effectiveStatus) {
    case "AVAILABLE":
    case "BUSY":
      return { label: "Healthy", tone: "success" };
    case "DEGRADED":
      return { label: "Degraded", tone: "warning" };
    case "ERROR":
      return { label: "Unhealthy", tone: "danger" };
    case "OFFLINE":
      return { label: agent.lastError ? "Unhealthy" : "Offline", tone: agent.lastError ? "danger" : "muted" };
    default:
      return { label: "Unknown", tone: "neutral" };
  }
}
