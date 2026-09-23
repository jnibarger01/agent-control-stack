import { useMemo, useState } from "react";
import { summarizeExecutions } from "../domain/execution";
import { attemptStatusMeta, leaseStatusMeta } from "../domain/status";
import { formatDuration, shortId } from "../domain/format";
import { Link, useRouter } from "../router";
import { useExecutions, useWorkItems } from "../state/data";
import { Badge, Card, EmptyState, ErrorState, LoadingState, PageHead, Stat } from "../components/ui";
import { DataTable } from "../components/DataTable";
import { ExecutionDetailView } from "../components/ExecutionDetail";
import { WorkDetail } from "../components/WorkDetail";
import { Tabs } from "../components/Tabs";

export function ExecutionPage() {
  const { route, go } = useRouter();
  const work = useWorkItems();
  const executions = useExecutions(work.data);
  const now = Date.now();
  const summary = useMemo(
    () => (executions.data ? summarizeExecutions(executions.data.rows) : undefined),
    [executions.data]
  );
  const selected = route.param;
  const detail = selected ? executions.data?.details.get(selected) : undefined;
  const [tab, setTab] = useState("execution");

  return (
    <div className="page" data-testid="page-execution">
      <PageHead title="Execution" description="Plans, admissions, attempts and worker leases." />
      <div className="stat-grid" aria-label="Execution summary">
        <Stat
          label="Running"
          value={summary?.running ?? "—"}
          tone={summary && summary.running > 0 ? "success" : undefined}
        />
        <Stat label="Queued" value={summary?.queued ?? "—"} />
        <Stat label="Completed" value={summary?.completed ?? "—"} />
        <Stat label="Retries" value={summary?.retries ?? "—"} note="Attempts beyond the first" />
        <Stat
          label="Failed"
          value={summary?.failed ?? "—"}
          tone={summary && summary.failed > 0 ? "danger" : undefined}
          note="Failed, interrupted, quarantined, unknown"
        />
        <Stat label="Active leases" value={summary?.activeLeases ?? "—"} />
      </div>
      {executions.data?.truncated && (
        <div className="banner" data-tone="info" role="note">
          <p>
            Showing the {executions.data.scanned} most recently updated of {executions.data.candidates} work items that
            can have attempts. The gateway has no execution-list route, so attempts are read per work item with a
            bounded fan-out.
          </p>
        </div>
      )}
      <div className="split" data-open={selected ? "true" : "false"}>
        <Card title="Executions" labelledBy="h-exec" flush>
          {executions.error && !executions.hasData ? (
            <ErrorState error={executions.error} onRetry={executions.refetch} what="executions" />
          ) : !executions.hasData ? (
            <LoadingState label="Reading attempts and leases…" />
          ) : (
            <DataTable
              caption="Execution attempts"
              rows={executions.data?.rows ?? []}
              rowKey={(row) => row.key}
              selectedKey={
                selected ? executions.data?.rows.find((row) => row.workItem.id === selected)?.key : undefined
              }
              onRowActivate={(row) => go(`/execution/${encodeURIComponent(row.workItem.id)}`)}
              empty={
                <EmptyState title="No execution attempts">
                  Attempts appear here once a work item is approved and claimed by a worker.
                </EmptyState>
              }
              columns={[
                {
                  id: "wi",
                  header: "Work item",
                  cell: (row) => (
                    <>
                      <span className="cell-primary truncate" style={{ display: "block", maxWidth: 240 }}>
                        {row.workItem.title}
                      </span>
                      <span className="cell-sub mono">{row.workItem.id}</span>
                    </>
                  )
                },
                {
                  id: "attempt",
                  header: "Attempt",
                  cell: (row) => (
                    <>
                      <span className="mono" title={row.attempt?.attemptId}>
                        {shortId(row.attempt?.attemptId)}
                      </span>
                      <span className="cell-sub">
                        #{row.attempt?.attemptNumber} · plan {shortId(row.attempt?.planId, 6, 4)}
                      </span>
                    </>
                  )
                },
                { id: "worker", header: "Worker", cell: (row) => row.attempt?.claimedByWorkerId ?? "—" },
                {
                  id: "lease",
                  header: "Lease",
                  cell: (row) =>
                    row.lease ? <Badge meta={leaseStatusMeta(row.lease.status)} /> : <span className="muted">none</span>
                },
                {
                  id: "progress",
                  header: "Progress",
                  cell: () => (
                    <span className="muted" title="The gateway records attempt state, not percent complete">
                      n/a
                    </span>
                  )
                },
                {
                  id: "dur",
                  header: "Duration",
                  cell: (row) =>
                    row.attempt?.startedAt
                      ? formatDuration(
                          (["succeeded", "failed", "cancelled"].includes(row.attempt.status)
                            ? Date.parse(row.attempt.updatedAt)
                            : now) - Date.parse(row.attempt.startedAt)
                        )
                      : "—"
                },
                { id: "retries", header: "Retries", cell: (row) => row.retryCount },
                {
                  id: "status",
                  header: "Status",
                  cell: (row) => (row.attempt ? <Badge meta={attemptStatusMeta(row.attempt.status)} /> : "—")
                }
              ]}
            />
          )}
        </Card>
        {selected && (
          <aside className="card detail" aria-label={`Execution detail ${selected}`}>
            <div className="card-body stack">
              <div className="row-between">
                <h2>
                  Execution · <span className="mono">{selected}</span>
                </h2>
                <button
                  type="button"
                  className="btn"
                  data-size="sm"
                  onClick={() => go("/execution")}
                  aria-label="Close detail"
                >
                  ✕
                </button>
              </div>
              <div className="row">
                <Link to={`/work/${encodeURIComponent(selected)}`}>Open work item</Link>
              </div>
              <Tabs
                tabs={[
                  { id: "execution", label: "Execution" },
                  { id: "work", label: "Work item" }
                ]}
                active={tab}
                onChange={setTab}
                label="Execution sections"
              >
                {tab === "execution" ? (
                  detail ? (
                    <ExecutionDetailView
                      executionPlan={detail.executionPlan}
                      workItemId={selected}
                      attempts={detail.executionAttempts}
                      leases={detail.attemptLeases}
                      events={detail.events}
                      result={detail.workItem.result}
                      now={now}
                    />
                  ) : executions.hasData ? (
                    <EmptyState title="No execution data loaded for this item">
                      It may be outside the scanned window.{" "}
                      <Link to={`/work/${encodeURIComponent(selected)}`}>Open it in the Work Queue.</Link>
                    </EmptyState>
                  ) : (
                    <LoadingState />
                  )
                ) : (
                  <WorkDetail key={selected} id={selected} />
                )}
              </Tabs>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
