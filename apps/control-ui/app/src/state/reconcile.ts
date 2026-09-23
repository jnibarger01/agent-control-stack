import type { StoredAuditEvent } from "../api/types";

/** Query-key namespaces shared by the data hooks and by live-event reconciliation. */
export const keys = {
  workItems: "work-items",
  workItem: (id: string) => `work-item:${id}`,
  agents: "agents",
  runtimes: "runtimes",
  agent: (id: string) => `agent:${id}`,
  actors: "actors",
  connectors: "connectors",
  session: "session",
  executions: "executions",
  events: "events",
  health: "health",
  metrics: "metrics"
} as const;

function attr(event: StoredAuditEvent, name: string): string | undefined {
  const value = event.attributes?.[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Which cached views can an incoming audit event have changed? Returning the
 * narrowest set keeps a busy control plane from turning every event into a
 * refetch storm; `events` is always included because the audit view is the
 * live projection of the log itself.
 */
export function invalidationsFor(event: StoredAuditEvent): string[] {
  const out = new Set<string>([keys.events]);
  const name = event.name;
  const workItemId = attr(event, "work_item.id");

  if (workItemId) {
    out.add(keys.workItem(workItemId));
    out.add(keys.workItems);
  }
  if (name.startsWith("work_item.") || name.startsWith("approval.") || name.startsWith("policy.")) {
    out.add(keys.workItems);
  }
  if (
    name.startsWith("execution") ||
    name.startsWith("attempt") ||
    name.startsWith("execution_plan") ||
    name.startsWith("workspace_allocation")
  ) {
    out.add(keys.workItems);
    out.add(keys.executions);
  }
  if (name.startsWith("work_item.")) out.add(keys.executions);
  const agentId = attr(event, "agent.id") ?? attr(event, "worker.id");
  if (name.startsWith("agent.") || agentId) {
    out.add(keys.agents);
    out.add(keys.actors);
    if (agentId) out.add(keys.agent(agentId));
  }
  if (name.startsWith("connector.") || name.startsWith("tunnel_session.") || attr(event, "connector.id")) {
    out.add(keys.actors);
    out.add(keys.agents);
    out.add(keys.connectors);
  }
  if (name.startsWith("actor.")) out.add(keys.actors);
  return [...out];
}

/** Severity is a UI classification derived from the event name; the log itself has no severity field. */
export type EventSeverity = "info" | "notice" | "warning" | "error";

export function severityFor(event: Pick<StoredAuditEvent, "name" | "attributes" | "body">): EventSeverity {
  const name = event.name;
  const decision = event.attributes?.["policy.decision"];
  if (
    /(^|[._])(failed|error|denied|quarantined|unknown|expired|stolen|revoked|blocked)($|[._])/u.test(name) ||
    decision === "deny"
  ) {
    return "error";
  }
  if (
    /needs_approval|require|cancel|reject|interrupted|reconciled|rotated/u.test(name) ||
    decision === "require_approval"
  ) {
    return "warning";
  }
  if (/approved|granted|succeeded|completed|admitted|registered|created/u.test(name)) return "notice";
  return "info";
}

export function eventTimeMs(event: Pick<StoredAuditEvent, "timeUnixNano">): number {
  // timeUnixNano can exceed 2^53; divide as BigInt to keep millisecond precision.
  try {
    return Number(BigInt(event.timeUnixNano) / 1_000_000n);
  } catch {
    return Number.NaN;
  }
}
