import { useEffect, useRef, useState } from "react";
import { counterDeltas, sumWhere, type CounterPoint } from "../domain/metrics";
import { formatCount, formatPercent } from "../domain/format";
import { useMetrics, useWorkItems } from "../state/data";
import { Card, EmptyState, ErrorState, LoadingState, MissingContract, PageHead, Stat } from "../components/ui";
import { BarChart } from "../components/charts";
import { DataTable } from "../components/DataTable";

/** How many in-tab samples of cumulative counters to keep (one per refresh). */
const MAX_SAMPLES = 60;

/**
 * Only real metrics. The gateway keeps process-local cumulative counters and no
 * history, so time-series here are deltas between samples THIS TAB took; the
 * chart says so and starts empty rather than back-filling.
 */
export function MetricsPage() {
  const metrics = useMetrics();
  const work = useWorkItems();
  const history = useRef<{ requests: CounterPoint[]; events: CounterPoint[]; r429: CounterPoint[] }>({
    requests: [],
    events: [],
    r429: []
  });
  const [, bump] = useState(0);

  useEffect(() => {
    const data = metrics.data;
    if (!data) return;
    const last = history.current.requests.at(-1);
    if (last && last.at === data.fetchedAt) return;
    const push = (list: CounterPoint[], value: number) => {
      list.push({ at: data.fetchedAt, value });
      if (list.length > MAX_SAMPLES) list.shift();
    };
    push(history.current.requests, data.summary.requestsTotal);
    push(history.current.events, data.summary.auditEventsTotal);
    push(history.current.r429, data.summary.requests429);
    bump((n) => n + 1);
  }, [metrics.data]);

  // Sample periodically while the page is open; cheap (one GET /metrics per 15s) and stops on unmount.
  useEffect(() => {
    const timer = setInterval(() => metrics.refetch(), 15_000);
    return () => clearInterval(timer);
  }, [metrics.refetch]);

  const s = metrics.data?.summary;
  const items = work.data ?? [];
  const pending = items.filter((i) => i.status === "needs_approval");
  const oldestPending = pending.map((i) => Date.parse(i.updatedAt)).sort((a, b) => a - b)[0];
  const label = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour12: false });
  const series = (points: CounterPoint[]) => counterDeltas(points).map((d) => ({ label: label(d.at), value: d.delta }));
  const successRate =
    s && s.executionsSucceeded + s.executionsFailed > 0
      ? s.executionsSucceeded / (s.executionsSucceeded + s.executionsFailed)
      : undefined;

  if (metrics.error && !metrics.hasData)
    return <ErrorState error={metrics.error} onRetry={metrics.refetch} what="metrics" />;

  return (
    <div className="page" data-testid="page-metrics">
      <PageHead
        title="Metrics"
        description="Process-local counters from the gateway's /metrics endpoint. They reset when the gateway restarts."
        actions={
          <button type="button" className="btn" onClick={metrics.refetch} disabled={metrics.isFetching}>
            {metrics.isFetching ? "Refreshing…" : "Refresh"}
          </button>
        }
      />
      {!s ? (
        <LoadingState />
      ) : (
        <>
          <div className="stat-grid">
            <Stat
              label="Queue depth"
              value={items.filter((i) => ["pending_policy", "needs_approval", "approved"].includes(i.status)).length}
              note="Pending policy, approval or claim"
            />
            <Stat
              label="Pending approvals"
              value={pending.length}
              note={
                oldestPending
                  ? `Oldest since ${new Date(oldestPending).toLocaleString(undefined, { hour12: false })}`
                  : "None waiting"
              }
              tone={pending.length ? "warning" : undefined}
            />
            <Stat
              label="HTTP 429 (rate limited)"
              value={formatCount(s.requests429)}
              tone={s.requests429 ? "warning" : undefined}
              note={`${formatCount(s.rateLimitRejected)} limiter rejections`}
            />
            <Stat label="HTTP 5xx" value={formatCount(s.requests5xx)} tone={s.requests5xx ? "danger" : undefined} />
            <Stat
              label="Approval grants"
              value={formatCount(s.approvalsGranted)}
              note={`${formatCount(s.approvalsConsumed)} consumed`}
            />
            <Stat
              label="Execution success rate"
              value={successRate === undefined ? "—" : formatPercent(successRate)}
              note={
                successRate === undefined
                  ? "No completed executions counted"
                  : `${formatCount(s.executionsSucceeded)} ok / ${formatCount(s.executionsFailed)} failed`
              }
            />
            <Stat label="Attempts created" value={formatCount(s.attemptsCreated)} />
            <Stat
              label="Lease renewals / expiries"
              value={`${formatCount(s.leasesRenewed)} / ${formatCount(s.leasesExpired)}`}
            />
            <Stat
              label="Avg request latency"
              value={s.avgLatencySeconds === undefined ? "—" : `${(s.avgLatencySeconds * 1000).toFixed(1)} ms`}
            />
            <Stat
              label="SSE dropped / rejected"
              value={`${formatCount(s.sseDropped)} / ${formatCount(s.sseRejected)}`}
            />
          </div>
          <div className="layout-grid">
            <div className="span-6">
              <Card title="Event throughput (this tab's samples)" labelledBy="h-thr">
                <BarChart
                  title="Audit events per sample interval"
                  points={series(history.current.events)}
                  emptyMessage="Collecting samples — the chart fills as this tab observes the counter change. No history is fabricated."
                />
              </Card>
            </div>
            <div className="span-6">
              <Card title="Request volume (this tab's samples)" labelledBy="h-req">
                <BarChart
                  title="HTTP requests per sample interval"
                  points={series(history.current.requests)}
                  emptyMessage="Collecting samples — no server-side history exists."
                />
              </Card>
            </div>
            <div className="span-6">
              <Card title="Rate limiting: HTTP 429 (this tab's samples)" labelledBy="h-429">
                <BarChart
                  title="429 responses per sample interval"
                  points={series(history.current.r429)}
                  emptyMessage="No 429 responses observed in this session."
                />
              </Card>
            </div>
            <div className="span-6">
              <Card title="Requests by route" labelledBy="h-routes" flush>
                {s.topRoutes.length === 0 ? (
                  <EmptyState title="No requests counted yet" />
                ) : (
                  <DataTable
                    caption="Top routes by request count"
                    rows={s.topRoutes}
                    rowKey={(r) => r.route}
                    columns={[
                      { id: "r", header: "Route", cell: (r) => <span className="mono">{r.route}</span> },
                      { id: "c", header: "Requests", cell: (r) => formatCount(r.count) }
                    ]}
                  />
                )}
              </Card>
            </div>
          </div>
          <MissingContract
            what="Approval wait, oldest lease age, retry and per-execution throughput series"
            detail="The gateway exports no gauges or histograms for these. Queue depth and pending approvals above are computed from live work-item state; lease and retry figures come from audit counters. Time-series shown are sampled by this browser tab, not stored by ACS."
          />
          <p className="hint">
            Total audit events appended: {formatCount(sumWhere(metrics.data?.samples ?? [], "acs_audit_events_total"))}.
            SQLite ready: {s.sqliteReady === undefined ? "unknown" : s.sqliteReady ? "yes" : "no"}.
          </p>
        </>
      )}
    </div>
  );
}
