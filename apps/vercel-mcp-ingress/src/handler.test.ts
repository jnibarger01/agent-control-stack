import { describe, expect, it, vi } from "vitest";
import {
  MAX_BRIDGE_ENVELOPE_BYTES,
  VERCEL_BRIDGE_PROTOCOL_VERSION,
  type BridgeRequestEnvelope,
  type BridgeResultEnvelope
} from "@agent-control-stack/vercel-bridge-contract";
import { BridgeTimeoutError, createMcpIngressHandler, type BridgeRoundTrip } from "./handler.js";

const endpoint = "https://acs.example.test/api/mcp";

function post(body: unknown, token = "public-secret"): Request {
  return new Request(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

function harness(result: BridgeResultEnvelope) {
  const calls: BridgeRequestEnvelope[] = [];
  const roundTrip: BridgeRoundTrip = vi.fn(async (request) => {
    calls.push(request);
    return result;
  });
  const handler = createMcpIngressHandler({
    publicToken: "public-secret",
    roundTrip,
    idFactory: () => "req_test",
    requestTimeoutMs: 2_000
  });
  return { handler, roundTrip, calls };
}
describe("Vercel MCP ingress", () => {
  it("rejects unauthenticated requests before dispatch", async () => {
    const { handler, roundTrip } = harness({
      protocolVersion: VERCEL_BRIDGE_PROTOCOL_VERSION,
      requestId: "req_test",
      statusCode: 200,
      body: {}
    });
    const response = await handler(
      new Request(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })
      })
    );

    expect(response.status).toBe(401);
    expect(roundTrip).not.toHaveBeenCalled();
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("relays a JSON-RPC request without queueing the bearer token", async () => {
    const rpc = { jsonrpc: "2.0", id: 7, method: "ping" };
    const { handler, calls } = harness({
      protocolVersion: VERCEL_BRIDGE_PROTOCOL_VERSION,
      requestId: "req_test",
      statusCode: 200,
      body: { jsonrpc: "2.0", id: 7, result: {} }
    });

    const response = await handler(post(rpc));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 7, result: {} });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      requestId: "req_test",
      resultTopic: "acs-mcp-result-req_test",
      body: rpc
    });
    expect(JSON.stringify(calls[0])).not.toContain("public-secret");
  });
  it("sets an execution deadline before the public request timeout", async () => {
    const calls: BridgeRequestEnvelope[] = [];
    const handler = createMcpIngressHandler({
      publicToken: "public-secret",
      roundTrip: vi.fn(async (request) => {
        calls.push(request);
        return {
          protocolVersion: VERCEL_BRIDGE_PROTOCOL_VERSION,
          requestId: request.requestId,
          statusCode: 202
        };
      }),
      idFactory: () => "req_deadline",
      now: () => Date.parse("2026-09-18T16:00:00.000Z"),
      requestTimeoutMs: 85_000,
      executionDeadlineMarginMs: 5_000
    });

    await handler(post({ jsonrpc: "2.0", id: 1, method: "ping" }));

    expect(calls[0]?.expiresAt).toBe("2026-09-18T16:01:20.000Z");
  });

  it("preserves bodyless 202 responses", async () => {
    const { handler } = harness({
      protocolVersion: VERCEL_BRIDGE_PROTOCOL_VERSION,
      requestId: "req_test",
      statusCode: 202
    });
    const response = await handler(post({ jsonrpc: "2.0", method: "notifications/initialized" }));

    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });

  it("forwards an ACS WWW-Authenticate challenge", async () => {
    const { handler } = harness({
      protocolVersion: VERCEL_BRIDGE_PROTOCOL_VERSION,
      requestId: "req_test",
      statusCode: 401,
      body: { error: "unauthorized" },
      wwwAuthenticate: 'Bearer error="invalid_token"'
    });
    const response = await handler(post({ jsonrpc: "2.0", id: 3, method: "tools/list" }));

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Bearer error="invalid_token"');
  });

  it("rejects invalid JSON and oversized bodies without dispatch", async () => {
    const { handler, roundTrip } = harness({
      protocolVersion: VERCEL_BRIDGE_PROTOCOL_VERSION,
      requestId: "req_test",
      statusCode: 200,
      body: {}
    });
    const invalid = await handler(
      new Request(endpoint, {
        method: "POST",
        headers: {
          authorization: "Bearer public-secret",
          "content-type": "application/json"
        },
        body: "{"
      })
    );
    expect(invalid.status).toBe(400);
    const oversized = await handler(post({ data: "x".repeat(MAX_BRIDGE_ENVELOPE_BYTES) }));
    expect(oversized.status).toBe(413);
    expect(roundTrip).not.toHaveBeenCalled();
  });

  it("maps bridge timeouts to 504", async () => {
    const handler = createMcpIngressHandler({
      publicToken: "public-secret",
      roundTrip: vi.fn(async () => {
        throw new BridgeTimeoutError("timed out");
      }),
      idFactory: () => "req_timeout",
      requestTimeoutMs: 100
    });

    const response = await handler(post({ jsonrpc: "2.0", id: 9, method: "ping" }));
    expect(response.status).toBe(504);
  });

  it("rejects unsupported methods without dispatch", async () => {
    const { handler, roundTrip } = harness({
      protocolVersion: VERCEL_BRIDGE_PROTOCOL_VERSION,
      requestId: "req_test",
      statusCode: 200
    });
    const response = await handler(new Request(endpoint, { method: "GET" }));

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(roundTrip).not.toHaveBeenCalled();
  });
});
