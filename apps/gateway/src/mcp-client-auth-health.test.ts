/**
 * Per-client OAuth authentication health in the MCP client index.
 *
 * "Reauthentication required" must mean authorization is actually gone. Inactivity, downtime, a dropped
 * connection, an expired-but-renewable access token and missing permissions must all leave a client healthy.
 */
import type { StoredAuditEvent } from "@agent-control-stack/work-items";
import { describe, expect, it } from "vitest";
import { MAX_TRACKED_CLIENTS, McpClientService } from "./mcp-clients.js";

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

  it.each(["refresh_rejected", "refresh_expired", "refresh_reused", "revoked"] as const)(
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

  it("a stale expiry cannot prove authorization is gone when a successful refresh report was lost", () => {
    const h = harness();
    h.service.recordAuthEvent({ ...base, kind: "granted", refreshExpiresAt: new Date(T0 + 30 * DAY).toISOString() });
    h.advance(31 * DAY);
    // A rotation may have succeeded without a report or any subsequent MCP request.
    expect(h.view()?.auth.state).toBe("ok");
    h.service.recordAuthEvent({ ...base, kind: "refresh_failed", reason: "refresh_expired" });
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

  it("invalid_client describes the caller, not the client's authorization, so it never flags the client", () => {
    const h = harness();
    h.service.recordAuthEvent({ ...base, kind: "granted" });
    expect(h.service.recordAuthEvent({ ...base, kind: "refresh_failed", reason: "invalid_client" })).toEqual({
      recorded: false
    });
    expect(h.view()?.auth.state).toBe("ok");
  });

  it("orders by when the edge observed the outcome: a late failure never undoes a newer success, a late success never clears a newer failure", () => {
    const h = harness();
    const t = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
    h.service.recordAuthEvent({ ...base, kind: "refreshed", observedAt: t(2_000) });
    // Observed BEFORE that success but delivered after it (separate fire-and-forget connections).
    h.service.recordAuthEvent({ ...base, kind: "refresh_failed", reason: "refresh_reused", observedAt: t(1_000) });
    expect(h.view()?.auth.state).toBe("ok");
    h.service.recordAuthEvent({ ...base, kind: "refresh_failed", reason: "refresh_reused", observedAt: t(3_000) });
    expect(h.view()?.auth.state).toBe("reauth_required");
    h.service.recordAuthEvent({ ...base, kind: "refreshed", observedAt: t(2_500) });
    expect(h.view()?.auth.state).toBe("reauth_required");
    h.service.recordAuthEvent({ ...base, kind: "granted", observedAt: t(4_000) });
    expect(h.view()?.auth.state).toBe("ok");
  });

  it("ignores an edge clock that disagrees with ours by more than ten minutes", () => {
    const h = harness();
    h.service.recordAuthEvent({ ...base, kind: "granted" });
    h.service.recordAuthEvent({
      ...base,
      kind: "refresh_failed",
      reason: "revoked",
      observedAt: new Date(T0 - 3 * HOUR).toISOString()
    });
    expect(h.view()?.auth.state).toBe("reauth_required");
  });

  it("does not infer expiry from a lossy success stream: a verified request after the stale expiry proves a renewal happened", () => {
    const h = harness();
    // The grant is reported; every later refresh report is lost, so the recorded expiry goes stale.
    h.service.recordAuthEvent({ ...base, kind: "granted", refreshExpiresAt: new Date(T0 + 30 * DAY).toISOString() });
    h.advance(31 * DAY);
    expect(h.view()?.auth.state).toBe("ok"); // silence is not evidence that rotation failed
    h.service.observe({ ...base, method: "initialize" }); // a verified request: the client holds a newer credential
    expect(h.view()?.auth.state).toBe("ok");
  });

  it("an auth-only report does not make a client live; real activity does", () => {
    const h = harness();
    h.service.recordAuthEvent({ ...base, kind: "granted" });
    expect(h.view()?.live).toBe(false);
    h.service.observe({ ...base, method: "initialize" });
    expect(h.view()?.live).toBe(true);
  });

  it("an older failure delivered late never replaces the reason of a newer one", () => {
    const h = harness();
    const t = (ms: number) => new Date(T0 + ms).toISOString();
    h.service.recordAuthEvent({ ...base, kind: "revoked", observedAt: t(5_000) });
    h.service.recordAuthEvent({ ...base, kind: "refresh_failed", reason: "refresh_reused", observedAt: t(1_000) });
    expect(h.view()?.auth).toMatchObject({ failureReason: "revoked", lastFailureAt: t(5_000) });
  });

  it("keeps health per lane: a failure on one lane is not cleared by a success on the other", () => {
    const h = harness();
    h.service.recordAuthEvent({ ...base, lane: "jc", kind: "granted" });
    h.service.recordAuthEvent({ ...base, lane: "dc", kind: "granted" });
    h.service.recordAuthEvent({ ...base, lane: "dc", kind: "revoked" });
    h.advance(1_000);
    h.service.recordAuthEvent({ ...base, lane: "jc", kind: "refreshed" });
    expect(h.view()?.auth).toMatchObject({ state: "reauth_required", lane: "dc", failureReason: "revoked" });
    h.advance(1_000);
    h.service.recordAuthEvent({ ...base, lane: "dc", kind: "granted" });
    expect(h.view()?.auth.state).toBe("ok");
  });

  it("keeps health per authorization: outcomes for a superseded token family are ignored", () => {
    const h = harness();
    h.service.recordAuthEvent({ ...base, kind: "granted", family: "famA" });
    h.advance(1_000);
    h.service.recordAuthEvent({ ...base, kind: "granted", family: "famB" }); // the user reconnected
    h.advance(1_000);
    // The old family's stale token is retried later and fails: it says nothing about the current authorization.
    h.service.recordAuthEvent({ ...base, kind: "refresh_failed", reason: "refresh_reused", family: "famA" });
    expect(h.view()?.auth.state).toBe("ok");
    // A real failure of the current family counts, and an old family's success cannot clear it.
    h.service.recordAuthEvent({ ...base, kind: "refresh_failed", reason: "revoked", family: "famB" });
    h.advance(1_000);
    h.service.recordAuthEvent({ ...base, kind: "refreshed", family: "famA" });
    expect(h.view()?.auth).toMatchObject({ state: "reauth_required", failureReason: "revoked" });
  });

  it("eviction keeps clients with confirmed permanent failures", () => {
    const h = harness();
    h.service.recordAuthEvent({
      ...base,
      clientId: "client-expired",
      kind: "granted",
      refreshExpiresAt: new Date(T0 + HOUR).toISOString()
    });
    h.advance(2 * HOUR);
    h.service.recordAuthEvent({
      ...base,
      clientId: "client-expired",
      kind: "refresh_failed",
      reason: "refresh_expired"
    });
    for (let i = 0; i < MAX_TRACKED_CLIENTS + 5; i += 1) {
      h.advance(10);
      h.service.observe({ ...base, clientId: `client-healthy-${i}`, method: "initialize" });
    }
    expect(h.view("client-expired")?.auth.state).toBe("reauth_required");
    expect(h.service.list().length).toBeLessThanOrEqual(MAX_TRACKED_CLIENTS + 1);
  });

  it("a delayed old grant cannot switch the current family or discard its later failure", () => {
    const h = harness();
    const t = (ms: number) => new Date(T0 + ms).toISOString();
    h.service.recordAuthEvent({ ...base, kind: "granted", family: "new", observedAt: t(2_000) });
    h.service.recordAuthEvent({ ...base, kind: "granted", family: "old", observedAt: t(1_000) });
    h.service.recordAuthEvent({ ...base, kind: "revoked", family: "new", observedAt: t(3_000) });
    expect(h.view()?.auth).toMatchObject({ state: "reauth_required", failureReason: "revoked" });
  });

  it("a new grant resets the superseded family's failure even if that old failure was observed later", () => {
    const h = harness();
    const t = (ms: number) => new Date(T0 + ms).toISOString();
    h.service.recordAuthEvent({ ...base, kind: "granted", family: "old", observedAt: t(1_000) });
    h.service.recordAuthEvent({ ...base, kind: "revoked", family: "old", observedAt: t(3_000) });
    h.service.recordAuthEvent({ ...base, kind: "granted", family: "new", observedAt: t(2_000) });
    expect(h.view()?.auth.state).toBe("ok");
    h.service.recordAuthEvent({ ...base, kind: "revoked", family: "new", observedAt: t(2_500) });
    expect(h.view()?.auth).toMatchObject({ state: "reauth_required", lastFailureAt: t(2_500) });
  });

  it("a familyless outcome cannot clear or flag an identified authorization", () => {
    const h = harness();
    h.service.recordAuthEvent({ ...base, kind: "granted", family: "current" });
    h.advance(1_000);
    h.service.recordAuthEvent({ ...base, kind: "revoked" });
    expect(h.view()?.auth.state).toBe("ok");
    h.service.recordAuthEvent({ ...base, kind: "revoked", family: "current" });
    h.advance(1_000);
    h.service.recordAuthEvent({ ...base, kind: "refreshed" });
    expect(h.view()?.auth.state).toBe("reauth_required");
  });
});
