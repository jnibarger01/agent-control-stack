import { describe, expect, it } from "vitest";
import { event } from "../test-fixtures";
import { connectorHealth, connectorsFromRegistry, deriveConnectors } from "./connectors";

const NOW = Date.parse("2026-09-19T12:00:00.000Z");
const reg = event(
  "connector.registered",
  { "connector.id": "c1" },
  {
    connectorId: "c1",
    displayName: "Corp DC 1",
    allowedScopes: ["acs:work:read"],
    publicKeyFingerprint: "abc123",
    status: "active",
    actorId: "op"
  },
  "2026-09-19T09:00:00.000Z"
);
const session = (name: string, at: string, extra: Record<string, unknown> = {}) =>
  event(
    name,
    { "connector.id": "c1" },
    {
      connectorId: "c1",
      tunnelId: "t1",
      sessionId: "s1",
      issuedAt: "2026-09-19T09:05:00.000Z",
      expiresAt: "2026-09-19T15:00:00.000Z",
      ...extra
    },
    at
  );

describe("deriveConnectors (audit-derived projection)", () => {
  it("builds identity, scopes, fingerprint and tunnel sessions from events", () => {
    const [c] = deriveConnectors(
      [
        reg,
        session("tunnel_session.registered", "2026-09-19T09:05:00.000Z"),
        session("tunnel_session.heartbeat", "2026-09-19T11:58:00.000Z")
      ],
      NOW
    );
    expect(c).toMatchObject({
      id: "c1",
      displayName: "Corp DC 1",
      allowedScopes: ["acs:work:read"],
      keyFingerprint: "abc123",
      status: "active",
      registeredBy: "op"
    });
    expect(c!.tunnels).toHaveLength(1);
    expect(c!.tunnels[0]).toMatchObject({ tunnelId: "t1", sessionId: "s1", status: "active" });
    expect(connectorHealth(c!, NOW)).toBe("healthy");
  });
  it("never contains key material — only the fingerprint from the log", () => {
    const [c] = deriveConnectors([reg], NOW);
    expect(JSON.stringify(c)).not.toMatch(/BEGIN (PUBLIC|PRIVATE) KEY/);
  });
  it("tracks key rotations", () => {
    const rotated = event(
      "connector.key_rotated",
      { "connector.id": "c1" },
      { connectorId: "c1", reason: "scheduled", publicKeyFingerprint: "def456" },
      "2026-09-19T10:00:00.000Z"
    );
    const [c] = deriveConnectors([reg, rotated], NOW);
    expect(c).toMatchObject({ keyRotations: 1, keyFingerprint: "def456", lastRotationReason: "scheduled" });
  });
  it("a revoked session is revoked; an expired one is expired; neither counts as active", () => {
    const revoked = session("tunnel_session.revoked", "2026-09-19T11:00:00.000Z", { status: "revoked" });
    const expired = event(
      "tunnel_session.registered",
      { "connector.id": "c1" },
      { connectorId: "c1", tunnelId: "t2", sessionId: "s2", expiresAt: "2026-09-19T08:00:00.000Z" },
      "2026-09-19T07:00:00.000Z"
    );
    const [c] = deriveConnectors(
      [reg, session("tunnel_session.registered", "2026-09-19T09:05:00.000Z"), revoked, expired],
      NOW
    );
    const byId = Object.fromEntries(c!.tunnels.map((t) => [t.sessionId, t.status]));
    expect(byId).toEqual({ s1: "revoked", s2: "expired" });
    expect(connectorHealth(c!, NOW)).toBe("idle");
  });
  it("health is evidence-based: no recent heartbeat is degraded, unknown registration is unknown", () => {
    const [stale] = deriveConnectors([reg, session("tunnel_session.registered", "2026-09-19T09:05:00.000Z")], NOW);
    expect(connectorHealth(stale!, NOW)).toBe("degraded");
    const [ghost] = deriveConnectors(
      [event("connector.requested", { "connector.id": "c9" }, {}, "2026-09-19T11:00:00.000Z")],
      NOW
    );
    expect(ghost).toMatchObject({ id: "c9", status: "unknown", requestCount: 1 });
    expect(connectorHealth(ghost!, NOW)).toBe("unknown");
  });
  it("orders by last activity", () => {
    const other = event(
      "connector.registered",
      { "connector.id": "c2" },
      { connectorId: "c2", displayName: "B" },
      "2026-09-19T11:30:00.000Z"
    );
    expect(deriveConnectors([reg, other], NOW).map((c) => c.id)).toEqual(["c2", "c1"]);
  });
});

