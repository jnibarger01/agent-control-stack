import { Link } from "react-router";
import type { AgentDetail, Connector, ConnectorDetail, Executor, ExecutorDetail, RegistryAgent } from "@agent-control-stack/mission-control-contract";
import { clockTime, formatDuration, relativeTime } from "../../design/format";
import { Card, DataTable, EmptyState, IdChip, Stat, StatusPill, type Tone } from "../../design/primitives";

const nanosToIso = (n?: string) => { try { return n ? new Date(Number(BigInt(n) / 1_000_000n)).toISOString() : undefined; } catch { return undefined; } };

/* ───────────── Agents ───────────── */

const AGENT_TONE: Record<string, Tone> = { AVAILABLE: "ok", BUSY: "info", OFFLINE: "bad", DEGRADED: "warn", UNKNOWN: "unknown" };
export const agentTone = (a: RegistryAgent): Tone => (a.isStale ? "warn" : (AGENT_TONE[a.effectiveStatus] ?? "neutral"));

export function AgentsPage({ agents }: { agents: RegistryAgent[] }) {
  const live = agents.filter((a) => a.effectiveStatus === "AVAILABLE" || a.effectiveStatus === "BUSY");
  const unknown = agents.filter((a) => a.effectiveStatus === "UNKNOWN");
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Registered" value={agents.length} />
        <Stat label="Reporting" value={live.length} note="Available or busy, by heartbeat" />
        <Stat label="Stale" value={agents.filter((a) => a.isStale).length} tone={agents.some((a) => a.isStale) ? "warn" : "neutral"} />
        <Stat label="No heartbeat evidence" value={unknown.length} note="Shown as unknown, never as online" />
      </div>
      <Card title="Agent registry" subtitle="Liveness comes from heartbeat windows. A registered agent without a qualifying heartbeat is not shown as online.">
        {agents.length === 0 ? <EmptyState title="No agents registered" /> : (
          <DataTable
            caption="Registered agents"
            rows={agents}
            rowKey={(a) => a.id}
            columns={[
              { key: "name", header: "Agent", render: (a) => <div><Link to={`/agents/${encodeURIComponent(a.id)}`} className="font-medium hover:text-accent hover:underline">{a.name}</Link><p className="text-xs text-muted">{a.kind} · {a.acpRole.replace(/_/g, " ").toLowerCase()}</p></div> },
              { key: "status", header: "Liveness", render: (a) => <StatusPill tone={agentTone(a)}>{a.isStale ? "stale" : a.effectiveStatus.toLowerCase()}</StatusPill> },
              { key: "hb", header: "Last heartbeat", render: (a) => (a.lastHeartbeatAt ? relativeTime(a.lastHeartbeatAt) : <span className="text-muted">none</span>) },
              { key: "caps", header: "Capabilities", render: (a) => a.capabilities.length }
            ]}
          />
        )}
      </Card>
    </div>
  );
}

export function AgentDetailPage({ data }: { data: AgentDetail }) {
  const a = data.agent;
  return (
    <div className="space-y-6">
      <p><Link to="/agents" className="text-sm text-accent hover:underline">← Back to agents</Link></p>
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><h2 className="text-xl font-semibold tracking-tight">{a.name}</h2><p className="mt-1 text-sm text-muted">{a.kind} · {a.acpRole.replace(/_/g, " ").toLowerCase()} <IdChip id={a.id} /></p></div>
          <StatusPill tone={agentTone(a)}>{a.isStale ? "stale" : a.effectiveStatus.toLowerCase()}</StatusPill>
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
          <div><dt className="text-xs text-muted">Last heartbeat</dt><dd>{a.lastHeartbeatAt ? relativeTime(a.lastHeartbeatAt) : "no heartbeat evidence"}</dd></div>
          <div><dt className="text-xs text-muted">Heartbeat age</dt><dd>{a.heartbeatAgeMs === null || a.heartbeatAgeMs === undefined ? "unknown" : formatDuration(a.heartbeatAgeMs)}</dd></div>
          <div><dt className="text-xs text-muted">Active sessions</dt><dd>{data.activity?.activeSessionCount ?? "unknown"}</dd></div>
          <div><dt className="text-xs text-muted">Last activity</dt><dd>{data.activity?.lastActivityAt ? relativeTime(data.activity.lastActivityAt) : "unknown"}</dd></div>
        </dl>
      </Card>
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        <Card title="Capabilities">
          {a.capabilities.length === 0 ? <EmptyState title="No capabilities declared" /> : (
            <ul className="space-y-2">{a.capabilities.map((c) => <li key={c.name} className="rounded-ctl border border-line bg-surface-2 px-3 py-2 text-sm"><span className="font-medium">{c.name}</span>{c.description && <span className="block text-xs text-muted">{c.description}</span>}</li>)}</ul>
          )}
        </Card>
        <Card title="Recent events" subtitle="Event names only; payloads stay in the audit log.">
          {data.events.length === 0 ? <EmptyState title="No recent events" /> : (
            <ol tabIndex={0} aria-label="Agent events" className="max-h-80 divide-y divide-line/60 overflow-y-auto">
              {data.events.slice(-30).reverse().map((e, i) => <li key={`${e.sequence ?? i}`} className="flex items-center justify-between gap-2 py-2 text-xs"><span className="font-mono">{e.name}</span><time className="text-muted">{clockTime(nanosToIso(e.timeUnixNano))}</time></li>)}
            </ol>
          )}
        </Card>
      </div>
    </div>
  );
}

