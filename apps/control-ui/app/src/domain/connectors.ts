import type { ConnectorSummary, StoredAuditEvent } from "../api/types";
import { eventTimeMs } from "../state/reconcile";

export interface TunnelSessionView {
  connectorId: string;
  tunnelId: string;
  sessionId: string;
  status: "active" | "revoked" | "expired";
  issuedAt: string | undefined;
  expiresAt: string | undefined;
  lastHeartbeatAt: string | undefined;
  revokedAt: string | undefined;
}

export interface ConnectorView {
  id: string;
  displayName: string;
  allowedScopes: string[];
  /** Public-key fingerprint from the audit log. Key material itself is never served or shown. */
  keyFingerprint: string | undefined;
  keyRotations: number;
  lastRotationAt: string | undefined;
  lastRotationReason: string | undefined;
  registeredAt: string | undefined;
  registeredBy: string | undefined;
  /**
   * "active"/"revoked" when read from the authoritative connector registry;
   * "unknown" only applies to the audit-only fallback, when registration fell
   * outside the scanned window.
   */
  status: "active" | "revoked" | "unknown";
  tunnels: TunnelSessionView[];
  requestCount: number;
  lastActivityAt: string | undefined;
  lastError: string | undefined;
}

function rec(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
const str = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);
const iso = (event: StoredAuditEvent): string => new Date(eventTimeMs(event)).toISOString();

/**
 * The gateway serves no connector-list route, so connector state is
 * reconstructed from the append-only audit log (connector.* and
 * tunnel_session.* events). This is an audit-derived projection and the UI
 * labels it as such; it can only be as complete as the scanned event window.
 */
export function deriveConnectors(events: readonly StoredAuditEvent[], now: number): ConnectorView[] {
  const connectors = new Map<string, ConnectorView>();
  const sessions = new Map<string, TunnelSessionView>();
  const ensure = (id: string): ConnectorView => {
    let view = connectors.get(id);
    if (!view) {
      view = {
        id,
        displayName: id,
        allowedScopes: [],
        keyFingerprint: undefined,
        keyRotations: 0,
        lastRotationAt: undefined,
        lastRotationReason: undefined,
        registeredAt: undefined,
        registeredBy: undefined,
        status: "unknown",
        tunnels: [],
        requestCount: 0,
        lastActivityAt: undefined,
        lastError: undefined
      };
      connectors.set(id, view);
    }
    return view;
  };

  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    const body = rec(event.body);
    const connectorId =
      str(event.attributes?.["connector.id"]) ?? str(event.attributes?.["auth.connector_id"]) ?? str(body.connectorId);
    if (!connectorId) continue;
    const view = ensure(connectorId);
    const at = iso(event);
    if (event.name.startsWith("connector.") || event.name.startsWith("tunnel_session.")) view.lastActivityAt = at;
    if (event.name === "connector.registered") {
      view.displayName = str(body.displayName) ?? view.displayName;
      view.allowedScopes = Array.isArray(body.allowedScopes)
        ? body.allowedScopes.filter((s): s is string => typeof s === "string")
        : view.allowedScopes;
      view.keyFingerprint = str(body.publicKeyFingerprint) ?? view.keyFingerprint;
      view.registeredAt = at;
      view.registeredBy = str(body.actorId);
      view.status = "active";
    } else if (event.name === "connector.key_rotated") {
      view.keyRotations += 1;
      view.keyFingerprint = str(body.publicKeyFingerprint) ?? view.keyFingerprint;
      view.lastRotationAt = at;
      view.lastRotationReason = str(body.reason);
    } else if (event.name === "connector.requested") {
      view.requestCount += 1;
      view.lastActivityAt = at;
    } else if (event.name.startsWith("tunnel_session.")) {
      const tunnelId = str(body.tunnelId) ?? str(event.attributes?.["tunnel.id"]);
      const sessionId =
        str(body.sessionId) ?? str(event.attributes?.["tunnel_session.id"]) ?? str(event.attributes?.["session.id"]);
      if (!tunnelId || !sessionId) continue;
      const key = JSON.stringify([connectorId, tunnelId, sessionId]);
      const previous = sessions.get(key);
      const session: TunnelSessionView = previous ?? {
        connectorId,
        tunnelId,
        sessionId,
        status: "active",
        issuedAt: undefined,
        expiresAt: undefined,
        lastHeartbeatAt: undefined,
        revokedAt: undefined
      };
      session.issuedAt = str(body.issuedAt) ?? session.issuedAt;
      session.expiresAt = str(body.expiresAt) ?? session.expiresAt;
      if (event.name === "tunnel_session.heartbeat") session.lastHeartbeatAt = str(body.lastHeartbeatAt) ?? at;
      if (event.name === "tunnel_session.revoked" || str(body.status) === "revoked") {
        session.status = "revoked";
        session.revokedAt = at;
      }
      sessions.set(key, session);
    }
  }

  for (const session of sessions.values()) {
    if (session.status === "active" && session.expiresAt && Date.parse(session.expiresAt) <= now)
      session.status = "expired";
    ensure(session.connectorId).tunnels.push(session);
  }
  for (const view of connectors.values()) {
    view.tunnels.sort((a, b) => (b.issuedAt ?? "").localeCompare(a.issuedAt ?? ""));
  }
  return [...connectors.values()].sort(
    (a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? "") || a.id.localeCompare(b.id)
  );
}

