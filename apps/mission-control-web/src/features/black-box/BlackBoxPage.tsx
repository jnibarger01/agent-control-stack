import { useEffect, useMemo, useState } from "react";
import { exportRun, orderEvents, queryRuns, timestampUncertain, capture, loadLane, LIVE_FOCUS_RUN } from "@agent-control-stack/black-box-recorder";
import type { Finding, RecorderEvent, RecorderStore, RunSummary } from "@agent-control-stack/black-box-recorder";
import { Card, EmptyState, StatusPill, type Tone } from "../../design/primitives";

type Lane = "live" | "fixture";
type Filter = "all" | "audit" | "unverified" | "gaps";

const PAGE = 8;

export function BlackBoxPage() {
  const [enabled, setEnabled] = useState(true);
  const [lane, setLane] = useState<Lane>("live");
  const [store, setStore] = useState<RecorderStore | null>(null);
  const [failed, setFailed] = useState(false);
  const [text, setText] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState(LIVE_FOCUS_RUN);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [order, setOrder] = useState<"source" | "ingestion">("source");
  const [openEvent, setOpenEvent] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStore(null);
    setFailed(false);
    loadLane(lane)
      .then((next) => {
        if (cancelled) return;
        setStore(next);
        setSelected(lane === "live" ? LIVE_FOCUS_RUN : "fixture-verified");
        setPage(0);
        setMobileDetail(false);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [lane]);

  const result = useMemo(() => {
    if (!store || !enabled) return null;
    return queryRuns(store, {
      limit: PAGE,
      cursor: String(page * PAGE),
      text,
      verification: filter === "unverified" ? "unverified" : undefined,
      onlyGaps: filter === "gaps",
      coverage: filter === "audit" ? "audit-chain" : undefined
    });
  }, [store, enabled, page, text, filter]);

  const visible = result?.runs ?? [];
  const summary = store && enabled ? storeRun(store, selected) : null;
  const events = store && enabled && summary ? orderEvents(store.eventsFor(summary.runId), order) : [];
  const findings = store && summary ? store.findings.filter((item) => item.runId === summary.runId) : [];

  async function copy(value: string) {
    await navigator.clipboard?.writeText(value);
    setCopied(value);
    window.setTimeout(() => setCopied(null), 1200);
  }

  async function download() {
    if (!store || !summary) return;
    const bundle = await exportRun(store, summary.runId);
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `abbr-${summary.runId}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-4">
      <Card
        title="Agent Black Box"
        subtitle="Evidence recorder. It does not authorize, approve, or dispatch work."
        action={
          <button type="button" aria-pressed={enabled} onClick={() => setEnabled((value) => !value)} className="rounded-ctl border border-line bg-surface-2 px-3 py-2 text-sm">
            Recorder {enabled ? "on" : "off"}
          </button>
        }
      >
        <p className="font-mono text-xs leading-relaxed text-muted">
          Snapshot {clock(capture.capturedAt)} UTC · {capture.via} · {capture.runtimeId} · repo {capture.repoHead.slice(0, 12)}
          {capture.gatewayReachable ? " · gateway was reachable" : " · gateway unreachable"}. This is not a live socket to ACS.
        </p>
      </Card>

      {!enabled ? (
        <EmptyState title="Recorder disabled">No timeline is shown. Turning this off does not change ACS authorization and does not invent a history.</EmptyState>
      ) : failed || !store || !result ? (
        <div role="status" className="rounded-ctl border border-dashed border-line-strong px-4 py-6 text-sm">
          <p className="font-medium">{failed ? "Data unavailable" : "Loading snapshot"}</p>
          <p className="mt-1 text-xs text-muted">
            {failed ? "The recorder could not read its snapshot. Nothing here is being treated as success." : "Reading the redacted capture."}
          </p>
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
          <section className={mobileDetail ? "hidden lg:block" : "block"} aria-label="Recorded runs">
            <div className="mb-3 flex gap-2">
              <LaneButton active={lane === "live"} onClick={() => setLane("live")}>Gateway snapshot</LaneButton>
              <LaneButton active={lane === "fixture"} onClick={() => setLane("fixture")}>Fixture</LaneButton>
            </div>
            <p className={`mb-3 text-xs leading-relaxed ${lane === "fixture" ? "text-warn" : "text-muted"}`}>
              {lane === "fixture"
                ? "Nonproduction fixture. These runs are labeled test data, not ACS history."
                : "Point-in-time read. One work item includes its audit chain. The other rows are list projections only."}
            </p>
            <label className="mb-3 flex min-h-11 items-center gap-2 rounded-ctl border border-line bg-surface px-3">
              <span className="text-xs text-muted">Search</span>
              <input
                value={text}
                onChange={(event) => {
                  setText(event.target.value);
                  setPage(0);
                }}
                placeholder="Run, mission, tool, correlation"
                className="w-full bg-transparent py-2 text-sm outline-none"
              />
            </label>
            <div className="mb-3 flex flex-wrap gap-2">
              {([
                ["all", "All"],
                ["audit", "Audit"],
                ["unverified", "Unverified"],
                ["gaps", "Gaps"]
              ] as const).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    setFilter(id);
                    setPage(0);
                  }}
                  className={`min-h-11 rounded-ctl px-3 text-sm ${filter === id ? "bg-accent-soft font-medium text-ink" : "bg-surface-2 text-muted"}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="mb-2 font-mono text-xs text-muted">{result.total} runs · page {page + 1}</p>
            {visible.length === 0 ? (
              <EmptyState title="No runs match">An empty filter is not evidence that nothing executed.</EmptyState>
            ) : (
              <ul className="flex flex-col gap-2">
                {visible.map((run) => (
                  <li key={run.runId}>
                    <button
                      type="button"
                      onClick={() => {
                        setSelected(run.runId);
                        setOpenEvent(null);
                        setMobileDetail(true);
                      }}
                      className={`w-full rounded-card border p-3 text-left ${run.runId === selected ? "border-accent bg-accent-soft" : "border-line bg-surface"}`}
                    >
                      <span className="font-medium">{run.tool}</span>
                      <p className="mt-1 font-mono text-xs text-muted">{shortId(run.runId)}</p>
                      <p className="mt-2 text-xs text-muted">Observed {run.observedState} · auth {run.authorization.state} · verify {run.verification.state}</p>
                      <p className="mt-1 text-xs text-muted">{run.evidence.eventCount} events · {run.evidence.gapCount} gaps · {run.coverage === "audit-chain" ? "audit chain" : "list only"}</p>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-3 flex gap-2">
              <button type="button" disabled={page === 0} onClick={() => setPage((value) => Math.max(0, value - 1))} className="min-h-11 flex-1 rounded-ctl border border-line text-sm disabled:opacity-40">Previous</button>
              <button type="button" disabled={!result.nextCursor} onClick={() => setPage((value) => value + 1)} className="min-h-11 flex-1 rounded-ctl border border-line text-sm disabled:opacity-40">Next</button>
            </div>
          </section>

          <section className={mobileDetail ? "block" : "hidden lg:block"} aria-label="Investigation">
            {!summary ? (
              <EmptyState title="Select a run">Nothing is filled in when the id is missing.</EmptyState>
            ) : (
              <div className="space-y-3">
                <button type="button" onClick={() => setMobileDetail(false)} className="min-h-11 text-sm text-accent lg:hidden">All runs</button>
                <Card title={summary.instruction ?? summary.tool} subtitle={summary.coverage === "audit-chain" ? "Investigation" : "List projection"}>
                  <p className="text-sm leading-relaxed">{lead(summary, findings)}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <StatusPill tone={toneFor(summary.authorization.state)}>Auth {summary.authorization.state}</StatusPill>
                    <StatusPill tone={toneFor(summary.verification.state)}>Verify {summary.verification.state}</StatusPill>
                    <StatusPill tone="neutral">Record {summary.evidence.completeness}</StatusPill>
                  </div>
                  <p className="mt-2 text-xs text-muted">Observed {summary.observedState} · release {summary.sourceReleases[0] ?? "unknown"} · {summary.evidence.eventCount} events</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button type="button" onClick={() => void copy(summary.runId)} className="min-h-11 rounded-ctl bg-surface-2 px-3 text-sm">{copied === summary.runId ? "Copied" : "Copy run id"}</button>
                    <button type="button" onClick={() => void download()} className="min-h-11 rounded-ctl bg-accent-soft px-3 text-sm font-medium">Export JSON</button>
                  </div>
                  <p className="mt-3 break-all font-mono text-xs text-muted">{summary.runId}{summary.correlationId ? ` · ${summary.correlationId}` : ""}</p>
                </Card>
                <Card
                  title="Timeline"
                  action={
                    <button type="button" onClick={() => setOrder((value) => (value === "source" ? "ingestion" : "source"))} className="min-h-11 rounded-ctl bg-surface-2 px-3 text-xs">
                      {order === "source" ? "Source time" : "Ingestion time"}
                    </button>
                  }
                >
                  {timestampUncertain(events) ? <p className="mb-2 text-xs text-warn">Some source timestamps tie or reverse relative to audit sequence. Sequence is the tie break.</p> : null}
                  <ol className="flex max-h-80 flex-col overflow-y-auto">
                    {events.map((event, index) => (
                      <TimelineRow key={event.eventId} event={event} prior={events[index - 1]} open={openEvent === event.eventId} onToggle={() => setOpenEvent((current) => (current === event.eventId ? null : event.eventId))} onCopy={(value) => void copy(value)} copied={copied} />
                    ))}
                  </ol>
                </Card>
                <Card title={`Findings · ${findings.length}`}>
                  {findings.length === 0 ? <p className="text-sm text-muted">No detector fired on the loaded events.</p> : (
                    <ul className="flex flex-col gap-2">
                      {findings.filter((item) => item.severity !== "info").concat(findings.filter((item) => item.severity === "info").slice(0, 1)).map((item) => (
                        <li key={item.findingId} className="rounded-ctl bg-surface-2 p-3">
                          <p className={`text-xs font-medium ${item.severity === "high" ? "text-bad" : item.severity === "info" ? "text-muted" : "text-warn"}`}>{item.severity} · {item.ruleId}</p>
                          <p className="mt-1 text-sm leading-relaxed">{item.summary}</p>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function storeRun(store: RecorderStore, runId: string): RunSummary | null {
  return queryRuns(store, { runId, limit: 1 }).runs[0] ?? null;
}

function lead(summary: RunSummary, findings: Finding[]): string {
  if (summary.verification.state === "failed") return "Verification failed. That conclusion is the validator record. A producer success claim does not replace it.";
  if (findings.some((item) => item.ruleId === "abbr.spawn-accepted-process-exit")) return "ACS authorized this start and accepted the tool result. A later read observed a non-zero process exit. No ResultValidator event is in the loaded chain, so the exit is not a verified outcome.";
  if (summary.verification.state === "verified") return "A validator pass is linked to this fixture run. Authorization and verification stay separate from how complete the recording is.";
  if (summary.coverage !== "audit-chain") return "Only the work-item list row was loaded. Missing audit events in this view are a snapshot limit, not proof they never happened.";
  if (findings.some((item) => item.ruleId === "abbr.missing-authorization")) return "Execution evidence is present without authorization evidence in the loaded set. That is uncorroborated. It is not an automatic denial.";
  if (summary.verification.state === "unverified") return "Something in the loaded chain reports success. Nothing here is an independent verification.";
  return "The loaded events do not support a stronger conclusion.";
}

function TimelineRow({ event, prior, open, onToggle, onCopy, copied }: { event: RecorderEvent; prior?: RecorderEvent; open: boolean; onToggle: () => void; onCopy: (value: string) => void; copied: string | null }) {
  const name = String(event.metadata.acsEventName ?? event.eventType);
  const tied = Boolean(prior?.sourceTimestamp && prior.sourceTimestamp === event.sourceTimestamp);
  return (
    <li className="border-l border-line py-2 pl-3">
      <button type="button" onClick={onToggle} className="min-h-11 w-full text-left">
        <span className="font-mono text-xs text-accent">{clock(event.sourceTimestamp)}</span>
        <span className="mt-1 block text-sm">{event.source.component} · {name}</span>
        <span className="mt-1 block text-xs text-muted">{event.eventType} · {trustLabel(event.trustLevel)}{tied ? " · same source time" : ""}</span>
      </button>
      {open ? (
        <div className="mt-2 rounded-ctl bg-surface-2 p-3 font-mono text-xs leading-relaxed text-muted">
          <p>event {event.eventId}</p>
          <p>producer {event.source.producerEventId}</p>
          <p>release {event.source.releaseId ?? "unknown"}</p>
          <p>digest {event.evidence.payloadSha256}</p>
          <p>integrity {event.evidence.integrityStatus}</p>
          <button type="button" onClick={() => onCopy(event.eventId)} className="mt-2 min-h-11 font-sans text-sm text-accent">{copied === event.eventId ? "Copied" : "Copy event id"}</button>
        </div>
      ) : null}
    </li>
  );
}

function LaneButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button type="button" onClick={onClick} className={`min-h-11 flex-1 rounded-ctl px-3 text-sm ${active ? "bg-accent-soft font-medium text-ink" : "bg-surface-2 text-muted"}`}>
      {children}
    </button>
  );
}

function trustLabel(trust: string): string {
  if (trust === "acs_authoritative") return "ACS audit read";
  if (trust === "independently_verified") return "validator";
  if (trust === "authenticated_producer") return "producer claim";
  if (trust === "untrusted_claim") return "untrusted claim";
  return "unknown trust";
}

function toneFor(state: string): Tone {
  if (state === "failed" || state === "denied") return "bad";
  if (state === "verified" || state === "allowed") return "ok";
  if (state === "unverified" || state === "held") return "warn";
  if (state === "unknown" || state === "not_loaded") return "unknown";
  return "neutral";
}

function clock(iso: string | null): string {
  if (!iso) return "unknown time";
  return iso.slice(11, 23);
}

function shortId(id: string): string {
  if (id.length <= 18) return id;
  return `${id.slice(0, 10)}…${id.slice(-4)}`;
}