/* ───────────── Executors ───────────── */

export function ExecutorsPage({ executors }: { executors: Executor[] }) {
  return (
    <div className="space-y-6">
      <Card title="Executors" subtitle="Configured is not the same as healthy: nothing here implies the executor is running.">
        {executors.length === 0 ? <EmptyState title="No executors known" /> : (
          <DataTable
            caption="Execution bridges"
            rows={executors}
            rowKey={(e) => e.id}
            columns={[
              { key: "name", header: "Executor", render: (e) => <div><Link to={`/executors/${encodeURIComponent(e.id)}`} className="font-medium hover:text-accent hover:underline">{e.displayName}</Link><p className="text-xs text-muted">{e.kind}{e.contract ? ` · ${e.contract}` : ""}</p></div> },
              { key: "cfg", header: "Configuration", render: (e) => <StatusPill tone={e.configured ? "info" : "neutral"}>{e.configured ? "configured" : "not configured"}</StatusPill> },
              { key: "status", header: "Status", render: (e) => e.status.replace(/_/g, " ") },
              { key: "caps", header: "Capabilities", render: (e) => <span className="text-xs">{e.capabilityCount ?? "unknown"}{e.unsupportedToolCount ? <span className="text-muted"> · {e.unsupportedToolCount} unsupported</span> : null}</span> }
            ]}
          />
        )}
      </Card>
    </div>
  );
}

export function ExecutorDetailPage({ data }: { data: ExecutorDetail }) {
  const e = data.executor;
  return (
    <div className="space-y-6">
      <p><Link to="/executors" className="text-sm text-accent hover:underline">← Back to executors</Link></p>
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><h2 className="text-xl font-semibold tracking-tight">{e.displayName}</h2><p className="mt-1 text-sm text-muted">{e.kind}{e.contract ? ` · ${e.contract}` : ""} <IdChip id={e.id} /></p></div>
          <StatusPill tone={e.configured ? "info" : "neutral"}>{e.configured ? "configured" : "not configured"}</StatusPill>
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-4 text-sm sm:grid-cols-4">
          <div><dt className="text-xs text-muted">Status</dt><dd>{e.status.replace(/_/g, " ")}</dd></div>
          <div><dt className="text-xs text-muted">Capabilities</dt><dd>{e.capabilityCount ?? "unknown"}</dd></div>
          <div><dt className="text-xs text-muted">Unsupported tools</dt><dd>{e.unsupportedToolCount ?? "unknown"}</dd></div>
          <div><dt className="text-xs text-muted">Scopes</dt><dd>{e.scopes.length ? e.scopes.join(", ") : "none"}</dd></div>
        </dl>
      </Card>
      <Card title="Attested runtimes" subtitle="Configuration and attestation are different facts and are shown separately.">
        {!data.runtimes || data.runtimes.length === 0 ? <EmptyState title="No runtimes registered" /> : (
          <DataTable caption="Runtimes" rows={data.runtimes} rowKey={(r) => r.runtimeId} columns={[
            { key: "id", header: "Runtime", render: (r) => <IdChip id={r.runtimeId} /> },
            { key: "st", header: "Status", render: (r) => <StatusPill tone={r.status === "attested" ? "ok" : r.revokedAt ? "bad" : "warn"}>{r.status}</StatusPill> },
            { key: "att", header: "Attested", render: (r) => (r.attestedAt ? relativeTime(r.attestedAt) : "not attested") },
            { key: "sc", header: "Scopes", render: (r) => (r.scopes.length ? r.scopes.join(", ") : "none") }
          ]} />
        )}
      </Card>
    </div>
  );
}