export type ConnectorHealth = "healthy" | "degraded" | "idle" | "unknown";

/** Health is evidence-based: an active, unexpired tunnel session that heartbeated recently. Otherwise idle/unknown, never assumed healthy. */
export function connectorHealth(
  connector: ConnectorView,
  now: number,
  heartbeatWindowMs = 5 * 60_000
): ConnectorHealth {
  if (connector.status === "unknown") return "unknown";
  const active = connector.tunnels.filter((t) => t.status === "active");
  if (active.length === 0) return "idle";
  const recent = active.some((t) => t.lastHeartbeatAt && now - Date.parse(t.lastHeartbeatAt) <= heartbeatWindowMs);
  return recent ? "healthy" : "degraded";
}

/**
 * GET /connectors is the authoritative source: every registered connector and
 * its current tunnel sessions, with no dependency on how much of the audit
 * log was scanned. The audit-derived projection still carries history the
 * registry table doesn't keep (who registered it, rotation count/reason,
 * request volume), so it's merged in here purely as enrichment — it can never
 * remove a connector the registry reports, and it never overrides registry
 * fields the registry actually has (identity, scopes, fingerprint, tunnels).
 */
export function connectorsFromRegistry(
  summaries: readonly ConnectorSummary[],
  auditDerived: readonly ConnectorView[],
  now: number
): ConnectorView[] {
  const auditById = new Map(auditDerived.map((view) => [view.id, view]));
  return summaries
    .map((summary): ConnectorView => {
      const audit = auditById.get(summary.id);
      return {
        id: summary.id,
        displayName: summary.displayName,
        allowedScopes: summary.allowedScopes,
        keyFingerprint: summary.publicKeyFingerprint,
        keyRotations: audit?.keyRotations ?? 0,
        lastRotationAt: audit?.lastRotationAt,
        lastRotationReason: audit?.lastRotationReason,
        registeredAt: audit?.registeredAt ?? summary.createdAt,
        registeredBy: audit?.registeredBy,
        status: summary.status,
        tunnels: summary.tunnelSessions
          .map(
            (session): TunnelSessionView => ({
              connectorId: summary.id,
              tunnelId: session.tunnelId,
              sessionId: session.sessionId,
              status:
                session.status === "active" && session.expiresAt && Date.parse(session.expiresAt) <= now
                  ? "expired"
                  : session.status,
              issuedAt: session.issuedAt,
              expiresAt: session.expiresAt,
              lastHeartbeatAt: session.lastHeartbeatAt,
              revokedAt: session.status === "revoked" ? session.updatedAt : undefined
            })
          )
          .sort((a, b) => (b.issuedAt ?? "").localeCompare(a.issuedAt ?? "")),
        requestCount: audit?.requestCount ?? 0,
        lastActivityAt: audit?.lastActivityAt ?? summary.updatedAt,
        lastError: audit?.lastError
      };
    })
    .sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? "") || a.id.localeCompare(b.id));
}
