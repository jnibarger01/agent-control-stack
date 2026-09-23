import { useMemo, useState } from "react";
import type { RegistryAgentView } from "../api/types";
import type { ExecutionRow } from "../domain/execution";
import { agentHealthMeta, agentLiveness, livenessMeta } from "../domain/status";
import { formatTime, relativeAge } from "../domain/format";
import { Link, useRouter } from "../router";
import { useAgentDetail, useExecutions, useProjectedActors, useRegistryAgents, useWorkItems } from "../state/data";
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  JsonView,
  KV,
  LoadingState,
  MissingContract,
  PageHead,
  Stat
} from "../components/ui";
import { DataTable } from "../components/DataTable";
import { Tabs } from "../components/Tabs";
import { EventTimeline } from "../components/EventTimeline";
import { RegisterAgentDialog } from "../components/RegisterAgentDialog";

export function AgentsPage() {
  const { route, go } = useRouter();
  const agents = useRegistryAgents();
  const actors = useProjectedActors();
  const work = useWorkItems();
  const executions = useExecutions(work.data);
  const now = Date.now();
  const [registering, setRegistering] = useState(false);
  const list = agents.data ?? [];

  const summary = useMemo(() => {
    const counts = { online: 0, stale: 0, offline: 0, unhealthy: 0 };
    for (const agent of list) {
      const live = agentLiveness(agent);
      if (live === "online") counts.online += 1;
      else if (live === "stale") counts.stale += 1;
      else if (live === "offline") counts.offline += 1;
      if (agentHealthMeta(agent).tone === "danger") counts.unhealthy += 1;
    }
    return counts;
  }, [list]);

  const currentWork = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of executions.data?.rows ?? []) {
      const worker = row.attempt?.claimedByWorkerId;
      if (worker && row.attempt && ["leased", "running", "cancellation_requested"].includes(row.attempt.status))
        map.set(worker, row.workItem.id);
    }
    return map;
  }, [executions.data]);
  const lastEvent = useMemo(
    () => new Map((actors.data ?? []).map((actor) => [actor.id, actor.lastEventAt] as const)),
    [actors.data]
  );
  const selected = route.param;

  return (
    <div className="page" data-testid="page-agents">
      <PageHead
        title="Agents"
        description="Registered agents. Liveness follows the ACS heartbeat TTL — an agent is never “online” merely because it exists."
        actions={
          <button type="button" className="btn" data-variant="primary" onClick={() => setRegistering(true)}>
            Register agent
          </button>
        }
      />
      <RegisterAgentDialog open={registering} onClose={() => setRegistering(false)} />
      <div className="stat-grid">
        <Stat label="Total" value={agents.hasData ? list.length : "—"} />
        <Stat
          label="Online"
          value={agents.hasData ? summary.online : "—"}
          tone={summary.online > 0 ? "success" : undefined}
        />
        <Stat
          label="Stale"
          value={agents.hasData ? summary.stale : "—"}
          tone={summary.stale > 0 ? "warning" : undefined}
        />
        <Stat label="Offline" value={agents.hasData ? summary.offline : "—"} />
        <Stat
          label="Unhealthy"
          value={agents.hasData ? summary.unhealthy : "—"}
          tone={summary.unhealthy > 0 ? "danger" : undefined}
        />
      </div>
      <div className="split" data-open={selected ? "true" : "false"}>
        <Card title="Agent registry" labelledBy="h-agents" flush>
          {agents.error && !agents.hasData ? (
            <ErrorState error={agents.error} onRetry={agents.refetch} what="agents" />
          ) : !agents.hasData ? (
            <LoadingState />
          ) : (
            <DataTable
              caption="Registered agents"
              rows={list}
              rowKey={(agent) => agent.id}
              selectedKey={selected}
              onRowActivate={(agent) => go(`/agents/${encodeURIComponent(agent.id)}`)}
              empty={
                <EmptyState title="No agents registered">
                  Use Register agent to add an agent with its ID and ACP role. A fresh heartbeat is required before it
                  appears online.
                </EmptyState>
              }
              columns={[
                {
                  id: "n",
                  header: "Agent",
                  cell: (agent) => (
                    <>
                      <span className="cell-primary">{agent.name}</span>
                      <span className="cell-sub mono">{agent.id}</span>
                    </>
                  )
                },
                { id: "k", header: "Type", cell: (agent) => `${agent.kind} · ${agent.acpRole}` },
                { id: "s", header: "Status", cell: (agent) => <Badge meta={livenessMeta(agentLiveness(agent))} /> },
                { id: "h", header: "Health", cell: (agent) => <Badge meta={agentHealthMeta(agent)} /> },
                {
                  id: "c",
                  header: "Capabilities",
                  cell: (agent) =>
                    agent.capabilities.length
                      ? `${agent.capabilities
                          .slice(0, 3)
                          .map((c) => c.name)
                          .join(", ")}${agent.capabilities.length > 3 ? ` +${agent.capabilities.length - 3}` : ""}`
                      : "—"
                },
                {
                  id: "w",
                  header: "Current work",
                  cell: (agent) =>
                    currentWork.get(agent.id) ? (
                      <Link to={`/work/${encodeURIComponent(currentWork.get(agent.id)!)}`}>
                        {currentWork.get(agent.id)}
                      </Link>
                    ) : (
                      "—"
                    )
                },
                {
                  id: "hb",
                  header: "Heartbeat",
                  cell: (agent) => (agent.lastHeartbeatAt ? `${relativeAge(agent.lastHeartbeatAt, now)} ago` : "never")
                },
                {
                  id: "e",
                  header: "Last event",
                  cell: (agent) => (lastEvent.get(agent.id) ? `${relativeAge(lastEvent.get(agent.id), now)} ago` : "—")
                },
                { id: "v", header: "Version", cell: (agent) => agent.model ?? agent.provider ?? "—" },
                {
                  id: "err",
                  header: "Last error",
                  cell: (agent) => (
                    <span className="truncate" style={{ display: "block", maxWidth: 200 }}>
                      {agent.lastError ?? "—"}
                    </span>
                  )
                }
              ]}
            />
          )}
        </Card>
        {selected && (
          <aside className="card detail" aria-label={`Agent ${selected}`}>
            <div className="card-body">
              <AgentDetail
                key={selected}
                id={selected}
                current={currentWork.get(selected)}
                recentWork={(executions.data?.rows ?? []).filter((row) => row.attempt?.claimedByWorkerId === selected)}
                onClose={() => go("/agents")}
              />
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "capabilities", label: "Capabilities" },
  { id: "work", label: "Recent work" },
  { id: "events", label: "Recent events" },
  { id: "raw", label: "Raw JSON" }
] as const;

function AgentDetail({
  id,
  current,
  recentWork,
  onClose
}: {
  id: string;
  current: string | undefined;
  recentWork: ExecutionRow[];
  onClose: () => void;
}) {
  const query = useAgentDetail(id);
  const [tab, setTab] = useState("overview");
  if (query.error && !query.hasData)
    return <ErrorState error={query.error} onRetry={query.refetch} what={`agent ${id}`} />;
  if (!query.hasData || !query.data) return <LoadingState />;
  const { agent, capabilities, events, adapterStatus } = query.data;
  if (agent.id !== id) return <LoadingState />;
  const now = Date.now();
  return (
    <div className="stack" data-testid="agent-detail">
      <div className="detail-head">
        <div style={{ minWidth: 0 }}>
          <h2>{agent.name}</h2>
          <span className="mono muted">{agent.id}</span>
        </div>
        <div className="row">
          <Badge meta={livenessMeta(agentLiveness(agent))} />
          <Badge meta={agentHealthMeta(agent)} />
          <button type="button" className="btn" data-size="sm" onClick={onClose} aria-label="Close detail">
            ✕
          </button>
        </div>
      </div>
      <Tabs tabs={TABS} active={tab} onChange={setTab} label="Agent sections">
        {tab === "overview" && (
          <div className="stack">
            <KV
              items={[
                ["Kind", agent.kind],
                ["ACP role", agent.acpRole],
                ["Registry status", agent.status],
                ["Effective status", agent.effectiveStatus],
                ["Provider / model", [agent.provider, agent.model].filter(Boolean).join(" / ") || "—"],
                ["Endpoint", agent.endpoint ?? "—"],
                [
                  "Last heartbeat",
                  agent.lastHeartbeatAt
                    ? `${formatTime(agent.lastHeartbeatAt, { seconds: true })} (${relativeAge(agent.lastHeartbeatAt, now)} ago)`
                    : "never"
                ],
                ["Registered", formatTime(agent.createdAt)],
                ["Updated", formatTime(agent.updatedAt)],
                [
                  "Current work",
                  current ? (
                    <Link key="w" to={`/work/${encodeURIComponent(current)}`}>
                      {current}
                    </Link>
                  ) : (
                    "—"
                  )
                ],
                ["Last error", agent.lastError ?? "—"]
              ]}
            />
            <MissingContract
              what="Heartbeat history"
              detail="The gateway serves only the latest heartbeat per agent; there is no route for heartbeat history."
            />
            {adapterStatus !== undefined && adapterStatus !== null && (
              <div className="section">
                <h3 className="eyebrow">Adapter status</h3>
                <JsonView value={adapterStatus} label="Adapter status" />
              </div>
            )}
          </div>
        )}
        {tab === "capabilities" &&
          (capabilities.length === 0 ? (
            <p className="muted">No capabilities registered.</p>
          ) : (
            <DataTable
              caption="Agent capabilities"
              rows={capabilities}
              rowKey={(capability) => capability.name}
              columns={[
                {
                  id: "n",
                  header: "Capability",
                  cell: (capability) => <span className="mono">{capability.name}</span>
                },
                { id: "d", header: "Description", cell: (capability) => capability.description ?? "—" }
              ]}
            />
          ))}
        {tab === "work" &&
          (recentWork.length === 0 ? (
            <p className="muted">No recent attempts claimed by this agent in the scanned window.</p>
          ) : (
            <DataTable
              caption="Recent work claimed by this agent"
              rows={recentWork}
              rowKey={(row) => row.key}
              columns={[
                {
                  id: "w",
                  header: "Work item",
                  cell: (row) => <Link to={`/work/${encodeURIComponent(row.workItem.id)}`}>{row.workItem.title}</Link>
                },
                { id: "s", header: "Attempt", cell: (row) => row.attempt?.status ?? "—" },
                { id: "n", header: "#", cell: (row) => row.attempt?.attemptNumber ?? "—" }
              ]}
            />
          ))}
        {tab === "events" && <EventTimeline events={events} />}
        {tab === "raw" && <JsonView value={agent satisfies RegistryAgentView} label="Raw agent JSON" />}
      </Tabs>
    </div>
  );
}