/* ───────────── Connectors ───────────── */

export function ConnectorsPage({ connectors }: { connectors: Connector[] }) {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Stat label="Registered" value={connectors.length} />
        <Stat label="Active" value={connectors.filter((c) => c.status === "active").length} />
        <Stat label="Active sessions" value={connectors.reduce((n, c) => n + c.activeSessionCount, 0)} />
      </div>
      <Card title="Connectors" subtitle="Key material is never shown, only a fingerprint.">
        {connectors.length === 0 ? <EmptyState title="No connectors registered" /> : (
          <DataTable
            caption="Registered connectors"
            rows={connectors}
            rowKey={(c) => c.id}
            columns={[
              { key: "name", header: "Connector", render: (c) => <div><Link to={`/connectors/${encodeURIComponent(c.id)}`} className="font-medium hover:text-accent hover:underline">{c.displayName}</Link><p className="text-xs text-muted">{c.allowedScopes.length} scope{c.allowedScopes.length === 1 ? "" : "s"}</p></div> },
              { key: "st", header: "Status", render: (c) => <StatusPill tone={c.status === "active" ? "ok" : "bad"}>{c.status}</StatusPill> },
              { key: "sess", header: "Sessions", render: (c) => `${c.activeSessionCount} active of ${c.sessionCount}` },
              { key: "hb", header: "Last heartbeat", render: (c) => (c.lastHeartbeatAt ? relativeTime(c.lastHeartbeatAt) : <span className="text-muted">none</span>) }
            ]}
          />
        )}
      </Card>
    </div>
  );
}

export function ConnectorDetailPage({ data }: { data: ConnectorDetail }) {
  const c = data.connector;
  return (
    <div className="space-y-6">
      <p><Link to="/connectors" className="text-sm text-accent hover:underline">← Back to connectors</Link></p>
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><h2 className="text-xl font-semibold tracking-tight">{c.displayName}</h2><p className="mt-1 text-sm text-muted">Key fingerprint {c.publicKeyFingerprint ? <IdChip id={c.publicKeyFingerprint} /> : "unknown"} <IdChip id={c.id} /></p></div>
          <StatusPill tone={c.status === "active" ? "ok" : "bad"}>{c.status}</StatusPill>
        </div>
        <dl className="mt-4 grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
          <div><dt className="text-xs text-muted">Allowed scopes</dt><dd className="flex flex-wrap gap-1 pt-1">{c.allowedScopes.map((s) => <span key={s} className="rounded-md bg-surface-3 px-1.5 py-0.5 text-xs">{s}</span>)}</dd></div>
          <div><dt className="text-xs text-muted">Next session expiry</dt><dd>{c.nextSessionExpiryAt ? relativeTime(c.nextSessionExpiryAt) : "no active session"}</dd></div>
        </dl>
      </Card>
      <Card title="Tunnel sessions" subtitle={`Effective status accounts for expiry and heartbeat; stored status alone can be stale.${data.sessionWindow && data.sessionWindow.total > data.sessionWindow.shown ? ` Showing ${data.sessionWindow.shown} of ${data.sessionWindow.total} stored sessions, active first.` : ""}`}>
        {data.sessions.length === 0 ? <EmptyState title="No sessions" /> : (
          <DataTable caption="Tunnel sessions" rows={data.sessions} rowKey={(s) => s.sessionId} columns={[
            { key: "id", header: "Session", render: (s) => <IdChip id={s.sessionId} /> },
            { key: "eff", header: "Effective", render: (s) => <StatusPill tone={s.effectiveStatus === "active" ? "ok" : "warn"}>{s.effectiveStatus}{s.staleReason ? ` · ${s.staleReason.replace(/_/g, " ")}` : ""}</StatusPill> },
            { key: "exp", header: "Expires", render: (s) => (s.expiresAt ? relativeTime(s.expiresAt) : "unknown") },
            { key: "hb", header: "Last heartbeat", render: (s) => (s.lastHeartbeatAt ? relativeTime(s.lastHeartbeatAt) : "none") }
          ]} />
        )}
      </Card>
    </div>
  );
}
