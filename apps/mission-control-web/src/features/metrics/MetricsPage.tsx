import type { OverviewReadModel } from "@agent-control-stack/mission-control-contract";
import { clockTime, formatDuration, percent } from "../../design/format";
import { Card, DataTable, EmptyState, Stat, Unavailable } from "../../design/primitives";
import { TelemetryPanel } from "../command/sections";

export function MetricsPage({ data }: { data: OverviewReadModel }) {
  const t = data.observability.telemetry;
  const settled = t ? t.succeeded + t.failed : 0;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Succeeded (24h)" value={t ? t.succeeded : "unknown"} tone="ok" />
        <Stat label="Failed (24h)" value={t ? t.failed : "unknown"} tone={t && t.failed ? "bad" : "neutral"} />
        <Stat label="Success rate" value={t ? percent(t.succeeded, settled) : "unknown"} note="Cancelled and interrupted attempts are excluded" />
        <Stat label="Avg run time" value={t ? formatDuration(t.averageRunMs) : "unknown"} />
      </div>
      {data.sections.observability.status !== "ok" ? (
        <Unavailable what="Telemetry" {...(data.sections.observability.reason ? { reason: data.sections.observability.reason } : {})} />
      ) : (
        <Card title="Throughput and capacity" subtitle="Persisted attempt telemetry over a rolling 24-hour window."><TelemetryPanel telemetry={t} admission={data.observability.admission} hiddenTable={false} /></Card>
      )}
      <Card title="Hourly numbers" subtitle="The same data as the chart, as an accessible table.">
        {!t || t.throughput.length === 0 ? <EmptyState title="No telemetry window available" /> : (
          <DataTable caption="Hourly attempts" rows={t.throughput} rowKey={(b) => b.at} columns={[
            { key: "h", header: "Hour", render: (b) => <time dateTime={b.at}>{clockTime(b.at)}</time> },
            { key: "s", header: "Started", render: (b) => b.started },
            { key: "c", header: "Completed", render: (b) => b.completed },
            { key: "f", header: "Failed", render: (b) => b.failed }
          ]} />
        )}
      </Card>
      <Card title="What is not measured">
        <p className="text-sm text-muted">ACS does not persist cost, CPU, memory, per-executor capacity or completion percentages, so none are shown. Approval latency appears only when approvals were granted in the window ({t?.approvalsGranted === undefined ? "unknown" : t.approvalsGranted} granted).</p>
      </Card>
    </div>
  );
}
