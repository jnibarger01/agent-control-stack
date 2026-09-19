import type { HealthBundle } from "../state/data";
import { eventStream, useHealth, useMetrics, useRegistryAgents } from "../state/data";
import { useEventStream } from "../state/events";
import { describeError } from "../api/errors";
import { formatTime } from "../domain/format";
import type { Tone } from "../domain/status";
import { Badge, Card, ErrorState, KV, LoadingState, MissingContract, PageHead, Stat } from "../components/ui";
import { DataTable } from "../components/DataTable";

type Probe = { state: "yes" | "no" | "unknown"; detail: string };

function liveProbe(bundle: HealthBundle): Probe {
  if ("error" in bundle.livez) return { state: "unknown", detail: describeError(bundle.livez.error) };
  return bundle.livez.ok
    ? { state: "yes", detail: `/livez → ${bundle.livez.status ?? "alive"}` }
    : { state: "no", detail: "/livez reported not alive" };
}
function readyProbe(bundle: HealthBundle): Probe {
  if ("error" in bundle.readyz) return { state: "unknown", detail: describeError(bundle.readyz.error) };
  return bundle.readyz.httpStatus === 200
    ? { state: "yes", detail: "/readyz → 200: dependencies reachable" }
    : { state: "no", detail: `/readyz → ${bundle.readyz.httpStatus}: a dependency check failed` };
}
function healthyProbe(bundle: HealthBundle): Probe {
  if ("error" in bundle.health) return { state: "unknown", detail: describeError(bundle.health.error) };
  const checks = Object.values(bundle.health.checks ?? {});
  if (checks.length === 0) return { state: "unknown", detail: "/health returned no checks" };
  const ok = bundle.health.ok && checks.every((c) => c.ok);
  return ok
    ? { state: "yes", detail: `${checks.length} checks passing` }
    : { state: "no", detail: `${checks.filter((c) => !c.ok).length} of ${checks.length} checks failing` };
}
const TONE: Record<Probe["state"], Tone> = { yes: "success", no: "danger", unknown: "neutral" };

function Concept({ name, question, probe }: { name: string; question: string; probe: Probe }) {
  const label = probe.state === "yes" ? name : probe.state === "no" ? `NOT ${name}` : "UNKNOWN";
  return (
    <div className="card stat" data-testid={`probe-${name.toLowerCase()}`} data-state={probe.state}>
      <span className="stat-label">{name}</span>
      <span className="stat-value" data-tone={TONE[probe.state] === "neutral" ? undefined : TONE[probe.state]}>
        {label}
      </span>
      <span className="stat-note">{question}</span>
      <span className="stat-note">{probe.detail}</span>
    </div>
  );
}

