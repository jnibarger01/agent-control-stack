import { useEffect, useMemo, useState } from "react";
import type { StoredAuditEvent } from "../api/types";
import {
  applyAuditFilters,
  eventActor,
  eventSummary,
  eventTypeGroups,
  eventWorkItem,
  eventsPerSecond,
  parseAuditFilters,
  relatedEvents,
  serializeAuditFilters,
  type AuditFilters
} from "../domain/audit";
import { formatCount, formatTime, relativeAge, safeJson } from "../domain/format";
import { eventTimeMs, severityFor } from "../state/reconcile";
import { eventStream, useEventBackfill, useMetrics } from "../state/data";
import { useEventStream } from "../state/events";
import { Link, useRouter } from "../router";
import {
  Badge,
  Card,
  CopyButton,
  EmptyState,
  ErrorState,
  JsonView,
  KV,
  LoadingState,
  PageHead,
  Stat
} from "../components/ui";
import { DataTable } from "../components/DataTable";
import { Tabs } from "../components/Tabs";

const SEVERITY_TONE = { info: "neutral", notice: "success", warning: "warning", error: "danger" } as const;
/** Bounds DOM size: the table renders at most this many rows regardless of buffer or filter size. */
const MAX_ROWS = 200;

export function AuditPage() {
  const { location, route, go, setSearch } = useRouter();
  const stream = useEventStream(eventStream);
  const backfill = useEventBackfill();
  const metrics = useMetrics();
  const [paused, setPaused] = useState(false);
  const [frozen, setFrozen] = useState<readonly StoredAuditEvent[] | undefined>(undefined);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  void tick;
  const now = Date.now();

  const filters = useMemo(() => parseAuditFilters(location.search), [location.search]);
  const [qDraft, setQDraft] = useState(filters.q);
  useEffect(() => {
    if (qDraft === filters.q) return;
    const timer = setTimeout(() => setSearch({ q: qDraft }), 250);
    return () => clearTimeout(timer);
  }, [qDraft, filters.q, setSearch]);

  const all = useMemo(() => {
    const merged = new Map<string, StoredAuditEvent>();
    for (const event of backfill.data ?? []) merged.set(event.id, event);
    for (const event of stream.events) merged.set(event.id, event);
    return [...merged.values()].sort((a, b) => b.sequence - a.sequence);
  }, [backfill.data, stream.events]);
  // Pause freezes what is rendered; the authoritative stream keeps running underneath.
  const source = paused && frozen ? frozen : all;
  const filtered = useMemo(() => applyAuditFilters(source, filters, now), [source, filters, now]);
  const rows = filtered.slice(0, MAX_ROWS);
  const selected = route.param ? all.find((e) => e.id === route.param) : undefined;
  const actors = useMemo(() => [...new Set(all.map(eventActor))].sort(), [all]);
  const lastAgeMs = stream.lastFrameAt ? now - stream.lastFrameAt : undefined;
  const rate = eventsPerSecond(all, now);

  const update = (patch: Partial<AuditFilters>) => {
    const next = serializeAuditFilters({ ...filters, ...patch });
    const params: Record<string, string | undefined> = {};
    for (const key of ["q", "type", "actor", "workItem", "severity", "window"])
      params[key] = next.get(key) ?? undefined;
    setSearch(params);
  };
  const togglePause = () => {
    if (paused) {
      setPaused(false);
      setFrozen(undefined);
    } else {
      setFrozen(all);
      setPaused(true);
    }
  };
  const total = metrics.data?.summary.auditEventsTotal;

  return (
    <div className="page" data-testid="page-audit">
      <PageHead
        title="Audit"
        description="Live, append-only event console."
        actions={
          <button type="button" className="btn" onClick={togglePause} aria-pressed={paused}>
            {paused ? "Resume rendering" : "Pause rendering"}
          </button>
        }
      />
      <div className="stat-grid">
        <Stat
          label="Stream"
          value={stream.status === "live" ? "Live" : stream.status[0]!.toUpperCase() + stream.status.slice(1)}
          tone={stream.status === "live" ? "success" : "warning"}
          note={stream.lastError ?? "SSE /events"}
        />
        <Stat label="Events / sec (last 60s)" value={rate.toFixed(2)} note="From events this tab received" />
        <Stat label="Received this session" value={formatCount(stream.totalReceived)} />
        <Stat
          label="Total appended (gateway)"
          value={total === undefined ? "—" : formatCount(total)}
          note="acs_audit_events_total since gateway start"
        />
        <Stat
          label="Last event age"
          value={lastAgeMs === undefined ? "—" : `${Math.floor(lastAgeMs / 1000)}s`}
          note="Since the last frame"
        />
      </div>
      {paused && (
        <div className="banner" data-tone="info" role="status">
          <p>Rendering is paused. The live stream is still running and events are still being received.</p>
        </div>
      )}
      <div className="toolbar" role="search" aria-label="Filter audit events">
        <label className="grow">
          <span className="visually-hidden">Search events</span>
          <input
            className="input"
            type="search"
            placeholder="Search event, actor, work item, summary…"
            value={qDraft}
            onChange={(e) => setQDraft(e.target.value)}
          />
        </label>
        <label>
          <span className="visually-hidden">Event type</span>
          <select
            className="select"
            aria-label="Event type"
            value={filters.type}
            onChange={(e) => update({ type: e.target.value })}
          >
            <option value="">Type: all</option>
            {eventTypeGroups(all).map((t) => (
              <option key={t} value={t}>
                {t}.*
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="visually-hidden">Actor</span>
          <select
            className="select"
            aria-label="Actor"
            value={filters.actor}
            onChange={(e) => update({ actor: e.target.value })}
          >
            <option value="">Actor: all</option>
            {actors.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="visually-hidden">Work item</span>
          <input
            className="input"
            style={{ minWidth: 140 }}
            aria-label="Work item id"
            placeholder="Work item id"
            value={filters.workItem}
            onChange={(e) => update({ workItem: e.target.value })}
          />
        </label>
        <label>
          <span className="visually-hidden">Severity</span>
          <select
            className="select"
            aria-label="Severity"
            value={filters.severity}
            onChange={(e) => update({ severity: e.target.value as AuditFilters["severity"] })}
          >
            <option value="">Severity: all</option>
            {["info", "notice", "warning", "error"].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="visually-hidden">Time window</span>
          <select
            className="select"
            aria-label="Time window"
            value={filters.window}
            onChange={(e) => update({ window: e.target.value })}
          >
            <option value="">Time: all loaded</option>
            {["5m", "1h", "24h"].map((w) => (
              <option key={w} value={w}>
                Last {w}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="hint">
        Severity is derived from the event name (the audit log has no severity field). Showing {rows.length} of{" "}
        {filtered.length} matching events; {all.length} loaded.
      </p>
      <div className="split" data-open={route.param ? "true" : "false"}>
        <Card title="Events" labelledBy="h-events" flush>
          {backfill.error && !backfill.hasData && all.length === 0 ? (
            <ErrorState error={backfill.error} onRetry={backfill.refetch} what="audit events" />
          ) : !backfill.hasData && all.length === 0 ? (
            <LoadingState />
          ) : (
            <DataTable
              caption="Audit events, newest first"
              rows={rows}
              rowKey={(e) => e.id}
              selectedKey={route.param}
              onRowActivate={(e) =>
                go(
                  `/audit/${encodeURIComponent(e.id)}${location.search.toString() ? `?${location.search.toString()}` : ""}`
                )
              }
              empty={<EmptyState title="No events match" />}
              columns={[
                { id: "t", header: "Time", cell: (e) => formatTime(eventTimeMs(e), { seconds: true }) },
                { id: "n", header: "Event type", cell: (e) => <span className="mono">{e.name}</span> },
                { id: "w", header: "Work item", cell: (e) => eventWorkItem(e) ?? "—" },
                { id: "a", header: "Actor / source", cell: (e) => eventActor(e) },
                {
                  id: "s",
                  header: "Severity",
                  cell: (e) => <Badge meta={{ label: severityFor(e), tone: SEVERITY_TONE[severityFor(e)] }} />
                },
                {
                  id: "m",
                  header: "Summary",
                  cell: (e) => (
                    <span className="truncate" style={{ display: "block", maxWidth: 320 }}>
                      {eventSummary(e)}
                    </span>
                  )
                }
              ]}
            />
          )}
        </Card>
        {route.param && (
          <aside className="card detail" aria-label={`Audit event ${route.param}`}>
            <div className="card-body">
              {selected ? (
                <EventDetail
                  key={selected.id}
                  event={selected}
                  pool={all}
                  onClose={() => go(`/audit${location.search.toString() ? `?${location.search.toString()}` : ""}`)}
                />
              ) : (
                <ErrorState
                  error={new Error(`Event ${route.param} is not in the loaded window (latest ${all.length}).`)}
                  what="audit event"
                />
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "payload", label: "Payload" },
  { id: "related", label: "Related events" },
  { id: "raw", label: "Raw JSON" }
] as const;

const ID_KEYS: Array<[string, string]> = [
  ["work_item.id", "Work item"],
  ["agent.id", "Agent"],
  ["worker.id", "Worker"],
  ["connector.id", "Connector"],
  ["attempt.id", "Attempt"],
  ["plan.id", "Plan"],
  ["run.id", "Run"],
  ["session.id", "Session"],
  ["tunnel_session.id", "Tunnel session"]
];

function EventDetail({
  event,
  pool,
  onClose
}: {
  event: StoredAuditEvent;
  pool: readonly StoredAuditEvent[];
  onClose: () => void;
}) {
  const [tab, setTab] = useState("overview");
  const related = useMemo(() => relatedEvents(event, pool), [event, pool]);
  const attrs = event.attributes ?? {};
  const severity = severityFor(event);
  return (
    <div className="stack" data-testid="audit-detail">
      <div className="detail-head">
        <div style={{ minWidth: 0 }}>
          <h2 className="mono" style={{ overflowWrap: "anywhere" }}>
            {event.name}
          </h2>
          <span className="muted">
            {formatTime(eventTimeMs(event), { seconds: true })} ({relativeAge(eventTimeMs(event))} ago)
          </span>
        </div>
        <div className="row">
          <Badge meta={{ label: severity, tone: SEVERITY_TONE[severity] }} />
          <button type="button" className="btn" data-size="sm" onClick={onClose} aria-label="Close detail">
            ✕
          </button>
        </div>
      </div>
      <Tabs tabs={TABS} active={tab} onChange={setTab} label="Event sections">
        {tab === "overview" && (
          <div className="stack">
            <KV
              items={[
                [
                  "Event ID",
                  <span className="mono" key="i">
                    {event.id} <CopyButton value={event.id} label="event id" />
                  </span>
                ],
                ["Sequence", event.sequence],
                ["Actor / source", eventActor(event)],
                ["Summary", eventSummary(event)],
                ...ID_KEYS.filter(([key]) => attrs[key] !== undefined).map(
                  ([key, label]): [string, React.ReactNode] => [
                    label,
                    key === "work_item.id" ? (
                      <Link key={key} to={`/work/${encodeURIComponent(String(attrs[key]))}`}>
                        {String(attrs[key])}
                      </Link>
                    ) : (
                      <span key={key} className="mono">
                        {String(attrs[key])}
                      </span>
                    )
                  ]
                ),
                [
                  "Event hash",
                  <span className="hash" key="h">
                    {event.eventHash}
                  </span>
                ],
                [
                  "Previous hash",
                  <span className="hash" key="p">
                    {event.previousHash}
                  </span>
                ]
              ]}
            />
            <div className="section">
              <h3 className="eyebrow">Attributes</h3>
              <KV items={Object.entries(attrs).map(([k, v]): [string, React.ReactNode] => [k, String(v)])} />
            </div>
          </div>
        )}
        {tab === "payload" && <JsonView value={event.body} label="Event payload" />}
        {tab === "related" &&
          (related.length === 0 ? (
            <p className="muted">No related events in the loaded window.</p>
          ) : (
            <DataTable
              caption="Related events"
              rows={related}
              rowKey={(e) => e.id}
              columns={[
                { id: "t", header: "Time", cell: (e) => formatTime(eventTimeMs(e), { seconds: true }) },
                {
                  id: "n",
                  header: "Event",
                  cell: (e) => (
                    <Link to={`/audit/${encodeURIComponent(e.id)}`} className="mono">
                      {e.name}
                    </Link>
                  )
                },
                { id: "a", header: "Actor", cell: (e) => eventActor(e) }
              ]}
            />
          ))}
        {tab === "raw" && (
          <>
            <JsonView value={event} label="Raw event JSON" />
            <div className="row">
              <CopyButton value={safeJson(event)} label="raw event JSON" />
            </div>
          </>
        )}
      </Tabs>
    </div>
  );
}
