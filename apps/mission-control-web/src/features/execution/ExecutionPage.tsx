import { Link } from "react-router";
import { controlOffered, type ExecutionAttemptRow, type ExecutionReadModel } from "@agent-control-stack/mission-control-contract";
import { formatDuration, relativeTime } from "../../design/format";
import { Card, DataTable, EmptyState, Stat, StatusPill, type Tone } from "../../design/primitives";
import { useControlGate, useWorkItemActions, type ActionSpec } from "../actions/actions";
import { TelemetryPanel } from "../command/sections";

const ATTEMPT_TONE: Record<string, Tone> = { succeeded: "ok", running: "info", leased: "info", pending: "neutral", failed: "bad", quarantined: "bad", interrupted: "bad", unknown: "unknown", cancelled: "neutral", cancellation_requested: "warn" };

function Controls({ row, latest, viewer, open }: { row: ExecutionAttemptRow; latest: boolean; viewer: ExecutionReadModel["viewer"]; open: (s: ActionSpec) => void }) {
  const gate = useControlGate(viewer.canWrite, "write");
  const base = { workItemId: row.workItemId, title: row.title, risk: row.risk };
  // Retry is a work-item control: the canonical work-item status decides (succeeded, failed, cancelled, rejected all
  // qualify). It is offered once per work item, on its latest attempt, rather than on every historical attempt.
  const retry = latest && controlOffered("retry", row.workItemStatus);
  const cancel = controlOffered("cancel", row.workItemStatus) && ["running", "leased", "pending"].includes(row.status);
  if (!retry && !cancel) return <span className="text-xs text-muted">none</span>;
  return (
    <div className="flex flex-col items-start gap-1">
      <div className="flex gap-2">
        {retry && <button type="button" disabled={gate.disabled} onClick={() => open({ ...base, kind: "retry" })} aria-label={`Retry ${row.title}`} className="rounded-ctl border border-line px-2.5 py-1 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50">Retry</button>}
        {cancel && <button type="button" disabled={gate.disabled} onClick={() => open({ ...base, kind: "cancel" })} aria-label={`Cancel ${row.title}`} className="rounded-ctl border border-bad/50 px-2.5 py-1 text-xs font-medium text-bad disabled:cursor-not-allowed disabled:opacity-50">Cancel</button>}
      </div>
      {gate.why && <span className="max-w-48 text-[11px] text-muted">{gate.why}</span>}
    </div>
  );
}

export function ExecutionPage({ data }: { data: ExecutionReadModel }) {
  const { open, element } = useWorkItemActions();
  const latestAttempt = new Map<string, number>();
  for (const a of data.attempts) latestAttempt.set(a.workItemId, Math.max(latestAttempt.get(a.workItemId) ?? 0, a.attemptNumber));
  return (
    <div className="space-y-6">
      {element}
      {data.dryRun === "yes" && <p role="note" className="rounded-ctl border border-warn/40 bg-warn-soft px-4 py-2 text-sm text-warn">Dry run: attempts below are simulated. No real commands ran.</p>}
      {data.dryRun === "unknown" && <p role="note" className="rounded-ctl border border-dashed border-line-strong px-4 py-2 text-sm text-muted">The execution backend is unknown, so these attempts are not labelled as real or simulated.</p>}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Running" value={data.summary.running} />
        <Stat label="Failed" value={data.summary.failed} tone={data.summary.failed ? "bad" : "neutral"} />
        <Stat label="Needs attention" value={data.summary.attention} tone={data.summary.attention ? "bad" : "neutral"} note="Unknown, quarantined, interrupted or cancelling" />
        <Stat label="Leases expiring" value={data.summary.expiringLeases} tone={data.summary.expiringLeases ? "warn" : "neutral"} note="Warning only. Not authority." />
      </div>
      <Card title="Attempts" subtitle="Latest first. Retries are new attempts with their own fencing epoch.">
        {data.attempts.length === 0 ? (
          <EmptyState title="No execution attempts yet">Attempts appear once an admitted plan starts running.</EmptyState>
        ) : (
          <DataTable
            caption="Execution attempts"
            rows={data.attempts}
            rowKey={(r) => r.attemptId}
            columns={[
              { key: "item", header: "Work item", render: (r) => <Link to={`/queue/${encodeURIComponent(r.workItemId)}`} className="font-medium hover:text-accent hover:underline">{r.title}</Link> },
              { key: "n", header: "Attempt", render: (r) => `#${r.attemptNumber}` },
              { key: "status", header: "Status", render: (r) => <StatusPill tone={ATTEMPT_TONE[r.status] ?? "neutral"}>{r.status.replace(/_/g, " ")}</StatusPill> },
              { key: "worker", header: "Worker · epoch", render: (r) => <span className="text-xs">{r.workerId ?? <span className="text-muted">unclaimed</span>} · {r.fencingEpoch}</span> },
              {
                key: "lease",
                header: "Lease",
                render: (r) =>
                  r.lease ? (
                    <span className="flex flex-col items-start gap-1 text-xs">
                      <StatusPill tone={r.lease.status === "active" ? "info" : r.lease.status === "consumed" ? "ok" : "warn"}>{r.lease.status}</StatusPill>
                      <span className="text-muted">expires {relativeTime(r.lease.expiresAt)}</span>
                      {r.lease.expiringSoon && <StatusPill tone="warn">expiring soon · warning only</StatusPill>}
                    </span>
                  ) : <span className="text-xs text-muted">none</span>
              },
              { key: "dur", header: "Duration", render: (r) => <span className="text-xs">{r.durationMs !== undefined ? formatDuration(r.durationMs) : r.startedAt ? `started ${relativeTime(r.startedAt)}` : "not started"}</span> },
              { key: "controls", header: "Controls", render: (r) => <Controls row={r} latest={latestAttempt.get(r.workItemId) === r.attemptNumber} viewer={data.viewer} open={open} /> }
            ]}
          />
        )}
      </Card>
      <Card title="Throughput and capacity" subtitle="Persisted attempt telemetry over a rolling 24-hour window."><TelemetryPanel telemetry={data.telemetry} admission={data.admission} /></Card>
    </div>
  );
}
