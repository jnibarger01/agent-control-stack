import { useMemo, useState } from "react";
import { requiredApprovals } from "../domain/approvals";
import { relativeAge } from "../domain/format";
import { workItemTargetLabel } from "../domain/filters";
import { useRouter } from "../router";
import { useEventBackfill, useWorkItems } from "../state/data";
import { Card, EmptyState, ErrorState, LoadingState, PageHead, RiskBadge, Stat, StatusBadge } from "../components/ui";
import { DataTable } from "../components/DataTable";
import { Tabs } from "../components/Tabs";
import { WorkDetail } from "../components/WorkDetail";
import { useStreamTrust } from "../components/Shell";
import type { WorkItem } from "../api/types";

const TABS = [
  { id: "pending", label: "Pending approval" },
  { id: "blocked", label: "Blocked" },
  { id: "history", label: "History" }
] as const;

export function ApprovalsPage() {
  const { route, go } = useRouter();
  const work = useWorkItems();
  const events = useEventBackfill();
  const { trustworthy } = useStreamTrust();
  const [tab, setTab] = useState("pending");
  const now = Date.now();
  const items = work.data ?? [];

  const lists = useMemo(
    () => ({
      pending: items
        .filter((i) => i.status === "needs_approval")
        .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt)),
      blocked: items.filter((i) => i.status === "blocked").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      history: items
        .filter((i) => i.status === "approved" || i.status === "rejected")
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 100)
    }),
    [items]
  );
  const rows: WorkItem[] = tab === "blocked" ? lists.blocked : tab === "history" ? lists.history : lists.pending;
  const selected = route.param;
  const rationale = (id: string): string => requiredApprovals(events.data ?? [], id)[0]?.reason ?? "—";
  const oldest = lists.pending[0];

  return (
    <div className="page" data-testid="page-approvals">
      <PageHead
        title="Approvals"
        description="Human authority over governed actions. Each approval is bound to the exact action hash ACS recorded."
      />
      <div className="stat-grid">
        <Stat
          label="Pending approval"
          value={work.hasData ? lists.pending.length : "—"}
          tone={lists.pending.length > 0 ? "warning" : undefined}
        />
        <Stat
          label="Blocked"
          value={work.hasData ? lists.blocked.length : "—"}
          tone={lists.blocked.length > 0 ? "danger" : undefined}
        />
        <Stat
          label="Oldest waiting"
          value={oldest ? relativeAge(oldest.updatedAt, now) : "—"}
          note="Since last state change"
        />
        <Stat label="Approved / rejected" value={work.hasData ? lists.history.length : "—"} note="Most recent 100" />
      </div>
      {!trustworthy && (
        <div className="banner" data-tone="warning" role="status">
          <p>Approve, reject and unblock are disabled while the live event stream is disconnected.</p>
        </div>
      )}
      <p className="hint">There is no bulk approval: each action is reviewed and approved individually.</p>
      <div className="split" data-open={selected ? "true" : "false"}>
        <Card labelledBy="h-approvals" flush>
          <div style={{ padding: "0 var(--space-4)" }}>
            <Tabs tabs={TABS} active={tab} onChange={setTab} label="Approval queues">
              {work.error && !work.hasData ? (
                <ErrorState error={work.error} onRetry={work.refetch} what="approvals" />
              ) : !work.hasData ? (
                <LoadingState />
              ) : (
                <DataTable
                  caption={`${tab} work items`}
                  rows={rows}
                  rowKey={(item) => item.id}
                  selectedKey={selected}
                  onRowActivate={(item) => go(`/approvals/${encodeURIComponent(item.id)}`)}
                  empty={
                    <EmptyState
                      title={
                        tab === "pending"
                          ? "Nothing is waiting for approval"
                          : tab === "blocked"
                            ? "Nothing is blocked"
                            : "No approved or rejected items yet"
                      }
                    />
                  }
                  columns={[
                    {
                      id: "id",
                      header: "Work item",
                      cell: (item) => (
                        <>
                          <span className="cell-primary truncate" style={{ display: "block", maxWidth: 260 }}>
                            {item.title}
                          </span>
                          <span className="cell-sub mono">{item.id}</span>
                        </>
                      )
                    },
                    { id: "action", header: "Action", cell: (item) => item.requestedActions[0]?.kind ?? "—" },
                    { id: "risk", header: "Risk", cell: (item) => <RiskBadge risk={item.risk} /> },
                    {
                      id: "target",
                      header: "Target",
                      cell: (item) => (
                        <span className="truncate" style={{ display: "block", maxWidth: 160 }}>
                          {workItemTargetLabel(item)}
                        </span>
                      )
                    },
                    { id: "req", header: "Requester", cell: (item) => item.requesterSubject ?? item.requester },
                    { id: "age", header: "Age", cell: (item) => relativeAge(item.updatedAt, now) },
                    {
                      id: "why",
                      header: "Policy reason",
                      cell: (item) => (
                        <span className="truncate" style={{ display: "block", maxWidth: 220 }}>
                          {rationale(item.id)}
                        </span>
                      )
                    },
                    { id: "status", header: "Status", cell: (item) => <StatusBadge status={item.status} /> }
                  ]}
                />
              )}
            </Tabs>
          </div>
        </Card>
        {selected && (
          <aside className="card detail" aria-label={`Approval detail ${selected}`}>
            <div className="card-body">
              <WorkDetail key={selected} id={selected} initialTab="approval" onClose={() => go("/approvals")} />
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
