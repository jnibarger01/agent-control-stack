import type { StoredAuditEvent } from "../api/types";
import { eventTimeMs, severityFor, type EventSeverity } from "../state/reconcile";

export interface AuditFilters {
  q: string;
  type: string;
  actor: string;
  workItem: string;
  severity: "" | EventSeverity;
  window: string; // "", "5m", "1h", "24h"
}

export const DEFAULT_AUDIT_FILTERS: AuditFilters = {
  q: "",
  type: "",
  actor: "",
  workItem: "",
  severity: "",
  window: ""
};

const WINDOWS_MS: Record<string, number> = { "5m": 300_000, "1h": 3_600_000, "24h": 86_400_000 };

export function parseAuditFilters(params: URLSearchParams): AuditFilters {
  const severity = params.get("severity");
  return {
    q: params.get("q") ?? "",
    type: params.get("type") ?? "",
    actor: params.get("actor") ?? "",
    workItem: params.get("workItem") ?? "",
    severity:
      severity === "info" || severity === "notice" || severity === "warning" || severity === "error" ? severity : "",
    window: params.get("window") ?? ""
  };
}

export function serializeAuditFilters(filters: AuditFilters): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
  return params;
}

export function eventActor(event: StoredAuditEvent): string {
  const a = event.attributes ?? {};
  const body = event.body ?? {};
  for (const key of [
    "actor.id",
    "worker.id",
    "agent.id",
    "auth.connector_id",
    "connector.id",
    "auth.subject",
    "work_item.rejected_by"
  ]) {
    const value = a[key];
    if (typeof value === "string" && value) return value;
  }
  for (const key of ["actor", "approvedBy", "workerId", "connectorId", "createdByActorId"]) {
    const value = (body as Record<string, unknown>)[key];
    if (typeof value === "string" && value) return value;
  }
  return "system";
}

export function eventWorkItem(event: StoredAuditEvent): string | undefined {
  const value = event.attributes?.["work_item.id"];
  return typeof value === "string" && value ? value : undefined;
}

/** One-line summary built only from structured fields; free-form payload text is never interpolated as markup. */
export function eventSummary(event: StoredAuditEvent): string {
  const a = event.attributes ?? {};
  const body = (event.body ?? {}) as Record<string, unknown>;
  const parts: string[] = [];
  const decision = a["policy.decision"];
  if (typeof decision === "string") parts.push(`decision ${decision}`);
  for (const key of ["reason", "error", "outcomeCode", "status", "summary"]) {
    const value = body[key];
    if (typeof value === "string" && value) {
      parts.push(value.length > 140 ? `${value.slice(0, 140)}…` : value);
      break;
    }
  }
  const attemptStatus = a["attempt.status"];
  if (typeof attemptStatus === "string") parts.push(`attempt ${attemptStatus}`);
  return parts.join(" · ") || "—";
}

export function applyAuditFilters(
  events: readonly StoredAuditEvent[],
  filters: AuditFilters,
  now: number
): StoredAuditEvent[] {
  const q = filters.q.trim().toLowerCase();
  const windowMs = WINDOWS_MS[filters.window];
  return events.filter((event) => {
    if (filters.type && !event.name.startsWith(filters.type)) return false;
    if (filters.actor && eventActor(event) !== filters.actor) return false;
    if (filters.workItem && eventWorkItem(event) !== filters.workItem) return false;
    if (filters.severity && severityFor(event) !== filters.severity) return false;
    if (windowMs !== undefined && now - eventTimeMs(event) > windowMs) return false;
    if (q) {
      const hay =
        `${event.name}\n${event.id}\n${eventActor(event)}\n${eventWorkItem(event) ?? ""}\n${eventSummary(event)}\n${Object.values(event.attributes ?? {}).join(" ")}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

export function eventTypeGroups(events: readonly StoredAuditEvent[]): string[] {
  return [...new Set(events.map((event) => event.name.split(".")[0] ?? event.name))].sort();
}

/** Events touching the same work item, agent/connector, or attempt as `event`. */
export function relatedEvents(
  event: StoredAuditEvent,
  pool: readonly StoredAuditEvent[],
  limit = 50
): StoredAuditEvent[] {
  const keys = [
    "work_item.id",
    "agent.id",
    "worker.id",
    "connector.id",
    "attempt.id",
    "plan.id",
    "tunnel.id",
    "tunnel_session.id"
  ];
  const mine = keys
    .map((key) => [key, event.attributes?.[key]] as const)
    .filter((pair): pair is readonly [string, string] => typeof pair[1] === "string" && pair[1] !== "");
  if (mine.length === 0) return [];
  return pool
    .filter(
      (candidate) => candidate.id !== event.id && mine.some(([key, value]) => candidate.attributes?.[key] === value)
    )
    .slice(-limit)
    .reverse();
}

/** Real events/sec over `windowMs` from the events this tab has actually received. */
export function eventsPerSecond(events: readonly StoredAuditEvent[], now: number, windowMs = 60_000): number {
  const cutoff = now - windowMs;
  const count = events.filter((event) => eventTimeMs(event) >= cutoff).length;
  return count / (windowMs / 1000);
}
