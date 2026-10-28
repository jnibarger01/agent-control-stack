import { useCallback, useEffect, useState } from "react";
import type { OverviewReadModel } from "@agent-control-stack/mission-control-contract";
import { probe, type ProbeResult } from "../../data/api";
import { clockTime } from "../../design/format";
import { Card, StatusPill, Unavailable } from "../../design/primitives";

export function SystemPage({ data }: { data: OverviewReadModel }) {
  const [probes, setProbes] = useState<ProbeResult[] | null>(null);
  const run = useCallback(async () => setProbes(await Promise.all([probe("/healthz"), probe("/readyz")])), []);
  useEffect(() => { void run(); }, [run]);
  return (
    <div className="space-y-6">
      <Card title="Readiness" subtitle="The same checks as /readyz. Configured is not the same as healthy, and unhealthy stays visible.">
        {data.sections.readiness.status !== "ok" || !data.readiness ? <Unavailable what="Readiness checks" {...(data.sections.readiness.reason ? { reason: data.sections.readiness.reason } : {})} /> : (
          <>
            <div className="mb-3"><StatusPill tone={data.readiness.ok ? "ok" : "bad"}>{data.readiness.ok ? "All checks passing" : "Not ready"}</StatusPill></div>
            <ul className="grid gap-2 sm:grid-cols-2">{data.readiness.checks.map((c) => <li key={c.name} className="flex items-center justify-between gap-2 rounded-ctl border border-line bg-surface-2 px-3 py-2 text-sm"><span>{c.name.replace(/_/g, " ")}</span><StatusPill tone={c.ok ? "ok" : "bad"}>{c.ok ? "ok" : (c.code ?? "failing")}</StatusPill></li>)}</ul>
          </>
        )}
      </Card>
      <Card title="Live probes" subtitle="Requests made by this page just now. A failure to reach the gateway is shown as unreachable, never as healthy." action={<button type="button" onClick={() => void run()} className="rounded-ctl border border-line px-3 py-1.5 text-sm hover:border-accent">Re-check</button>}>
        {probes === null ? <p className="text-sm text-muted" role="status">Checking…</p> : (
          <ul className="space-y-2">{probes.map((p) => (
            <li key={p.path} className="flex flex-wrap items-center justify-between gap-2 rounded-ctl border border-line bg-surface-2 px-3 py-2 text-sm">
              <span className="font-mono">{p.path}</span>
              <span className="flex items-center gap-3"><span className="text-xs text-muted">checked {clockTime(p.checkedAt)}</span><StatusPill tone={p.ok ? "ok" : "bad"}>{p.status === null ? "unreachable" : `${p.ok ? "ok" : "failing"} · HTTP ${p.status}`}</StatusPill></span>
            </li>
          ))}</ul>
        )}
      </Card>
      <Card title="Infrastructure">
        {data.infrastructure ? (
          <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-3">
            <div><dt className="text-xs text-muted">Agents</dt><dd>{data.infrastructure.agents.online} online of {data.infrastructure.agents.registered} registered</dd></div>
            <div><dt className="text-xs text-muted">Executors</dt><dd>{data.infrastructure.executors.configured} configured of {data.infrastructure.executors.total} · {data.infrastructure.executors.attestedRuntimes} attested runtimes</dd></div>
            <div><dt className="text-xs text-muted">Connectors</dt><dd>{data.infrastructure.connectors.enabled} enabled of {data.infrastructure.connectors.registered} · {data.infrastructure.connectors.activeSessions} active sessions</dd></div>
          </dl>
        ) : <Unavailable what="Infrastructure summary" />}
      </Card>
    </div>
  );
}
