import { describe, expect, it, vi } from "vitest";
import { AcsClient } from "./client";
import { AcsApiError, describeError, kindForStatus } from "./errors";

function respond(status: number, body?: unknown, headers: Record<string, string> = {}): Response {
  return new Response(body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers
  });
}

async function failure(status: number, body?: unknown, headers?: Record<string, string>): Promise<AcsApiError> {
  const client = new AcsClient({ fetcher: async () => respond(status, body, headers) });
  return client.request("/x").then(
    () => {
      throw new Error("expected rejection");
    },
    (error: unknown) => error as AcsApiError
  );
}

describe("error classification keeps authority-relevant classes distinct", () => {
  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [404, "not_found"],
    [409, "conflict"],
    [410, "conflict"],
    [400, "invalid"],
    [422, "invalid"],
    [429, "rate_limited"],
    [503, "unavailable"],
    [500, "server"],
    [502, "server"]
  ])("HTTP %i → %s", async (status, kind) => {
    expect(kindForStatus(status)).toBe(kind);
    expect((await failure(status, { error: "boom", code: "some_code" })).kind).toBe(kind);
  });

  it("preserves the backend code and message and never says 'something went wrong'", async () => {
    const error = await failure(409, { error: "approval already consumed", code: "approval_already_consumed" });
    expect(error.code).toBe("approval_already_consumed");
    expect(describeError(error)).toContain("State conflict");
    expect(describeError(error)).toContain("approval_already_consumed");
    expect(describeError(error)).toContain("approval already consumed");
    expect(describeError(error)).not.toMatch(/something went wrong/i);
  });

  it("reads policy-denial rationale from decision.reason (approve/unblock 403 shape)", async () => {
    const error = await failure(403, {
      decision: { decision: "deny", reason: "destructive command is denied", matchedRules: ["deny:destructive"] },
      workItem: {}
    });
    expect(error.kind).toBe("forbidden");
    expect(error.message).toBe("destructive command is denied");
  });

  it("surfaces retry-after for 429 from the header or the body", async () => {
    expect(
      (await failure(429, { error: "rate limit exceeded", code: "rate_limited" }, { "retry-after": "7" }))
        .retryAfterSeconds
    ).toBe(7);
    expect((await failure(429, { error: "rate limit exceeded", retry_after_seconds: 12 })).retryAfterSeconds).toBe(12);
  });

  it("maps a thrown fetch to a network error and an aborted request to aborted", async () => {
    const offline = new AcsClient({ fetcher: async () => Promise.reject(new TypeError("Failed to fetch")) });
    await expect(offline.request("/x")).rejects.toMatchObject({ kind: "network" });
    const controller = new AbortController();
    controller.abort();
    const aborted = new AcsClient({ fetcher: async () => Promise.reject(new DOMException("aborted", "AbortError")) });
    await expect(aborted.request("/x", { signal: controller.signal })).rejects.toMatchObject({ kind: "aborted" });
  });

  it("only network/503/5xx are retryable; authorization and conflict never are", async () => {
    expect((await failure(500)).retryable).toBe(true);
    expect((await failure(503)).retryable).toBe(true);
    for (const status of [401, 403, 409, 400, 429]) expect((await failure(status)).retryable).toBe(false);
  });
});

describe("request behaviour", () => {
  it("sends cookies same-origin, never an Authorization header, and JSON bodies", async () => {
    const fetcher = vi.fn(async () => respond(200, { ok: true }));
    const client = new AcsClient({ fetcher });
    await client.request("/work-items/wrk_1/approve", { method: "POST", body: { reason: "r", actionHash: "h" } });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/work-items/wrk_1/approve");
    expect(init.credentials).toBe("same-origin");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ reason: "r", actionHash: "h" }));
    expect(Object.keys(init.headers as Record<string, string>).map((k) => k.toLowerCase())).not.toContain(
      "authorization"
    );
  });

  it("builds query strings, dropping empty values", async () => {
    const fetcher = vi.fn(async () => respond(200, {}));
    await new AcsClient({ fetcher }).request("/api/events", { query: { limit: 5, afterSequence: undefined, q: "" } });
    expect((fetcher.mock.calls[0] as unknown as [string])[0]).toBe("/api/events?limit=5");
  });

  it("handles 204, text bodies, and non-JSON success responses", async () => {
    expect(
      await new AcsClient({ fetcher: async () => respond(204) }).request("/session/login", { method: "POST" })
    ).toBeUndefined();
    expect(
      await new AcsClient({ fetcher: async () => respond(200, "# HELP x\nx 1\n") }).request("/metrics", { as: "text" })
    ).toContain("x 1");
    await expect(new AcsClient({ fetcher: async () => respond(200, "<html>") }).request("/x")).rejects.toMatchObject({
      kind: "protocol"
    });
  });

  it("notifies on 401 for authenticated routes but not for a bad login or public probes", async () => {
    const onUnauthorized = vi.fn();
    const onAuthenticated = vi.fn();
    const client = new AcsClient({
      fetcher: async () => respond(401, { error: "unauthorized" }),
      onUnauthorized,
      onAuthenticated
    });
    await client.request("/api/agents").catch(() => undefined);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    await client.request("/session/login", { method: "POST", body: { token: "x" } }).catch(() => undefined);
    await client.request("/readyz").catch(() => undefined);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    const ok = new AcsClient({ fetcher: async () => respond(200, {}), onUnauthorized, onAuthenticated });
    await ok.request("/api/agents");
    await ok.request("/livez");
    expect(onAuthenticated).toHaveBeenCalledTimes(1);
  });
});
