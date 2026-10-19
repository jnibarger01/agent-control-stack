import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import type { AuditEvent, AuditReadModel } from "@agent-control-stack/mission-control-contract";
import { fetchAudit } from "../../data/api";
import { useAudit } from "../../data/live";
import { clockTime } from "../../design/format";
import { Card, DataTable, Drawer, EmptyState, IdChip, StatusPill } from "../../design/primitives";
import { QueryBoundary } from "../../design/QueryBoundary";

function merge(newest: AuditEvent[], older: AuditEvent[]): AuditEvent[] {
  const bySeq = new Map<number, AuditEvent>();
  for (const e of [...older, ...newest]) bySeq.set(e.sequence, e);
  return [...bySeq.values()].sort((a, b) => b.sequence - a.sequence);
}

export function AuditTable({ events, onSelect }: { events: AuditEvent[]; onSelect: (e: AuditEvent) => void }) {
  return (
    <DataTable
      caption="Audit events, newest first"
      rows={events}
      rowKey={(e) => String(e.sequence)}
      columns={[
        { key: "seq", header: "#", render: (e) => <span className="font-mono text-xs text-muted">{e.sequence}</span> },
        { key: "at", header: "Time", render: (e) => <time dateTime={e.at} className="whitespace-nowrap text-xs">{clockTime(e.at)}</time> },
        { key: "name", header: "Event", render: (e) => <button type="button" onClick={() => onSelect(e)} className="font-mono text-xs font-medium text-accent hover:underline" aria-label={`Inspect event ${e.sequence}, ${e.name}`}>{e.name}</button> },
        { key: "ref", header: "Subject", render: (e) => { const id = e.attributes["work_item.id"]; return typeof id === "string" ? <Link className="text-xs text-accent hover:underline" to={`/queue/${encodeURIComponent(id)}`}>work item</Link> : <span className="text-xs text-muted">{String(e.attributes["agent.id"] ?? e.attributes["connector.id"] ?? "")}</span>; } }
      ]}
    />
  );
}

