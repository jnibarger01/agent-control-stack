import type { OverviewReadModel, PipelineItem, PipelineStage } from "@agent-control-stack/mission-control-contract";
import { Link } from "react-router";
import { Card, DataTable, EmptyState, IdChip, Stat, StatusPill, Unavailable, type Tone } from "../../design/primitives";
import { clockTime, formatDuration, percent, relativeTime } from "../../design/format";

/* ───────────────────────── Needs you ───────────────────────── */

export function NeedsYou({ data }: { data: OverviewReadModel }) {
  const n = data.needsYou;
  const total = n.approvals + n.blocked + n.quarantined + n.expiringLeases.length;
  return (
    <Card id="needs-you" title="Needs you" subtitle="Counts come from the store. Open Approvals to act on them." tone={total > 0 ? "warn" : undefined}>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Awaiting approval" value={n.approvals} tone={n.approvals ? "warn" : "neutral"} to="/approvals" />
        <Stat label="Blocked" value={n.blocked} tone={n.blocked ? "bad" : "neutral"} to="/queue?status=blocked" />
        <Stat label="Quarantined" value={n.quarantined} tone={n.quarantined ? "bad" : "neutral"} to="/queue?status=quarantined" />
        <Stat label="Leases expiring" value={n.expiringLeases.length} tone={n.expiringLeases.length ? "warn" : "neutral"} note="Warning only. Not authority." to="/execution" />
      </div>
      {total === 0 ? (
        <div className="mt-4"><EmptyState title="Nothing needs you right now">No approvals, blocked or quarantined work, and no leases near expiry.</EmptyState></div>
      ) : (
        <ul className="mt-4 divide-y divide-line/60" aria-label="Items needing attention">
          {n.items.slice(0, 6).map((item) => (
            <li key={item.workItemId} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
              <div className="min-w-0">
                <Link to={`/queue/${encodeURIComponent(item.workItemId)}`} className="block truncate text-sm font-medium hover:text-accent hover:underline">{item.title}</Link>
                <p className="text-xs text-muted">Waiting {relativeTime(item.since).replace(" ago", "")} · risk {String(item.risk)} <IdChip id={item.workItemId} /></p>
              </div>
              <StatusPill tone={item.status === "needs_approval" ? "warn" : "bad"}>{item.status.replace(/_/g, " ")}</StatusPill>
            </li>
          ))}
          {n.expiringLeases.slice(0, 3).map((lease) => (
            <li key={lease.leaseId} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
              <p className="text-sm">Lease held by <span className="font-medium">{lease.workerId}</span> expires {relativeTime(lease.expiresAt)}</p>
              <StatusPill tone="warn">expiring soon · warning only</StatusPill>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/* ───────────────────────── KPI row ───────────────────────── */

export function KpiRow({ data }: { data: OverviewReadModel }) {
  const running = data.pipeline.stages.find((s) => s.key === "running");
  const t = data.observability.telemetry;
  const a = data.observability.admission;
  const agents = data.infrastructure?.agents;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Key figures">
      <Stat label="Running now" value={running ? running.count : "unknown"} note="Lease-bound work in the store" />
      <Stat label="Agents online" value={agents ? `${agents.online} / ${agents.registered}` : "unknown"} note="By heartbeat evidence" />
      <Stat label="Execution slots" value={a ? `${a.active} / ${a.capacity}` : "unknown"} tone={a?.saturated ? "bad" : "neutral"} note={a ? `${a.queued} queued${a.saturated ? " · saturated" : ""}` : "Admission snapshot absent"} />
      <Stat label="Attempts (24h)" value={t ? `${t.succeeded} ok / ${t.failed} failed` : "unknown"} tone={t && t.failed > 0 ? "warn" : "neutral"} note={t ? `${percent(t.succeeded, t.succeeded + t.failed)} success` : "Telemetry absent"} />
    </div>
  );
}

/* ───────────────────────── Pipeline ───────────────────────── */

const STAGE_TONE: Record<string, Tone> = { running: "info", needs_approval: "warn", approved: "accent", failed: "bad", blocked: "bad", quarantined: "bad", succeeded: "ok" };

function PipelineCard({ item }: { item: PipelineItem }) {
  const exceptional = item.attemptStatus && ["unknown", "quarantined", "interrupted", "cancellation_requested"].includes(item.attemptStatus);
  return (
    <li className="rounded-ctl border border-line bg-surface-2 p-3">
      <p className="text-sm font-medium leading-snug">{item.title}</p>
      <p className="mt-1 line-clamp-2 text-xs text-muted">{item.intent}</p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <StatusPill tone={item.risk === "high" || item.risk === "critical" ? "bad" : item.risk === "medium" ? "warn" : "neutral"} glyph="◆">{String(item.risk)} risk</StatusPill>
        {exceptional && <StatusPill tone="bad">attempt {item.attemptStatus!.replace(/_/g, " ")}</StatusPill>}
        {item.attemptNumber && item.attemptNumber > 1 && <StatusPill tone="neutral">attempt #{item.attemptNumber}</StatusPill>}
        <IdChip id={item.id} />
      </div>
      {item.agentId && <p className="mt-2 text-xs text-muted">Agent <span className="text-ink">{item.agentId}</span></p>}
    </li>
  );
}

export function Pipeline({ data }: { data: OverviewReadModel }) {
  const note = data.pipeline.finishedWindow ? `Finished work shows the latest ${data.pipeline.finishedWindow.shown} of ${data.pipeline.finishedWindow.total}.` : undefined;
  return (
    <Card id="pipeline" title="Work pipeline" subtitle={`Stages are the store's canonical statuses. Read-only. ${note ?? ""}`}>
      {data.sections.pipeline.status !== "ok" ? (
        <Unavailable what="Work pipeline" />
      ) : (
        <div tabIndex={0} role="region" aria-label="Pipeline stages (scrollable)" className="overflow-x-auto pb-2"><div className="flex gap-3" role="list" aria-label="Pipeline stages">
          {data.pipeline.stages.map((stage: PipelineStage) => (
            <section key={stage.key} role="listitem" aria-label={`${stage.label}, ${stage.count} item${stage.count === 1 ? "" : "s"}`} className="w-64 shrink-0">
              <header className="mb-2 flex items-center justify-between px-1">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">{stage.label}</h3>
                <StatusPill tone={stage.count ? (STAGE_TONE[stage.key] ?? "neutral") : "neutral"}>{stage.count}</StatusPill>
              </header>
              {stage.items.length === 0 ? (
                <p className="rounded-ctl border border-dashed border-line px-3 py-4 text-center text-xs text-muted">{stage.count > 0 ? "None in the loaded window" : "Empty"}</p>
              ) : (
                <ul className="space-y-2">{stage.items.map((i) => <PipelineCard key={i.id} item={i} />)}</ul>
              )}
              {stage.count > stage.items.length && stage.items.length > 0 && <p className="mt-2 px-1 text-xs text-muted">Showing {stage.items.length} of {stage.count}{stage.countSource === "window" ? " in window" : ""}</p>}
            </section>
          ))}
        </div></div>
      )}
    </Card>
  );
}

/* ───────────────────────── Observability ───────────────────────── */

export function Observability({ data }: { data: OverviewReadModel }) {
  return (
    <Card id="observability" title="Execution observability" subtitle="Persisted attempt telemetry over a rolling 24-hour window.">
      {data.sections.observability.status !== "ok" ? (
        <Unavailable what="Telemetry" {...(data.sections.observability.reason ? { reason: data.sections.observability.reason } : {})} />
      ) : (
        <TelemetryPanel telemetry={data.observability.telemetry} admission={data.observability.admission} />
      )}
    </Card>
  );
}

export function TelemetryPanel({ telemetry: t, admission: a }: { telemetry: OverviewReadModel["observability"]["telemetry"]; admission: OverviewReadModel["observability"]["admission"] }) {
  return (
    <div className="space-y-5">
      {t ? <Throughput throughput={t.throughput} /> : <Unavailable what="Throughput" reason="telemetry_absent" />}
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <Metric label="Avg run time" value={t ? formatDuration(t.averageRunMs) : "unknown"} />
        <Metric label="Avg queue time" value={t ? formatDuration(t.averageQueueMs) : "unknown"} />
        <Metric label="Approvals granted" value={t?.approvalsGranted === undefined ? "unknown" : String(t.approvalsGranted)} />
        <Metric label="Avg approval latency" value={t?.averageApprovalMs === undefined ? "unknown" : formatDuration(t.averageApprovalMs)} />
      </dl>
      {a ? (
        <div>
          <div className="mb-1 flex justify-between text-xs text-muted"><span>Global execution-slot usage</span><span>{a.active} of {a.capacity} · {a.queued} queued</span></div>
          <div className="h-2 overflow-hidden rounded-full bg-surface-3" role="img" aria-label={`${a.active} of ${a.capacity} execution slots in use`}>
            <div className={`h-full rounded-full ${a.saturated ? "bg-bad" : "bg-accent"}`} style={{ width: `${a.capacity ? Math.min(100, (a.active / a.capacity) * 100) : 0}%`, transition: "width .4s" }} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-xs text-muted">{label}</dt><dd className="mt-0.5 text-lg font-semibold tabular-nums">{value}</dd></div>;
}

function Throughput({ throughput }: { throughput: Array<{ at: string; started: number; completed: number; failed: number }> }) {
  const max = Math.max(1, ...throughput.map((b) => Math.max(b.completed, b.failed, b.started)));
  const W = 24;
  const H = 110;
  return (
    <div>
      <svg viewBox={`0 0 ${throughput.length * W} ${H + 14}`} className="w-full" role="img" aria-label="Hourly attempts: completed and failed over the last 24 hours. A table of the same numbers follows.">
        {throughput.map((b, i) => {
          const hc = (b.completed / max) * H;
          const hf = (b.failed / max) * H;
          return (
            <g key={b.at} transform={`translate(${i * W},0)`}>
              <rect x={3} y={H - hc} width={8} height={hc} rx={2} fill="var(--accent)" />
              <rect x={12} y={H - hf} width={8} height={hf} rx={2} fill="var(--bad)" />
              {i % 6 === 0 && <text x={0} y={H + 11} fontSize="8" fill="var(--faint)">{new Date(b.at).getHours()}h</text>}
            </g>
          );
        })}
        <line x1={0} x2={throughput.length * W} y1={H} y2={H} stroke="var(--line-strong)" />
      </svg>
      <p className="mt-1 flex gap-4 text-xs text-muted"><span><span aria-hidden="true" className="mr-1 inline-block h-2 w-2 rounded-sm bg-accent" />Completed</span><span><span aria-hidden="true" className="mr-1 inline-block h-2 w-2 rounded-sm bg-bad" />Failed</span></p>
      <table className="sr-only">
        <caption>Hourly attempts</caption>
        <thead><tr><th scope="col">Hour</th><th scope="col">Started</th><th scope="col">Completed</th><th scope="col">Failed</th></tr></thead>
        <tbody>{throughput.map((b) => <tr key={b.at}><th scope="row">{clockTime(b.at)}</th><td>{b.started}</td><td>{b.completed}</td><td>{b.failed}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

/* ───────────────────────── Activity & readiness ───────────────────────── */

export function Activity({ data }: { data: OverviewReadModel }) {
  return (
    <Card id="activity" title="Live activity" subtitle="Latest audit events, redacted and bounded." >
      {data.sections.activity.status !== "ok" ? (
        <Unavailable what="Audit activity" {...(data.sections.activity.reason ? { reason: data.sections.activity.reason } : {})} />
      ) : data.activity.length === 0 ? (
        <EmptyState title="No audit events yet" />
      ) : (
        <ol tabIndex={0} className="max-h-96 divide-y divide-line/60 overflow-y-auto" aria-label="Audit events, newest first">
          {data.activity.slice(0, 20).map((e) => (
            <li key={e.id} className="acs-in py-2">
              <div className="flex items-center justify-between gap-2 text-xs"><span className="font-mono font-medium">{e.name}</span><time dateTime={e.at} className="text-muted">{clockTime(e.at)}</time></div>
              {e.summary && e.summary !== "{}" && <p className="mt-0.5 truncate font-mono text-[11px] text-muted" title={e.summary}>{e.summary}</p>}
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

export function Readiness({ data }: { data: OverviewReadModel }) {
  return (
    <Card id="readiness" title="System readiness" subtitle="The same checks as /readyz. Configured is not the same as healthy.">
      {data.sections.readiness.status !== "ok" || !data.readiness ? (
        <Unavailable what="Readiness checks" {...(data.sections.readiness.reason ? { reason: data.sections.readiness.reason } : {})} />
      ) : (
        <>
          <div className="mb-3"><StatusPill tone={data.readiness.ok ? "ok" : "bad"}>{data.readiness.ok ? "All checks passing" : "Not ready"}</StatusPill></div>
          <ul className="space-y-1.5">
            {data.readiness.checks.map((c) => (
              <li key={c.name} className="flex items-center justify-between gap-2 text-sm"><span>{c.name.replace(/_/g, " ")}</span><StatusPill tone={c.ok ? "ok" : "bad"}>{c.ok ? "ok" : (c.code ?? "failing")}</StatusPill></li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

export function InfrastructureStrip({ data }: { data: OverviewReadModel }) {
  const i = data.infrastructure;
  if (!i) return <Unavailable what="Infrastructure summary" />;
  return (
    <Card title="Infrastructure" subtitle="Executors and connectors appear as nodes in the network once their pages are migrated.">
      <DataTable
        caption="Registered infrastructure"
        rows={[
          { k: "Executors", v: `${i.executors.configured} configured of ${i.executors.total} known · ${i.executors.attestedRuntimes} attested runtimes` },
          { k: "Connectors", v: `${i.connectors.enabled} enabled of ${i.connectors.registered} registered · ${i.connectors.activeSessions} active sessions` }
        ]}
        rowKey={(r) => r.k}
        columns={[{ key: "k", header: "Domain", render: (r) => <span className="font-medium">{r.k}</span> }, { key: "v", header: "State", render: (r) => r.v }]}
      />
    </Card>
  );
}
