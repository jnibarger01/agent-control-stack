/**
 * Per-client OAuth authentication health in the MCP client index.
 *
 * "Reauthentication required" must mean authorization is actually gone. Inactivity, downtime, a dropped
 * connection, an expired-but-renewable access token and missing permissions must all leave a client healthy.
 */
import type { StoredAuditEvent } from "@agent-control-stack/work-items";
import { describe, expect, it } from "vitest";
import { McpClientService } from "./mcp-clients.js";

const T0 = Date.parse("2026-10-17T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** In-memory audit store that feeds the service the way the gateway's live event stream does. */
function harness(start = T0) {
  let clock = start;
  let sequence = 0;
  const events: StoredAuditEvent[] = [];
  const bound: { service?: McpClientService } = {};
  const store = {
    recordSystemEvent(input: { name: string; body: Record<string, unknown> }) {
      const event = {
        sequence: ++sequence,
        name: input.name,
        body: input.body,
        timeUnixNano: String(BigInt(clock) * 1_000_000n)
      } as unknown as StoredAuditEvent;
      events.push(event);
      bound.service?.ingest(event);
      return event;
    },
    readEvents(query: { name?: string; limit?: number; beforeSequence?: number }) {
      return events
        .filter(
          (e) => (!query.name || e.name === query.name) && (!query.beforeSequence || e.sequence < query.beforeSequence)
        )
        .slice(-(query.limit ?? 1000));
    }
  };
  const service = new McpClientService(store as never, "observe", () => clock);
  bound.service = service;
  return {
    service,
    events,
    advance: (ms: number) => void (clock += ms),
    at: () => new Date(clock).toISOString(),
    view: (clientId = "client-chatgpt") => service.list().find((c) => c.clientId === clientId)
  };
}

const base = { lane: "jc" as const, clientId: "client-chatgpt", subject: "chatgpt:jacen" };

describe("MCP client authentication health", () => {
  it("tracks each client independently", () => {
    const h = harness();
    h.service.recordAuthEvent({ ...base, kind: "granted", refreshExpiresAt: new Date(T0 + 30 * DAY).toISOString() });
    h.service.recordAuthEvent({ ...base, clientId: "client-claude", kind: "granted" });
    h.service.recordAuthEvent({ ...base, kind: "refresh_failed", reason: "refresh_reused" });
    expect(h.view("client-chatgpt")?.auth.state).toBe("reauth_required");
    expect(h.view("client-claude")?.auth.state).toBe("ok");
    expect(h.service.summary().reauthRequired).toBe(1);
  });

  it("records the last successful authentication, the failure reason and when it failed", () => {
    const h = harness();
    h.service.recordAuthEvent({ ...base, kind: "granted" });
    const grantedAt = h.at();
    h.advance(2 * HOUR);
    h.service.recordAuthEvent({ ...base, kind: "refresh_failed", reason: "refresh_rejected" });
    expect(h.view()?.auth).toMatchObject({
      state: "reauth_required",
      lastSuccessAt: grantedAt,
      lastFailureAt: h.at(),
      failureReason: "refresh_rejected"
    });
  });

  it.each(["refresh_rejected", "refresh_expired", "refresh_reused", "revoked", "invalid_client"] as const)(
    "a permanent failure (%s) requires reauthentication",
    (reason) => {
      const h = harness();
      h.service.recordAuthEvent({ ...base, kind: "granted" });
      h.service.recordAuthEvent({ ...base, kind: "refresh_failed", reason });
      expect(h.view()?.auth).toMatchObject({ state: "reauth_required", failureReason: reason });
    }
  );

  it("a transient refresh failure (server error / unavailable) does not require reauthentication", () => {
    const h = harness();
    h.service.recordAuthEvent({ ...base, kind: "granted" });
    h.service.recordAuthEvent({ ...base, kind: "refresh_failed", reason: "temporarily_unavailable" });
    expect(h.view()?.auth.state).toBe("ok");
  });

  it("an expired access token is renewable, so it is not a reauthentication failure by itself", () => {
    const h = harness();
    h.service.recordAuthEvent({ ...base, kind: "granted", refreshExpiresAt: new Date(T0 + 30 * DAY).toISOString() });
    h.advance(2 * HOUR);
    h.service.recordAuthEvent({ ...base, kind: "token_rejected", reason: "access_token_expired" });
    expect(h.view()?.auth.state).toBe("ok");
  });

  it("an automatic refresh restores a client and clears the failure", () => {
    const h = harness();
    h.service.recordAuthEvent({ ...base, kind: "granted" });
    h.service.recordAuthEvent({ ...base, kind: "refresh_failed", reason: "refresh_rejected" });
    h.advance(HOUR);
    h.service.recordAuthEvent({ ...base, kind: "granted" });
    expect(h.view()?.auth).toMatchObject({ state: "ok", lastSuccessAt: h.at() });
    expect(h.view()?.auth.failureReason).toBeUndefined();
    expect(h.service.summary().reauthRequired).toBe(0);
  });

  it("inactivity alone never flags a client while its refresh token is still valid", () => {
    const h = harness();
    h.service.recordAuthEvent({ ...base, kind: "granted", refreshExpiresAt: new Date(T0 + 30 * DAY).toISOString() });
    h.advance(20 * DAY);
    expect(h.view()?.live).toBe(false);
    expect(h.view()?.auth.state).toBe("ok");
  });

  it("flags a client once its refresh token has genuinely expired with no renewal", () => {
    const h = harness();
    h.service.recordAuthEvent({ ...base, kind: "granted", refreshExpiresAt: new Date(T0 + 30 * DAY).toISOString() });
    h.advance(31 * DAY);
    expect(h.view()?.auth).toMatchObject({ state: "reauth_required", failureReason: "refresh_expired" });
  });

  it("insufficient permissions and an unlabelled-client denial are not authentication failures", () => {
    const h = harness();
    h.service.recordAuthEvent({ ...base, kind: "granted" });
    h.service.recordAuthEvent({ ...base, kind: "token_rejected", reason: "insufficient_scope" });
    expect(h.view()?.auth.state).toBe("ok");
    expect(h.service.recordAuthEvent({ ...base, kind: "token_rejected", reason: "bad_signature" })).toEqual({
      recorded: false
    });
  });

  it("an explicit revocation requires reauthentication", () => {
    const h = harness();
    h.service.recordAuthEvent({ ...base, kind: "granted" });
    h.service.recordAuthEvent({ ...base, kind: "revoked", reason: "revoked" });
    expect(h.view()?.auth).toMatchObject({ state: "reauth_required", failureReason: "revoked" });
  });

  it("rebuilds the same health from the audit log after a restart", () => {
    const h = harness();
    h.service.recordAuthEvent({ ...base, kind: "granted" });
    h.service.recordAuthEvent({ ...base, kind: "refresh_failed", reason: "refresh_reused" });
    const restarted = new McpClientService(
      {
        recordSystemEvent: () => undefined,
        readEvents: (q: never) => h.events.filter((e) => e.name === (q as { name: string }).name)
      } as never,
      "observe",
      () => T0 + HOUR
    );
    restarted.hydrate();
    expect(restarted.list().find((c) => c.clientId === base.clientId)?.auth).toMatchObject({
      state: "reauth_required",
      failureReason: "refresh_reused"
    });
  });

  it("never stores token material and bounds untrusted fields", () => {
    const h = harness();
    h.service.recordAuthEvent({
      ...base,
      kind: "refresh_failed",
      reason: "refresh_rejected",
      detail: "x".repeat(5_000)
    } as never);
    const body = JSON.stringify(h.events.map((e) => e.body));
    expect(body.length).toBeLessThan(1_500);
    expect(body).not.toMatch(/refresh_token|access_token|Bearer /u);
  });
});