export function EventDetail({ event }: { event: AuditEvent }) {
  const entries = Object.entries(event.attributes);
  return (
    <div className="space-y-4 text-sm">
      <p className="font-mono font-medium">{event.name}</p>
      <dl className="grid grid-cols-2 gap-3 text-xs">
        <div><dt className="text-muted">Sequence</dt><dd>{event.sequence}</dd></div>
        <div><dt className="text-muted">Time</dt><dd><time dateTime={event.at}>{new Date(event.at).toLocaleString()}</time></dd></div>
        <div><dt className="text-muted">Event hash</dt><dd><IdChip id={event.eventHash} /></dd></div>
        <div><dt className="text-muted">Previous hash</dt><dd><IdChip id={event.previousHash} /></dd></div>
      </dl>
      {event.policy && (
        <div className="rounded-ctl border border-line bg-surface-2 p-3">
          <StatusPill tone={event.policy.decision === "allow" ? "ok" : event.policy.decision === "deny" ? "bad" : "warn"}>{event.policy.decision.replace(/_/g, " ")}</StatusPill>
          {event.policy.reason && <p className="mt-2 text-sm">{event.policy.reason}</p>}
          {event.policy.matchedRules.length > 0 && <p className="mt-1 text-xs text-muted">Rules: {event.policy.matchedRules.join(", ")}</p>}
        </div>
      )}
      <div>
        <p className="mb-1 text-xs uppercase tracking-wider text-muted">Attributes (redacted)</p>
        {entries.length === 0 ? <p className="text-xs text-muted">None.</p> : (
          <dl className="space-y-1.5 text-xs">{entries.map(([k, v]) => <div key={k} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-2"><dt className="break-all font-mono text-muted">{k}</dt><dd className="break-all">{String(v)}</dd></div>)}</dl>
        )}
      </div>
    </div>
  );
}

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

export function AuditPage() {
  // Drafts update on every keystroke; the server is queried once typing pauses.
  const [nameDraft, setNameDraft] = useState("");
  const [itemDraft, setItemDraft] = useState("");
  const [text, setText] = useState("");
  const name = useDebounced(nameDraft, 300);
  const workItemId = useDebounced(itemDraft, 300);
  const [older, setOlder] = useState<AuditEvent[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null | undefined>(undefined);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState(false);
  const [selected, setSelected] = useState<AuditEvent | null>(null);
  const filters = { ...(name ? { name } : {}), ...(workItemId ? { workItemId } : {}) };
  const query = useAudit(filters);

  // New filters start a new window.
  useEffect(() => { setOlder([]); setNextBefore(undefined); setOlderError(false); }, [name, workItemId]);

  const loadOlder = async (head: AuditReadModel) => {
    const before = nextBefore === undefined ? head.nextBefore : nextBefore;
    if (before === null) return;
    setLoadingOlder(true);
    setOlderError(false);
    try {
      const page = await fetchAudit({ ...filters, beforeSequence: before });
      setOlder((prev) => merge(page.events, prev));
      setNextBefore(page.nextBefore);
    } catch {
      setOlderError(true);
    } finally {
      setLoadingOlder(false);
    }
  };

  return (
    <div className="space-y-6">
      <Card title="Audit log" subtitle="Immutable events, redacted and bounded by the server. Name and work-item filters query the log; search applies to the loaded events.">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-48 flex-col gap-1 text-xs text-muted">Event name (exact)<input value={nameDraft} onChange={(e) => setNameDraft(e.target.value.trim())} placeholder="e.g. policy.decided" className="rounded-ctl border border-line bg-surface-2 px-3 py-2 text-sm text-ink placeholder:text-faint" /></label>
          <label className="flex min-w-48 flex-col gap-1 text-xs text-muted">Work item identifier<input value={itemDraft} onChange={(e) => setItemDraft(e.target.value.trim())} placeholder="wrk_…" className="rounded-ctl border border-line bg-surface-2 px-3 py-2 text-sm text-ink placeholder:text-faint" /></label>
          <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs text-muted">Search loaded events<input type="search" value={text} onChange={(e) => setText(e.target.value)} className="rounded-ctl border border-line bg-surface-2 px-3 py-2 text-sm text-ink" /></label>
        </div>
      </Card>
      <QueryBoundary query={query} what="Audit log">
        {(head) => <AuditResults head={head} older={older} nextBefore={nextBefore} loadingOlder={loadingOlder} olderError={olderError} loadOlder={loadOlder} text={text} selected={selected} setSelected={setSelected} />}
      </QueryBoundary>
    </div>
  );
}

function AuditResults({ head, older, nextBefore, loadingOlder, olderError, loadOlder, text, selected, setSelected }: {
  head: AuditReadModel; older: AuditEvent[]; nextBefore: number | null | undefined; loadingOlder: boolean; olderError: boolean; loadOlder: (h: AuditReadModel) => Promise<void>;
  text: string; selected: AuditEvent | null; setSelected: (e: AuditEvent | null) => void;
}) {
  const all = useMemo(() => merge(head.events, older), [head.events, older]);
  const q = text.trim().toLowerCase();
  const rows = useMemo(() => (q ? all.filter((e) => `${e.name} ${Object.values(e.attributes).join(" ")}`.toLowerCase().includes(q)) : all), [all, q]);
  const more = (nextBefore === undefined ? head.nextBefore : nextBefore) !== null;
  return (
    <>
      <Card>
        {rows.length === 0 ? <EmptyState title={all.length === 0 ? "No audit events match" : "No loaded event matches the search"} /> : (
          <>
            <p className="mb-2 text-xs text-muted" role="status">Showing {rows.length} of {all.length} loaded events.</p>
            <AuditTable events={rows} onSelect={setSelected} />
          </>
        )}
        <div className="mt-4 flex items-center gap-3">
          {more ? <button type="button" disabled={loadingOlder} onClick={() => void loadOlder(head)} className="rounded-ctl border border-line px-3 py-1.5 text-sm hover:border-accent disabled:opacity-50">{loadingOlder ? "Loading…" : "Load older events"}</button> : all.length > 0 ? <p className="text-xs text-muted">Start of the retained log reached.</p> : null}
          {olderError && <p role="alert" className="text-sm text-bad">Could not load older events. Nothing was changed.</p>}
        </div>
      </Card>
      <Drawer open={selected !== null} onClose={() => setSelected(null)} title="Audit event">{selected && <EventDetail event={selected} />}</Drawer>
    </>
  );
}
