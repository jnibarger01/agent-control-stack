import { useMemo } from "react";
import { Link, useSearchParams } from "react-router";
import type { QueueItem, QueueReadModel } from "@agent-control-stack/mission-control-contract";
import { Card, DataTable, EmptyState, IdChip, StatusPill, type Tone } from "../../design/primitives";
import { relativeTime } from "../../design/format";

const STATUS_TONE: Record<string, Tone> = { running: "info", needs_approval: "warn", approved: "accent", succeeded: "ok", failed: "bad", blocked: "bad", quarantined: "bad", rejected: "bad", cancelled: "neutral", unknown: "unknown" };
const RISK_TONE = (risk: string): Tone => (risk === "high" || risk === "critical" ? "bad" : risk === "medium" ? "warn" : "neutral");

export function filterQueue(items: QueueItem[], f: { status: string; risk: string; q: string }): QueueItem[] {
  const q = f.q.trim().toLowerCase();
  return items.filter(
    (i) =>
      (!f.status || i.status === f.status) &&
      (!f.risk || i.risk === f.risk) &&
      (!q || `${i.title} ${i.intent} ${i.id}`.toLowerCase().includes(q))
  );
}

function planPill(item: QueueItem) {
  switch (item.plan.state) {
    case "admitted":
      return <StatusPill tone="ok">Admitted{item.plan.requiresApproval ? " · needs approval" : ""}</StatusPill>;
    case "drafted":
      return <StatusPill tone="warn">Plan not admitted</StatusPill>;
    case "none":
      return <StatusPill tone="neutral">No plan</StatusPill>;
    default:
      return <StatusPill tone="unknown">Plan unknown</StatusPill>;
  }
}

export function QueuePage({ data }: { data: QueueReadModel }) {
  const [params, setParams] = useSearchParams();
  const filter = { status: params.get("status") ?? "", risk: params.get("risk") ?? "", q: params.get("q") ?? "" };
  const set = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };
  const { status, risk, q } = filter;
  const rows = useMemo(() => filterQueue(data.items, { status, risk, q }), [data.items, status, risk, q]);
  const statuses = Object.entries(data.counts.byStatus).filter(([, n]) => n > 0).sort(([a], [b]) => a.localeCompare(b));
  const risks = [...new Set(data.items.map((i) => i.risk))].sort();

  return (
    <div className="space-y-6">
      <Card title="Work queue" subtitle={`${data.items.length} item${data.items.length === 1 ? "" : "s"} loaded. Status totals come from the ${data.counts.source === "store" ? "store (exact)" : "loaded window only"}. Search and filters apply to the loaded items.${data.finishedWindow ? ` Finished work shows the latest ${data.finishedWindow.shown} of ${data.finishedWindow.total}.` : ""}`}>
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by status">
          <button type="button" aria-pressed={!filter.status} onClick={() => set("status", "")} className="rounded-full border border-line px-3 py-1 text-xs text-muted hover:text-ink aria-pressed:border-accent aria-pressed:bg-accent-soft aria-pressed:text-ink">All</button>
          {statuses.map(([status, n]) => (
            <button key={status} type="button" aria-pressed={filter.status === status} onClick={() => set("status", filter.status === status ? "" : status)} className="rounded-full border border-line px-3 py-1 text-xs text-muted hover:text-ink aria-pressed:border-accent aria-pressed:bg-accent-soft aria-pressed:text-ink">
              {status.replace(/_/g, " ")} <span className="tabular-nums">{n}</span>
            </button>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="flex min-w-56 flex-1 flex-col gap-1 text-xs text-muted">
            Search loaded items
            <input type="search" value={filter.q} onChange={(e) => set("q", e.target.value)} placeholder="Title, intent or identifier" className="rounded-ctl border border-line bg-surface-2 px-3 py-2 text-sm text-ink placeholder:text-faint" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted">
            Risk
            <select value={filter.risk} onChange={(e) => set("risk", e.target.value)} className="rounded-ctl border border-line bg-surface-2 px-3 py-2 text-sm text-ink">
              <option value="">Any</option>
              {risks.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
        </div>
      </Card>

      <Card>
        {rows.length === 0 ? (
          <EmptyState title={data.items.length === 0 ? "No work items yet" : "No loaded item matches these filters"}>{data.items.length === 0 ? "Create work in the classic console; it appears here live." : "Clear a filter to see more."}</EmptyState>
        ) : (
          <>
            <p className="mb-2 text-xs text-muted" role="status">Showing {rows.length} of {data.items.length} loaded.</p>
            <DataTable
              caption="Work items"
              rows={rows}
              rowKey={(i) => i.id}
              columns={[
                {
                  key: "item",
                  header: "Work item",
                  render: (i) => (
                    <div className="min-w-56 max-w-md">
                      <Link to={`/queue/${encodeURIComponent(i.id)}`} className="font-medium text-ink hover:text-accent hover:underline">{i.title}</Link>
                      <p className="mt-0.5 line-clamp-1 text-xs text-muted">{i.intent}</p>
                      <div className="mt-1 flex items-center gap-2">
                        <IdChip id={i.id} />
                        {i.lineage?.retrySequence ? <span className="text-xs text-muted">retry #{i.lineage.retrySequence}</span> : null}
                      </div>
                    </div>
                  )
                },
                { key: "stage", header: "Stage", render: (i) => <StatusPill tone={STATUS_TONE[i.status] ?? "neutral"}>{i.stageLabel}</StatusPill> },
                { key: "risk", header: "Risk", render: (i) => <StatusPill tone={RISK_TONE(i.risk)} glyph="◆">{i.risk}</StatusPill> },
                { key: "plan", header: "Plan", render: planPill },
                {
                  key: "exec",
                  header: "Execution",
                  render: (i) =>
                    i.attempt ? (
                      <span className="text-xs">
                        Attempt #{i.attempt.number} <span className="text-muted">{i.attempt.status.replace(/_/g, " ")}</span>
                        {i.lease ? <span className="block text-muted">epoch {i.lease.fencingEpoch} · {i.lease.workerId}</span> : null}
                      </span>
                    ) : (
                      <span className="text-xs text-muted">none</span>
                    )
                },
                { key: "updated", header: "Updated", render: (i) => <time dateTime={i.updatedAt} className="whitespace-nowrap text-xs text-muted">{relativeTime(i.updatedAt)}</time> }
              ]}
            />
          </>
        )}
      </Card>
    </div>
  );
}