describe("connectorsFromRegistry (authoritative registry + audit enrichment)", () => {
  it("shows a registered connector even when its audit events fell outside the scanned window", () => {
    const [c] = connectorsFromRegistry(
      [
        {
          id: "c1",
          displayName: "Corp DC 1",
          allowedScopes: ["acs:work:read"],
          publicKeyFingerprint: "fp1",
          status: "active",
          createdAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-01T00:00:00.000Z",
          tunnelSessions: []
        }
      ],
      [],
      NOW
    );
    expect(c).toMatchObject({
      id: "c1",
      displayName: "Corp DC 1",
      keyFingerprint: "fp1",
      status: "active",
      registeredBy: undefined,
      registeredAt: "2026-09-01T00:00:00.000Z"
    });
  });

  it("never carries key material, only the registry fingerprint", () => {
    const [c] = connectorsFromRegistry(
      [
        {
          id: "c1",
          displayName: "Corp DC 1",
          allowedScopes: ["acs:work:read"],
          publicKeyFingerprint: "fp1",
          status: "active",
          createdAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-01T00:00:00.000Z",
          tunnelSessions: []
        }
      ],
      [],
      NOW
    );
    expect(JSON.stringify(c)).not.toMatch(/BEGIN (PUBLIC|PRIVATE) KEY/);
  });

  it("enriches registry connectors with registeredBy and rotation history from the audit log", () => {
    const [auditView] = deriveConnectors(
      [
        reg,
        event(
          "connector.key_rotated",
          { "connector.id": "c1" },
          { connectorId: "c1", reason: "scheduled", publicKeyFingerprint: "def456" },
          "2026-09-19T10:00:00.000Z"
        )
      ],
      NOW
    );
    const [merged] = connectorsFromRegistry(
      [
        {
          id: "c1",
          displayName: "Corp DC 1",
          allowedScopes: ["acs:work:read"],
          publicKeyFingerprint: "def456",
          status: "active",
          createdAt: "2026-09-19T09:00:00.000Z",
          updatedAt: "2026-09-19T10:00:00.000Z",
          tunnelSessions: []
        }
      ],
      [auditView!],
      NOW
    );
    expect(merged).toMatchObject({
      registeredBy: "op",
      keyRotations: 1,
      lastRotationReason: "scheduled",
      // The registry fingerprint wins even though the audit projection also carries one.
      keyFingerprint: "def456"
    });
  });

  it("marks a registry tunnel session expired once past its expiry, without needing a heartbeat event", () => {
    const [c] = connectorsFromRegistry(
      [
        {
          id: "c1",
          displayName: "Corp DC 1",
          allowedScopes: ["acs:work:read"],
          publicKeyFingerprint: "fp1",
          status: "active",
          createdAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-01T00:00:00.000Z",
          tunnelSessions: [
            {
              connectorId: "c1",
              tunnelId: "t1",
              sessionId: "s1",
              status: "active",
              issuedAt: "2026-09-19T09:00:00.000Z",
              expiresAt: "2026-09-19T10:00:00.000Z",
              createdAt: "2026-09-19T09:00:00.000Z",
              updatedAt: "2026-09-19T09:00:00.000Z"
            }
          ]
        }
      ],
      [],
      NOW
    );
    expect(c!.tunnels[0]).toMatchObject({ sessionId: "s1", status: "expired" });
  });
});
