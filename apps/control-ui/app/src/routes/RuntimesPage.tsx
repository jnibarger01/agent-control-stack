import { useMemo } from "react";
import { Badge, Card, EmptyState, ErrorState, LoadingState, PageHead, Stat } from "../components/ui";
import { DataTable } from "../components/DataTable";
import { formatTime } from "../domain/format";
import { useRuntimeObservability } from "../state/data";

function healthMeta(status: string) {
  if (status === "healthy") return { label: "Healthy", tone: "success" as const };
  if (status === "degraded") return { label: "Degraded", tone: "warning" as const };
  if (status === "unhealthy" || status === "unavailable") return { label: status, tone: "danger" as const };
  return { label: status || "unknown", tone: "muted" as const };
}
function runtimeLabel(kind: string) {
  return kind === "openclaw" ? "OpenClaw" : kind === "opencode" ? "OpenCode" : kind[0]!.toUpperCase() + kind.slice(1);
}

export function RuntimesPage() {
  const query = useRuntimeObservability();
  const rows = query.data?.runtimes ?? [];
  const summary = useMemo(() => ({
    healthy: rows.filter((r) => r.health === "healthy").length,
    available: rows.filter((r) => r.available).length,
    agents: rows.reduce((n, r) => n + r.agents.length, 0),
    gated: rows.reduce((n, r) => n + r.approvalGatedCapabilities, 0)
  }), [rows]);

  return <div className="page" data-testid="page-runtimes">
    <PageHead title="Runtime Map" description="Read-only runtime telemetry from Visualizer. ACS remains the execution and approval authority." />
    <div className="stat-grid" aria-label="Runtime summary">
      <Stat label="Available runtimes" value={query.hasData ? summary.available + " / " + rows.length : "—"} />
      <Stat label="Healthy runtimes" value={query.hasData ? summary.healthy : "—"} tone={summary.healthy === rows.length && rows.length ? "success" : undefined} />
      <Stat label="Observed agents" value={query.hasData ? summary.agents : "—"} />
      <Stat label="Approval-gated capabilities" value={query.hasData ? summary.gated : "—"} tone={summary.gated ? "warning" : undefined} />
    </div>
    <Card title="Authority topology" labelledBy="h-runtime-topology">
      {query.error && !query.hasData ? <ErrorState error={query.error} onRetry={query.refetch} what="runtime observability" />
      : !query.hasData ? <LoadingState label="Reading runtime topology…" />
      : <div className="runtime-topology" role="img" aria-label="Mission Control observes runtimes through Visualizer while ACS retains authority">
          <div className="runtime-topology-node runtime-topology-node--ui"><strong>Mission Control</strong><span>Operator surface</span></div>
          <div className="runtime-topology-arrow" aria-hidden="true">↓</div>
          <div className="runtime-topology-node runtime-topology-node--authority"><strong>ACS Authority</strong><span>Policy · approvals · capabilities · leases</span></div>
          <div className="runtime-topology-arrow" aria-hidden="true">↕ read-only telemetry</div>
          <div className="runtime-topology-node"><strong>Visualizer</strong><span>Loopback discovery · metadata only</span></div>
          <div className="runtime-topology-grid">
            {rows.map((r) => <div className="runtime-node" key={r.kind}>
              <span className="dot" data-tone={healthMeta(r.health).tone} /><strong>{runtimeLabel(r.kind)}</strong>
              <span>{r.agents.length} agents · {r.capabilities.length} capabilities</span>
            </div>)}
          </div>
        </div>}
    </Card>
    <Card title="Runtime inventory" labelledBy="h-runtime-inventory" flush>
      {!query.hasData ? <LoadingState /> : rows.length === 0 ? <EmptyState title="No runtime telemetry" /> :
        <DataTable caption="Runtime inventory" rows={rows} rowKey={(r) => r.kind} columns={[
          { id: "runtime", header: "Runtime", cell: (r) => <><span className="cell-primary">{runtimeLabel(r.kind)}</span><span className="cell-sub mono">{r.version ?? "version unknown"}</span></> },
          { id: "health", header: "Health", cell: (r) => <Badge meta={healthMeta(r.health)} title={r.reason} /> },
          { id: "ready", header: "Readiness", cell: (r) => r.readiness.replaceAll("_", " ") },
          { id: "agents", header: "Agents", cell: (r) => r.agents.length },
          { id: "inventory", header: "Inventory", cell: (r) => r.inventoryStatus },
          { id: "caps", header: "Capabilities", cell: (r) => r.capabilities.length ? r.capabilities.join(", ") : "—" },
          { id: "gated", header: "Gated", cell: (r) => r.approvalGatedCapabilities },
          { id: "latency", header: "Health latency", cell: (r) => r.latencyMs === null ? "—" : r.latencyMs + " ms" }
        ]} />}
    </Card>
    {query.data && <p className="hint">Visualizer observation: {formatTime(query.data.generatedAt, { seconds: true })}. Governed actions continue through ACS work items.</p>}
  </div>;
}
