import { useEffect, useMemo, useState } from "react";
import {
  applyWorkFilters,
  paginate,
  parseWorkFilters,
  serializeWorkFilters,
  workItemSource,
  workItemTargetLabel,
  type WorkFilters
} from "../domain/filters";
import { formatTime, relativeAge } from "../domain/format";
import { needsAttention } from "../domain/status";
import { useRouter } from "../router";
import { useExecutions, useWorkItems } from "../state/data";
import { Badge, Card, EmptyState, ErrorState, LoadingState, PageHead, RiskBadge, StatusBadge } from "../components/ui";
import { DataTable } from "../components/DataTable";
import { WorkDetail } from "../components/WorkDetail";
import { NewWorkItemDialog } from "../components/NewWorkItemDialog";

const PAGE_SIZE = 25;
const STATUSES = [
  "draft",
  "pending_policy",
  "needs_approval",
  "approved",
  "running",
  "cancelling",
  "succeeded",
  "failed",
  "blocked",
  "cancelled",
  "rejected",
  "unknown",
  "quarantined"
];

export function WorkPage() {
  const { location, route, go, setSearch } = useRouter();
  const work = useWorkItems();
  const executions = useExecutions(work.data);
  const filters = useMemo(() => parseWorkFilters(location.search), [location.search]);
  const page = Number(location.search.get("page") ?? "1") || 1;
  const [qDraft, setQDraft] = useState(filters.q);
  const [creating, setCreating] = useState(false);
  const now = Date.now();

  // Debounced text search → URL, so filters are linkable.
  useEffect(() => {
    if (qDraft === filters.q) return;
    const timer = setTimeout(() => setSearch({ q: qDraft, page: undefined }), 250);
    return () => clearTimeout(timer);
  }, [qDraft, filters.q, setSearch]);
  useEffect(() => setQDraft(filters.q), [filters.q]);

  const items = work.data ?? [];
  const agentByItem = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of executions.data?.rows ?? [])
      if (row.attempt?.claimedByWorkerId) map.set(row.workItem.id, row.attempt.claimedByWorkerId);
    return map;
  }, [executions.data]);
  const filtered = useMemo(
    () => applyWorkFilters(items, filters, now, agentByItem),
    [items, filters, now, agentByItem]
  );
  const paged = paginate(filtered, page, PAGE_SIZE);
  const requesters = useMemo(() => [...new Set(items.map((i) => i.requesterSubject ?? i.requester))].sort(), [items]);
  const sources = useMemo(() => [...new Set(items.map(workItemSource))].sort(), [items]);
  const agents = useMemo(() => [...new Set(agentByItem.values())].sort(), [agentByItem]);

  const update = (patch: Partial<WorkFilters> & { page?: string }) => {
    const next = serializeWorkFilters({ ...filters, ...patch } as WorkFilters);
    if (patch.page) next.set("page", patch.page);
    else next.delete("page");
    const params: Record<string, string | undefined> = {};
    for (const key of [
      "q",
      "status",
      "risk",
      "requester",
      "source",
      "agent",
      "window",
      "attention",
      "sort",
      "dir",
      "page"
    ])
      params[key] = next.get(key) ?? undefined;
    setSearch(params);
  };

  const selected = route.param;
  const select = (id: string) =>
    go(`/work/${encodeURIComponent(id)}${location.search.toString() ? `?${location.search.toString()}` : ""}`);
  const close = () => go(`/work${location.search.toString() ? `?${location.search.toString()}` : ""}`);
  const activeFilters = [...serializeWorkFilters(filters)].some(([key]) => key !== "sort" && key !== "dir");

  return (
    <div className="page" data-testid="page-work">
      <PageHead
        title="Work Queue"
        description="Governed work items and their lifecycle."
        actions={
          <button type="button" className="btn" data-variant="primary" onClick={() => setCreating(true)}>
            New work item
          </button>
        }
      />
      <NewWorkItemDialog open={creating} onClose={() => setCreating(false)} />
      <div className="toolbar" role="search" aria-label="Filter work items">
        <label className="grow">
          <span className="visually-hidden">Search work items</span>
          <input
            className="input"
            type="search"
            placeholder="Search id, title, intent, requester…"
            value={qDraft}
            onChange={(e) => setQDraft(e.target.value)}
          />
        </label>
        <FilterSelect
          label="Status"
          value={filters.status}
          options={STATUSES}
          onChange={(v) => update({ status: v })}
        />
        <FilterSelect
          label="Risk"
          value={filters.risk}
          options={["low", "medium", "high", "critical"]}
          onChange={(v) => update({ risk: v })}
        />
        <FilterSelect
          label="Requester"
          value={filters.requester}
          options={requesters}
          onChange={(v) => update({ requester: v })}
        />
        <FilterSelect label="Source" value={filters.source} options={sources} onChange={(v) => update({ source: v })} />
        <FilterSelect
          label="Worker"
          value={filters.agent}
          options={agents}
          onChange={(v) => update({ agent: v })}
          disabledHint={agents.length === 0 ? "No worker assignments loaded" : undefined}
        />
        <FilterSelect
          label="Created"
          value={filters.window}
          options={["1h", "24h", "7d", "30d"]}
          onChange={(v) => update({ window: v })}
          render={(v) => `Last ${v}`}
        />
        <label className="row" style={{ gap: 6 }}>
          <input
            type="checkbox"
            checked={filters.attention}
            onChange={(e) => update({ attention: e.target.checked })}
          />{" "}
          Needs attention
        </label>
        {activeFilters && (
          <button
            type="button"
            className="btn"
            onClick={() => {
              setQDraft("");
              setSearch({
                q: undefined,
                status: undefined,
                risk: undefined,
                requester: undefined,
                source: undefined,
                agent: undefined,
                window: undefined,
                attention: undefined,
                page: undefined
              });
            }}
          >
            Clear filters
          </button>
        )}
        <button type="button" className="btn" onClick={work.refetch} disabled={work.isFetching}>
          {work.isFetching ? "Refreshing…" : "Refresh"}
        </button>
      </div>
      <div className="split" data-open={selected ? "true" : "false"}>
        <Card title={`${filtered.length} of ${items.length} work items`} labelledBy="h-work-list" flush>
          {work.error && !work.hasData ? (
            <ErrorState error={work.error} onRetry={work.refetch} what="work items" />
          ) : !work.hasData ? (
            <LoadingState />
          ) : (
            <>
              <DataTable
                caption="Work items"
                rows={paged.rows}
                rowKey={(item) => item.id}
                selectedKey={selected}
                onRowActivate={(item) => select(item.id)}
                sort={{ key: filters.sort, dir: filters.dir }}
                onSort={(key) =>
                  update({
                    sort: key as WorkFilters["sort"],
                    dir: filters.sort === key && filters.dir === "desc" ? "asc" : "desc"
                  })
                }
                empty={
                  <EmptyState title={items.length === 0 ? "No work items" : "No work items match these filters"} />
                }
                columns={[
                  { id: "id", header: "ID", cell: (item) => <span className="mono">{item.id}</span> },
                  {
                    id: "title",
                    header: "Title",
                    sortKey: "title",
                    cell: (item) => (
                      <span className="cell-primary truncate" style={{ display: "block", maxWidth: 280 }}>
                        {item.title}
                      </span>
                    )
                  },
                  {
                    id: "status",
                    header: "Status",
                    sortKey: "status",
                    cell: (item) => <StatusBadge status={item.status} />
                  },
                  { id: "risk", header: "Risk", sortKey: "risk", cell: (item) => <RiskBadge risk={item.risk} /> },
                  { id: "req", header: "Requester", cell: (item) => item.requesterSubject ?? item.requester },
                  {
                    id: "target",
                    header: "Target",
                    cell: (item) => (
                      <span className="truncate" style={{ display: "block", maxWidth: 180 }}>
                        {workItemTargetLabel(item)}
                      </span>
                    )
                  },
                  { id: "worker", header: "Worker", cell: (item) => agentByItem.get(item.id) ?? "—" },
                  {
                    id: "created",
                    header: "Created",
                    sortKey: "created",
                    cell: (item) => (
                      <span title={formatTime(item.createdAt, { seconds: true })}>
                        {relativeAge(item.createdAt, now)} ago
                      </span>
                    )
                  },
                  {
                    id: "attn",
                    header: "Attention",
                    cell: (item) =>
                      needsAttention(item.status) ? (
                        <Badge
                          meta={{
                            label: "Needs attention",
                            tone: item.status === "needs_approval" ? "warning" : "danger"
                          }}
                        />
                      ) : (
                        <span className="muted">—</span>
                      )
                  }
                ]}
              />
              <div className="pager">
                <span>
                  Page {paged.page} of {paged.pages}
                </span>
                <button
                  type="button"
                  className="btn"
                  data-size="sm"
                  disabled={paged.page <= 1}
                  onClick={() => update({ page: String(paged.page - 1) })}
                >
                  Previous
                </button>
                <button
                  type="button"
                  className="btn"
                  data-size="sm"
                  disabled={paged.page >= paged.pages}
                  onClick={() => update({ page: String(paged.page + 1) })}
                >
                  Next
                </button>
              </div>
            </>
          )}
        </Card>
        {selected && (
          <aside className="card detail" aria-label={`Work item ${selected}`}>
            <div className="card-body">
              <WorkDetail key={selected} id={selected} onClose={close} />
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
  render,
  disabledHint
}: {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
  render?: (value: string) => string;
  disabledHint?: string | undefined;
}) {
  return (
    <label>
      <span className="visually-hidden">{label}</span>
      <select
        className="select"
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={options.length === 0}
        title={disabledHint}
      >
        <option value="">{label}: all</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {render ? render(option) : option}
          </option>
        ))}
      </select>
    </label>
  );
}
