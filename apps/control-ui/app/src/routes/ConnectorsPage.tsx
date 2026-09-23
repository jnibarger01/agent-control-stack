import { useMemo, useState } from "react";
import {
  connectorsFromRegistry,
  deriveConnectors,
  connectorHealth,
  type ConnectorView,
  type TunnelSessionView
} from "../domain/connectors";
import { formatTime, relativeAge } from "../domain/format";
import { useRouter } from "../router";
import { useConnectors, useLedger } from "../state/data";
import { endpoints } from "../api/endpoints";
import { refreshConnectors } from "../state/connectors-refresh";
import {
  Badge,
  Card,
  EmptyState,
  ErrorState,
  JsonView,
  KV,
  LoadingState,
  MissingContract,
  PageHead,
  Stat
} from "../components/ui";
import { DataTable } from "../components/DataTable";
import { ConfirmDialog } from "../components/Dialog";
import { Tabs } from "../components/Tabs";
import { useToast } from "../components/Toasts";
import { EventTimeline } from "../components/EventTimeline";
import { useStreamTrust } from "../components/Shell";

const healthTone = { healthy: "success", degraded: "warning", idle: "muted", unknown: "neutral" } as const;

export function ConnectorsPage() {
  const { route, go } = useRouter();
  const registry = useConnectors();
  const ledger = useLedger();
  const now = Date.now();
  const auditDerived = useMemo(
    () => (ledger.data ? deriveConnectors(ledger.data.events, now) : []),
    [ledger.data, now]
  );
  // The registry (GET /connectors) is authoritative and complete; the audit log only enriches it
  // with history the registry table doesn't keep (who registered it, rotation reason, request count).
  const connectors = useMemo(
    () => (registry.data ? connectorsFromRegistry(registry.data, auditDerived, now) : []),
    [registry.data, auditDerived, now]
  );
  const hasData = registry.hasData;
  const selected = route.param;
  const current = connectors.find((c) => c.id === selected);
  const activeTunnels = connectors.reduce((n, c) => n + c.tunnels.filter((t) => t.status === "active").length, 0);

  return (
    <div className="page" data-testid="page-connectors">
      <PageHead
        title="Connectors"
        description="Registered connectors and tunnel sessions, read from the connector registry."
      />
      <div className="stat-grid">
        <Stat label="Connectors" value={hasData ? connectors.length : "—"} />
        <Stat
          label="Healthy"
          value={hasData ? connectors.filter((c) => connectorHealth(c, now) === "healthy").length : "—"}
          tone="success"
          note="Active session with a recent heartbeat"
        />
        <Stat label="Active tunnel sessions" value={hasData ? activeTunnels : "—"} />
        <Stat label="Key rotations" value={hasData ? connectors.reduce((n, c) => n + c.keyRotations, 0) : "—"} />
      </div>
      {ledger.data && !ledger.data.complete && (
        <div className="banner" data-tone="warning" role="status">
          <p>
            Only the first {ledger.data.scanned} audit events were scanned. Registration attribution, rotation history
            and request counts may be incomplete for older connectors; the connector and tunnel session list itself is
            still complete.
          </p>
        </div>
      )}
      <MissingContract
        what="Whole-connector revocation"
        detail={
          "There is no route to revoke a whole connector, only individual tunnel sessions. " +
          "Registered-by, rotation history and request counts come from the audit log and can be incomplete " +
          "outside the scanned window; the connector and tunnel session list above is always complete."
        }
      />
      <div className="split" data-open={selected ? "true" : "false"}>
        <Card title="Connectors" labelledBy="h-connectors" flush>
          {registry.error && !hasData ? (
            <ErrorState error={registry.error} onRetry={registry.refetch} what="connectors" />
          ) : !hasData ? (
            <LoadingState label="Loading connectors…" />
          ) : (
            <DataTable
              caption="Connectors"
              rows={connectors}
              rowKey={(c) => c.id}
              selectedKey={selected}
              onRowActivate={(c) => go(`/connectors/${encodeURIComponent(c.id)}`)}
              empty={<EmptyState title="No connectors registered">No connectors are registered with the gateway.</EmptyState>}
              columns={[
                {
                  id: "n",
                  header: "Connector",
                  cell: (c) => (
                    <>
                      <span className="cell-primary">{c.displayName}</span>
                      <span className="cell-sub mono">{c.id}</span>
                    </>
                  )
                },
                { id: "t", header: "Type", cell: () => "connector" },
                {
                  id: "s",
                  header: "Status",
                  cell: (c) => (
                    <Badge
                      meta={{
                        label: c.status === "active" ? "Registered" : c.status === "revoked" ? "Revoked" : "Unknown",
                        tone: c.status === "active" ? "success" : c.status === "revoked" ? "danger" : "neutral"
                      }}
                    />
                  )
                },
                {
                  id: "h",
                  header: "Health",
                  cell: (c) => {
                    const h = connectorHealth(c, now);
                    return <Badge meta={{ label: h[0]!.toUpperCase() + h.slice(1), tone: healthTone[h] }} />;
                  }
                },
                {
                  id: "k",
                  header: "Key",
                  cell: (c) =>
                    c.keyFingerprint ? (
                      <span className="mono" title={c.keyFingerprint}>
                        {c.keyFingerprint.slice(0, 12)}…{c.keyRotations ? ` (rotated ×${c.keyRotations})` : ""}
                      </span>
                    ) : (
                      "—"
                    )
                },
                {
                  id: "tn",
                  header: "Tunnels",
                  cell: (c) => `${c.tunnels.filter((t) => t.status === "active").length} active / ${c.tunnels.length}`
                },
                {
                  id: "act",
                  header: "Last activity",
                  cell: (c) => (c.lastActivityAt ? `${relativeAge(c.lastActivityAt, now)} ago` : "—")
                }
              ]}
            />
          )}
        </Card>
        {selected && (
          <aside className="card detail" aria-label={`Connector ${selected}`}>
            <div className="card-body">
              {current ? (
                <ConnectorDetail key={selected} connector={current} now={now} onClose={() => go("/connectors")} />
              ) : ledger.hasData ? (
                <ErrorState error={new Error(`No audit evidence for connector ${selected}`)} what="connector" />
              ) : (
                <LoadingState />
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
  { id: "tunnels", label: "Tunnel sessions" },
  { id: "events", label: "Audit events" },
  { id: "raw", label: "Raw JSON" }
] as const;

function ConnectorDetail({ connector, now, onClose }: { connector: ConnectorView; now: number; onClose: () => void }) {
  const [tab, setTab] = useState("overview");
  const [revoke, setRevoke] = useState<TunnelSessionView | undefined>(undefined);
  const [rotate, setRotate] = useState(false);
  const [pem, setPem] = useState("");
  const toast = useToast();
  const { trustworthy } = useStreamTrust();
  const ledger = useLedger();
  const events = (ledger.data?.events ?? []).filter(
    (e) => e.attributes?.["connector.id"] === connector.id || e.attributes?.["auth.connector_id"] === connector.id
  );
  const health = connectorHealth(connector, now);
  const stale = "Live event stream is not connected — disabled until state can be trusted.";

  return (
    <div className="stack" data-testid="connector-detail">
      <div className="detail-head">
        <div style={{ minWidth: 0 }}>
          <h2>{connector.displayName}</h2>
          <span className="mono muted">{connector.id}</span>
        </div>
        <div className="row">
          <Badge meta={{ label: health[0]!.toUpperCase() + health.slice(1), tone: healthTone[health] }} />
          <button type="button" className="btn" data-size="sm" onClick={onClose} aria-label="Close detail">
            ✕
          </button>
        </div>
      </div>
      <Tabs tabs={TABS} active={tab} onChange={setTab} label="Connector sections">
        {tab === "overview" && (
          <div className="stack">
            <KV
              items={[
                ["Identity", connector.id],
                [
                  "Registered",
                  connector.registeredAt
                    ? `${formatTime(connector.registeredAt)} by ${connector.registeredBy ?? "unknown (outside scanned audit window)"}`
                    : "—"
                ],
                [
                  "Key fingerprint",
                  <span className="hash" key="f">
                    {connector.keyFingerprint ?? "—"}
                  </span>
                ],
                [
                  "Key rotations",
                  connector.keyRotations
                    ? `${connector.keyRotations} (last ${formatTime(connector.lastRotationAt)}${connector.lastRotationReason ? ` — ${connector.lastRotationReason}` : ""})`
                    : "none"
                ],
                ["Allowed scopes", connector.allowedScopes.length ? connector.allowedScopes.join(", ") : "—"],
                ["Endpoint", "Not recorded: connectors are identified by key and scopes, not by URL"],
                ["Requests", connector.requestCount],
                ["Revocation state", "Connector-level revocation is not exposed by the gateway"]
              ]}
            />
            <p className="hint">
              Key material is never served or displayed; only the public-key fingerprint from the connector registry
              is shown.
            </p>
            <div className="row">
              <button
                type="button"
                className="btn"
                disabled={!trustworthy}
                title={trustworthy ? undefined : stale}
                onClick={() => setRotate(true)}
              >
                Rotate key…
              </button>
            </div>
          </div>
        )}
        {tab === "tunnels" && (
          <DataTable
            caption="Tunnel sessions"
            rows={connector.tunnels}
            rowKey={(t) => `${t.tunnelId}:${t.sessionId}`}
            empty={<EmptyState title="No tunnel sessions" />}
            columns={[
              { id: "t", header: "Tunnel", cell: (t) => <span className="mono">{t.tunnelId}</span> },
              { id: "s", header: "Session", cell: (t) => <span className="mono">{t.sessionId}</span> },
              {
                id: "st",
                header: "State",
                cell: (t) => (
                  <Badge
                    meta={{
                      label: t.status[0]!.toUpperCase() + t.status.slice(1),
                      tone: t.status === "active" ? "success" : t.status === "revoked" ? "danger" : "muted"
                    }}
                  />
                )
              },
              { id: "e", header: "Expires", cell: (t) => formatTime(t.expiresAt) },
              {
                id: "h",
                header: "Heartbeat",
                cell: (t) => (t.lastHeartbeatAt ? `${relativeAge(t.lastHeartbeatAt, now)} ago` : "none")
              },
              {
                id: "a",
                header: "",
                cell: (t) => (
                  <button
                    type="button"
                    className="btn"
                    data-variant="danger"
                    data-size="sm"
                    disabled={t.status !== "active" || !trustworthy}
                    title={t.status !== "active" ? `Session is already ${t.status}` : trustworthy ? undefined : stale}
                    onClick={() => setRevoke(t)}
                  >
                    Revoke…
                  </button>
                )
              }
            ]}
          />
        )}
        {tab === "events" && <EventTimeline events={events} />}
        {tab === "raw" && <JsonView value={connector} label="Raw connector projection" />}
      </Tabs>

      <ConfirmDialog
        open={revoke !== undefined}
        title="Revoke this tunnel session?"
        variant="danger"
        confirmLabel="Revoke session"
        description="The session can no longer authenticate. This cannot be undone; a new session must be registered."
        target={
          revoke ? (
            <KV
              items={[
                [
                  "Connector",
                  <span className="mono" key="c">
                    {connector.id}
                  </span>
                ],
                [
                  "Tunnel",
                  <span className="mono" key="t">
                    {revoke.tunnelId}
                  </span>
                ],
                [
                  "Session",
                  <span className="mono" key="s">
                    {revoke.sessionId}
                  </span>
                ]
              ]}
            />
          ) : null
        }
        onConfirm={async () => {
          if (!revoke) return;
          await endpoints.revokeTunnelSession(connector.id, revoke.tunnelId, revoke.sessionId);
          refreshConnectors(connector.id);
          toast("success", `Revoked session ${revoke.sessionId}.`);
        }}
        onClose={() => setRevoke(undefined)}
      />
      <ConfirmDialog
        open={rotate}
        title="Rotate connector key?"
        variant="danger"
        confirmLabel="Rotate key"
        description="Paste the NEW public key (PEM). Never paste a private key. The old key stops being accepted."
        target={
          <KV
            items={[
              [
                "Connector",
                <span className="mono" key="c">
                  {connector.id}
                </span>
              ],
              [
                "Current fingerprint",
                <span className="hash" key="f">
                  {connector.keyFingerprint ?? "—"}
                </span>
              ]
            ]}
          />
        }
        extra={
          <label className="field">
            <span>New public key (PEM)</span>
            <textarea
              className="textarea"
              value={pem}
              onChange={(e) => setPem(e.target.value)}
              placeholder="-----BEGIN PUBLIC KEY-----"
              spellCheck={false}
              autoComplete="off"
            />
            {/PRIVATE KEY/u.test(pem) && (
              <span className="field-error" role="alert">
                This looks like a private key. Do not paste private keys.
              </span>
            )}
          </label>
        }
        reason={{ label: "Rotation reason", required: true }}
        onConfirm={async (reason) => {
          if (/PRIVATE KEY/u.test(pem)) throw new Error("Refusing to submit a private key.");
          if (!/-----BEGIN PUBLIC KEY-----/u.test(pem))
            throw new Error("Expected a PEM public key (-----BEGIN PUBLIC KEY-----).");
          await endpoints.rotateConnectorKey(connector.id, { publicKeyPem: pem.trim(), reason });
          setPem("");
          refreshConnectors(connector.id);
          toast("success", `Rotated key for ${connector.id}.`);
        }}
        onClose={() => {
          setRotate(false);
          setPem("");
        }}
      />
    </div>
  );
}