export function SystemPage() {
  const health = useHealth();
  const metrics = useMetrics();
  const agents = useRegistryAgents();
  const stream = useEventStream(eventStream);

  if (health.error && !health.hasData)
    return <ErrorState error={health.error} onRetry={health.refetch} what="gateway health" />;
  if (!health.data) return <LoadingState />;
  const bundle = health.data;
  const checks = "error" in bundle.health ? {} : (bundle.health.checks ?? {});

  const rows: Array<{ subsystem: string; state: Probe["state"]; detail: string }> = [
    {
      subsystem: "Store: read",
      state: checks.read ? (checks.read.ok ? "yes" : "no") : "unknown",
      detail: checks.read ? (checks.read.ok ? "ok" : String(checks.read.code ?? "failing")) : "not reported"
    },
    {
      subsystem: "Store: write",
      state: checks.write ? (checks.write.ok ? "yes" : "no") : "unknown",
      detail: checks.write ? (checks.write.ok ? "ok" : String(checks.write.code ?? "failing")) : "not reported"
    },
    {
      subsystem: "Audit store (chain integrity)",
      state: checks.auditChain ? (checks.auditChain.ok ? "yes" : "no") : "unknown",
      detail: checks.auditChain
        ? checks.auditChain.ok
          ? "hash chain verified"
          : String(checks.auditChain.code ?? "chain verification failed")
        : "not reported"
    },
    {
      subsystem: "Liveness reconciliation",
      state: checks.liveness ? (checks.liveness.ok ? "yes" : "no") : "unknown",
      detail: checks.liveness ? (checks.liveness.ok ? "ok" : String(checks.liveness.code ?? "failing")) : "not reported"
    },
    ...Object.entries(checks)
      .filter(([name]) => !["read", "write", "auditChain", "liveness"].includes(name))
      .map(([name, c]) => ({
        subsystem: `Check: ${name}`,
        state: (c.ok ? "yes" : "no") as Probe["state"],
        detail: c.ok ? "ok" : String(c.code ?? "failing")
      })),
    {
      subsystem: "Event stream",
      state: stream.status === "live" ? "yes" : stream.status === "stopped" ? "unknown" : "no",
      detail:
        stream.status === "live"
          ? "SSE live, backfilled"
          : `SSE ${stream.status}${stream.lastError ? ` (${stream.lastError})` : ""}`
    },
    {
      subsystem: "Agent registry",
      state: agents.hasData ? "yes" : agents.error ? "no" : "unknown",
      detail: agents.hasData
        ? `${agents.data?.length ?? 0} agents readable`
        : agents.error
          ? describeError(agents.error)
          : "not yet read"
    },
    { subsystem: "Policy service", state: "unknown", detail: "No health signal is exposed for the policy engine" },
    { subsystem: "Connector subsystem", state: "unknown", detail: "No health signal is exposed for connectors" }
  ];

  return (
    <div className="page" data-testid="page-system">
      <PageHead
        title="System"
        description="Gateway and control-plane health. Live, Ready and Healthy are different questions."
        actions={
          <button type="button" className="btn" onClick={health.refetch} disabled={health.isFetching}>
            {health.isFetching ? "Checking…" : "Re-check"}
          </button>
        }
      />
      <div className="stat-grid">
        <Concept name="LIVE" question="Is the gateway process running and answering?" probe={liveProbe(bundle)} />
        <Concept name="READY" question="Can it serve traffic (dependencies reachable)?" probe={readyProbe(bundle)} />
        <Concept name="HEALTHY" question="Do all detailed checks pass?" probe={healthyProbe(bundle)} />
        <Stat
          label="Avg request latency"
          value={
            metrics.data?.summary.avgLatencySeconds !== undefined
              ? `${(metrics.data.summary.avgLatencySeconds * 1000).toFixed(1)} ms`
              : "—"
          }
          note="Since gateway start (/metrics)"
        />
      </div>
      <p className="hint">
        In this gateway version /readyz and /health run the same readiness handler, so READY and HEALTHY normally agree;
        they are shown separately because they answer different questions and can diverge in future versions. Last
        checked {formatTime(bundle.checkedAt, { seconds: true })}.
      </p>
      <Card title="Subsystems" labelledBy="h-sub" flush>
        <DataTable
          caption="Subsystem status"
          rows={rows}
          rowKey={(r) => r.subsystem}
          columns={[
            { id: "s", header: "Subsystem", cell: (r) => r.subsystem },
            {
              id: "st",
              header: "State",
              cell: (r) => (
                <Badge
                  meta={{
                    label: r.state === "yes" ? "Healthy" : r.state === "no" ? "Failing" : "UNKNOWN",
                    tone: TONE[r.state]
                  }}
                />
              )
            },
            { id: "d", header: "Detail", cell: (r) => r.detail }
          ]}
        />
      </Card>
      <div className="layout-grid">
        <div className="span-6">
          <Card title="Runtime" labelledBy="h-runtime">
            <KV
              items={[
                ["Console origin", window.location.origin],
                [
                  "Environment",
                  ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname)
                    ? "local (loopback)"
                    : window.location.hostname
                ],
                [
                  "SQLite ready (metrics)",
                  metrics.data?.summary.sqliteReady === undefined
                    ? "UNKNOWN"
                    : metrics.data.summary.sqliteReady
                      ? "yes"
                      : "no"
                ],
                ["Event stream", stream.status]
              ]}
            />
          </Card>
        </div>
        <div className="span-6">
          <MissingContract
            what="Version, build, configuration identity and incidents"
            detail="The gateway exposes no route for ACS version, build, configuration identity or an incident list. They are shown as unavailable rather than inferred."
          />
        </div>
      </div>
    </div>
  );
}
