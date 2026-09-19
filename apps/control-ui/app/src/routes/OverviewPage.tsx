import { useMemo } from "react";
import { agentHealthMeta, agentLiveness, livenessMeta, needsAttention } from "../domain/status";
import { summarizeExecutions } from "../domain/execution";
import { eventActor, eventSummary } from "../domain/audit";
import { formatDuration, formatTime, relativeAge } from "../domain/format";
import { eventTimeMs, severityFor } from "../state/reconcile";
import {
  eventStream,
  useEventBackfill,
  useExecutions,
  useHealth,
  useRegistryAgents,
  useWorkItems
} from "../state/data";
import { useEventStream } from "../state/events";
import { Link } from "../router";
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHead,
  RiskBadge,
  Stat,
  StatusBadge
} from "../components/ui";
import { DataTable } from "../components/DataTable";

export function OverviewPage() {
  const work = useWorkItems();
  const agents = useRegistryAgents();
  const executions = useExecutions(work.data);
  const backfill = useEventBackfill();
  const stream = useEventStream(eventStream);
  const health = useHealth();
  const now = Date.now();

  const items = work.data ?? [];
  const counts = useMemo(() => {
    const by = (status: string) => items.filter((item) => item.status === status).length;
    return {
      running: by("running"),
      approvals: by("needs_approval"),
      blocked: by("blocked"),
      failed: by("failed") + by("quarantined")
    };
  }, [items]);
  const online = (agents.data ?? []).filter((agent) => agentLiveness(agent) === "online").length;
  const execSummary = executions.data ? summarizeExecutions(executions.data.rows) : undefined;

  const attention = useMemo(() => {
    const workAttention = items
      .filter((item) => needsAttention(item.status))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, 8);
    const agentAttention = (agents.data ?? []).filter(
      (agent) =>
        agent.effectiveStatus === "ERROR" ||
        agent.effectiveStatus === "DEGRADED" ||
        (agent.isStale && agent.lastHeartbeatAt)
    );
    return { workAttention, agentAttention };
  }, [items, agents.data]);

  const recent = useMemo(() => {
    const merged = new Map<string, (typeof stream.events)[number]>();
    for (const event of backfill.data ?? []) merged.set(event.id, event);
    for (const event of stream.events) merged.set(event.id, event);
    return [...merged.values()].sort((a, b) => b.sequence - a.sequence).slice(0, 8);
  }, [backfill.data, stream.events]);

  const active = (executions.data?.rows ?? [])
    .filter((row) => row.attempt && ["leased", "running", "cancellation_requested"].includes(row.attempt.status))
    .slice(0, 8);

  if (work.error && !work.hasData) return <ErrorState error={work.error} onRetry={work.refetch} what="work items" />;

  return (
    <div className="page" data-testid="page-overview">
      <PageHead title="Overview" description="Live state of the ACS control plane." />

      <div className="stat-grid" aria-label="Summary">
        <Stat
          label="Online agents"
          value={agents.hasData ? `${online} / ${agents.data?.length ?? 0}` : "—"}
          note="Fresh heartbeat within the ACS TTL"
          to="/agents"
          tone={online > 0 ? "success" : undefined}
        />
        <Stat
          label="Running"
          value={work.hasData ? counts.running : "—"}
          note="Work items executing"
          to="/work?status=running"
        />
        <Stat
          label="Pending approvals"
          value={work.hasData ? counts.approvals : "—"}
          note="Waiting on a human"
          to="/approvals"
          tone={counts.approvals > 0 ? "warning" : undefined}
        />
        <Stat
          label="Blocked"
          value={work.hasData ? counts.blocked : "—"}
          note="Denied or held by policy"
          to="/work?status=blocked"
          tone={counts.blocked > 0 ? "danger" : undefined}
        />
        <Stat
          label="Failed / quarantined"
          value={work.hasData ? counts.failed : "—"}
          note="Need investigation"
          to="/work?attention=1"
          tone={counts.failed > 0 ? "danger" : undefined}
        />
        <Stat
          label="Active leases"
          value={execSummary ? execSummary.activeLeases : executions.error ? "n/a" : "—"}
          note={
            executions.data?.truncated
              ? `Scanned ${executions.data.scanned} of ${executions.data.candidates} recent items`
              : "Worker-owned attempts"
          }
          to="/execution"
        />
      </div>

      <div className="layout-grid">
        <div className="span-7">
          <Card
            title="Needs attention"
            action={<Link to="/work?attention=1">View all</Link>}
            labelledBy="h-attention"
            flush
          >
            {work.hasData && attention.workAttention.length === 0 && attention.agentAttention.length === 0 ? (
              <EmptyState title="Nothing needs attention">
                No approvals, blocked, failed or quarantined work, and no unhealthy agents.
              </EmptyState>
            ) : !work.hasData ? (
              <LoadingState />
            ) : (
              <DataTable
                caption="Items needing operator attention"
                rows={[
                  ...attention.workAttention.map((item) => ({
                    kind: "work" as const,
                    id: item.id,
                    title: item.title,
                    status: item.status,
                    risk: item.risk,
                    at: item.updatedAt
                  })),
                  ...attention.agentAttention.map((agent) => ({
                    kind: "agent" as const,
                    id: agent.id,
                    title: agent.name,
                    status: agent.effectiveStatus,
                    risk: "",
                    at: agent.updatedAt
                  }))
                ]}
                rowKey={(row) => `${row.kind}:${row.id}`}
                columns={[
                  {
                    id: "id",
                    header: "Item",
                    cell: (row) => (
                      <>
                        <span className="cell-primary truncate">{row.title}</span>
                        <span className="cell-sub mono">{row.id}</span>
                      </>
                    )
                  },
                  {
                    id: "state",
                    header: "State",
                    cell: (row) =>
                      row.kind === "work" ? (
                        <StatusBadge status={row.status} />
                      ) : (
                        <Badge
                          meta={{
                            label: `Agent ${row.status.toLowerCase()}`,
                            tone: row.status === "ERROR" ? "danger" : "warning"
                          }}
                        />
                      )
                  },
                  { id: "risk", header: "Risk", cell: (row) => (row.risk ? <RiskBadge risk={row.risk} /> : "—") },
                  { id: "age", header: "Updated", cell: (row) => `${relativeAge(row.at, now)} ago` },
                  {
                    id: "act",
                    header: "",
                    cell: (row) =>
                      row.kind === "work" ? (
                        <Link
                          className="btn"
                          data-size="sm"
                          to={
                            row.status === "needs_approval"
                              ? `/approvals/${encodeURIComponent(row.id)}`
                              : `/work/${encodeURIComponent(row.id)}`
                          }
                        >
                          {row.status === "needs_approval" ? "Review" : "Investigate"}
                        </Link>
                      ) : (
                        <Link className="btn" data-size="sm" to={`/agents/${encodeURIComponent(row.id)}`}>
                          Investigate
                        </Link>
                      )
                  }
                ]}
              />
            )}
          </Card>
        </div>
        <div className="span-5">
          <Card title="System status" action={<Link to="/system">Details</Link>} labelledBy="h-system">
            {health.data ? (
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: "var(--space-2)" }}>
                <li className="row-between">
                  <span>Live (process)</span>
                  {"error" in health.data.livez ? (
                    <Badge meta={{ label: "Unreachable", tone: "danger" }} />
                  ) : (
                    <Badge
                      meta={{
                        label: health.data.livez.ok ? "Live" : "Not live",
                        tone: health.data.livez.ok ? "success" : "danger"
                      }}
                    />
                  )}
                </li>
                <li className="row-between">
                  <span>Ready (dependencies)</span>
                  {"error" in health.data.readyz ? (
                    <Badge meta={{ label: "Unknown", tone: "neutral" }} />
                  ) : (
                    <Badge
                      meta={{
                        label: health.data.readyz.httpStatus === 200 ? "Ready" : "Not ready",
                        tone: health.data.readyz.httpStatus === 200 ? "success" : "danger"
                      }}
                    />
                  )}
                </li>
                <li className="row-between">
                  <span>Event stream</span>
                  <Badge
                    meta={{
                      label: stream.status === "live" ? "Live" : stream.status,
                      tone: stream.status === "live" ? "success" : "warning"
                    }}
                  />
                </li>
                <li className="row-between">
                  <span>Checked</span>
                  <span className="muted">{formatTime(health.data.checkedAt, { seconds: true })}</span>
                </li>
              </ul>
            ) : health.error ? (
              <ErrorState error={health.error} onRetry={health.refetch} />
            ) : (
              <LoadingState />
            )}
          </Card>
        </div>
      </div>

      <Card title="Active executions" action={<Link to="/execution">All executions</Link>} labelledBy="h-active" flush>
        {executions.error && !executions.hasData ? (
          <ErrorState error={executions.error} onRetry={executions.refetch} what="executions" />
        ) : !executions.hasData ? (
          <LoadingState />
        ) : active.length === 0 ? (
          <EmptyState title="No active executions">Nothing is leased or running right now.</EmptyState>
        ) : (
          <DataTable
            caption="Active executions"
            rows={active}
            rowKey={(row) => row.key}
            columns={[
              {
                id: "wi",
                header: "Work item",
                cell: (row) => (
                  <>
                    <Link to={`/execution/${encodeURIComponent(row.workItem.id)}`} className="cell-primary">
                      {row.workItem.title}
                    </Link>
                    <span className="cell-sub mono">{row.workItem.id}</span>
                  </>
                )
              },
              { id: "agent", header: "Worker", cell: (row) => row.attempt?.claimedByWorkerId ?? "—" },
              {
                id: "progress",
                header: "Progress",
                cell: () => (
                  <span className="muted" title="The gateway records attempt state, not percent complete">
                    n/a
                  </span>
                )
              },
              { id: "state", header: "State", cell: (row) => <StatusBadge status={row.workItem.status} /> },
              {
                id: "dur",
                header: "Duration",
                cell: (row) => (row.attempt?.startedAt ? formatDuration(now - Date.parse(row.attempt.startedAt)) : "—")
              }
            ]}
          />
        )}
      </Card>

      <div className="layout-grid">
        <div className="span-5">
          <Card title="Agent roster" action={<Link to="/agents">All agents</Link>} labelledBy="h-roster" flush>
            {!agents.hasData ? (
              agents.error ? (
                <ErrorState error={agents.error} onRetry={agents.refetch} />
              ) : (
                <LoadingState />
              )
            ) : (agents.data ?? []).length === 0 ? (
              <EmptyState title="No agents registered" />
            ) : (
              <DataTable
                caption="Agent roster"
                rows={(agents.data ?? []).slice(0, 8)}
                rowKey={(agent) => agent.id}
                columns={[
                  {
                    id: "n",
                    header: "Agent",
                    cell: (agent) => <Link to={`/agents/${encodeURIComponent(agent.id)}`}>{agent.name}</Link>
                  },
                  { id: "s", header: "Status", cell: (agent) => <Badge meta={livenessMeta(agentLiveness(agent))} /> },
                  { id: "h", header: "Health", cell: (agent) => <Badge meta={agentHealthMeta(agent)} /> }
                ]}
              />
            )}
          </Card>
        </div>
        <div className="span-7">
          <Card title="Recent audit events" action={<Link to="/audit">Open audit</Link>} labelledBy="h-audit" flush>
            {recent.length === 0 ? (
              backfill.error ? (
                <ErrorState error={backfill.error} onRetry={backfill.refetch} />
              ) : backfill.hasData ? (
                <EmptyState title="No audit events yet" />
              ) : (
                <LoadingState />
              )
            ) : (
              <DataTable
                caption="Recent audit events"
                rows={recent}
                rowKey={(event) => event.id}
                columns={[
                  { id: "t", header: "Time", cell: (event) => formatTime(eventTimeMs(event), { seconds: true }) },
                  {
                    id: "e",
                    header: "Event",
                    cell: (event) => (
                      <Link to={`/audit/${encodeURIComponent(event.id)}`} className="mono">
                        {event.name}
                      </Link>
                    )
                  },
                  { id: "a", header: "Actor", cell: (event) => eventActor(event) },
                  {
                    id: "s",
                    header: "Severity",
                    cell: (event) => (
                      <Badge
                        meta={{
                          label: severityFor(event),
                          tone: ({ info: "neutral", notice: "success", warning: "warning", error: "danger" } as const)[
                            severityFor(event)
                          ]
                        }}
                      />
                    )
                  },
                  {
                    id: "m",
                    header: "Summary",
                    cell: (event) => <span className="truncate">{eventSummary(event)}</span>
                  }
                ]}
              />
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
