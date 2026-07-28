import type { StoredAuditEvent, WorkItem, WorkItemStore } from "@agent-control-stack/work-items";
export const ACS_DASHBOARD_RESOURCE_URI = "ui://acs/dashboard-v1";
export const ACS_DASHBOARD_CSP = Object.freeze({ connectDomains: [], resourceDomains: [] });
const project = (item: WorkItem) => ({
  id: item.id,
  title: item.title,
  status: item.status,
  risk: item.risk,
  updatedAt: item.updatedAt
});
const summary = (item: WorkItem) =>
  typeof item.result?.error === "string"
    ? item.result.error
    : typeof item.result?.summary === "string"
      ? item.result.summary
      : undefined;
export function dashboardOverview(store: WorkItemStore) {
  const items = store.list();
  const health = store.health();
  const blocked = items.filter((i) => i.status === "blocked").length;
  const failed = items.filter((i) => i.status === "failed").length;
  const quarantined = items.filter((i) => i.status === "quarantined").length;
  return {
    health: { status: health.ok ? "healthy" : "unhealthy" },
    activeExecutions: items.filter((i) => i.status === "running").length,
    blockedExecutions: blocked,
    pendingApprovals: items.filter((i) => i.status === "needs_approval").length,
    findings: { total: blocked + failed + quarantined, blocked, failed, quarantined },
    recentExecutions: [...items]
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 12)
      .map(project)
  };
}
export function executionDetail(store: WorkItemStore, id: string) {
  const item = store.get(id);
  if (!item) return undefined;
  const finding = summary(item);
  const findings = [
    (["blocked", "failed", "quarantined"] as string[]).includes(item.status)
      ? `Execution is ${item.status.replaceAll("_", " ")}.`
      : undefined,
    finding
  ].filter((v): v is string => Boolean(v));
  return {
    execution: {
      ...project(item),
      intent: item.intent,
      requestedActions: item.requestedActions.map((a) => a.description)
    },
    findings,
    events: store
      .readEvents({ workItemId: id, limit: 20 })
      .map((e: StoredAuditEvent) => ({
        name: e.name,
        time: new Date(Number(e.timeUnixNano) / 1_000_000).toISOString()
      }))
  };
}
