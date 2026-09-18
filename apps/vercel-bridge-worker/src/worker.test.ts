import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  VERCEL_BRIDGE_PROTOCOL_VERSION,
  createBridgeAuthorizationAad,
  sealBridgeAuthorization,
  type BridgeRequestEnvelope,
  type BridgeResultEnvelope
} from "@agent-control-stack/vercel-bridge-contract";
import {
  createEncryptedAuthorizationResolver,
  createLocalAcsCaller,
  processBridgeRequest,
  type BridgeReplayPort,
  type ResultPublisher
} from "./worker.js";

const request: BridgeRequestEnvelope = {
  protocolVersion: VERCEL_BRIDGE_PROTOCOL_VERSION,
  requestId: "req_worker",
  resultTopic: "acs-mcp-result-req_worker",
  expiresAt: "2099-01-01T00:00:00.000Z",
  body: { jsonrpc: "2.0", id: 1, method: "tools/list" }
};

const success: BridgeResultEnvelope = {
  protocolVersion: VERCEL_BRIDGE_PROTOCOL_VERSION,
  requestId: request.requestId,
  statusCode: 200,
  body: { jsonrpc: "2.0", id: 1, result: { tools: [] } }
};

function replayHarness(existing?: BridgeResultEnvelope) {
  let stored = existing;
  const order: string[] = [];
  const replay: BridgeReplayPort = {
    get: vi.fn(() => stored),
    put: vi.fn((_request, result) => {
      order.push("store");
      stored = result;
    })
  };
  return {
    replay,
    order,
    get stored() {
      return stored;
    }
  };
}

function publisherHarness(order: string[], fail = false) {
  const publisher: ResultPublisher = vi.fn(async () => {
    order.push("publish");
    if (fail) throw new Error("publish failed");
  });
  return publisher;
}
describe("bridge request processing", () => {
  it("replays a completed result without calling ACS again", async () => {
    const h = replayHarness(success);
    const publisher = publisherHarness(h.order);
    const callAcs = vi.fn();

    await processBridgeRequest(request, {
      replay: h.replay,
      callAcs,
      publishResult: publisher
    });

    expect(callAcs).not.toHaveBeenCalled();
    expect(h.replay.put).not.toHaveBeenCalled();
    expect(publisher).toHaveBeenCalledWith(request.resultTopic, success, request.requestId);
  });

  it("stores the ACS result before publishing it", async () => {
    const h = replayHarness();
    const publisher = publisherHarness(h.order);
    const callAcs = vi.fn(async () => success);

    await processBridgeRequest(request, {
      replay: h.replay,
      callAcs,
      publishResult: publisher
    });

    expect(h.order).toEqual(["store", "publish"]);
    expect(h.stored).toEqual(success);
  });

  it("keeps the stored result when publishing fails so redelivery does not re-execute", async () => {
    const h = replayHarness();
    const callAcs = vi.fn(async () => success);
    const failingPublisher = publisherHarness(h.order, true);

    await expect(
      processBridgeRequest(request, {
        replay: h.replay,
        callAcs,
        publishResult: failingPublisher
      })
    ).rejects.toThrow("publish failed");
    expect(h.stored).toEqual(success);

    h.order.length = 0;
    const publisher = publisherHarness(h.order);
    await processBridgeRequest(request, {
      replay: h.replay,
      callAcs,
      publishResult: publisher
    });
    expect(callAcs).toHaveBeenCalledTimes(1);
    expect(h.order).toEqual(["publish"]);
  });
  it("never executes a new request after its ingress deadline", async () => {
    const expiredRequest = {
      ...request,
      expiresAt: "2026-09-18T02:12:00.000Z"
    };
    const h = replayHarness();
    const publisher = publisherHarness(h.order);
    const callAcs = vi.fn(async () => success);

    await processBridgeRequest(expiredRequest, {
      replay: h.replay,
      callAcs,
      publishResult: publisher,
      now: () => Date.parse("2026-09-18T02:12:01.000Z")
    });

    expect(callAcs).not.toHaveBeenCalled();
    expect(h.stored).toMatchObject({
      requestId: expiredRequest.requestId,
      statusCode: 504,
      body: { error: "bridge_request_expired" }
    });
    expect(h.order).toEqual(["store", "publish"]);
  });

  it("does not persist or publish when the local ACS call fails", async () => {
    const h = replayHarness();
    const publisher = publisherHarness(h.order);
    const callAcs = vi.fn(async () => {
      throw new Error("ACS unavailable");
    });

    await expect(
      processBridgeRequest(request, {
        replay: h.replay,
        callAcs,
        publishResult: publisher
      })
    ).rejects.toThrow("ACS unavailable");
    expect(h.replay.put).not.toHaveBeenCalled();
    expect(publisher).not.toHaveBeenCalled();
  });
});

describe("local ACS caller", () => {
  it("signs a fresh tunnel assertion and returns only the allowed response fields", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const privateKeyPem = String(privateKey.export({ type: "pkcs8", format: "pem" }));
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("x-acs-issued-at")).toBe("2026-09-18T02:10:00.000Z");
      expect(headers.get("x-acs-signature")).toMatch(/^ed25519=/);
      expect(headers.get("authorization")).toBeNull();
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }), {
        status: 401,
        headers: {
          "content-type": "application/json",
          "www-authenticate": 'Bearer error="invalid_token"',
          "set-cookie": "never-forward-me=1"
        }
      });
    });
    const call = createLocalAcsCaller({
      url: "http://127.0.0.1:8080/mcp",
      connectorId: "vercel-prod",
      tunnelId: "tunnel_1",
      sessionId: "session_1",
      privateKeyPem,
      fetchFn,
      now: () => new Date("2026-09-18T02:10:00.000Z")
    });

    const result = await call(request);
    expect(result).toEqual({
      protocolVersion: VERCEL_BRIDGE_PROTOCOL_VERSION,
      requestId: request.requestId,
      statusCode: 401,
      body: { jsonrpc: "2.0", id: 1, result: { tools: [] } },
      wwwAuthenticate: 'Bearer error="invalid_token"'
    });
  });

  it("decrypts OAuth bearer auth locally and omits tunnel headers", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("x25519");
    const privateKeyPem = String(privateKey.export({ type: "pkcs8", format: "pem" }));
    const oauthRequest: BridgeRequestEnvelope = {
      ...request,
      requestId: "req_oauth_worker",
      resultTopic: "acs-mcp-result-req_oauth_worker"
    };
    oauthRequest.auth = sealBridgeAuthorization(
      "Bearer oauth-access-token",
      String(publicKey.export({ type: "spki", format: "pem" })),
      createBridgeAuthorizationAad({
        requestId: oauthRequest.requestId,
        resultTopic: oauthRequest.resultTopic,
        expiresAt: oauthRequest.expiresAt
      })
    );
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer oauth-access-token");
      expect(headers.get("x-acs-signature")).toBeNull();
      expect(headers.get("x-acs-connector-id")).toBeNull();
      return Response.json({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
    });
    const call = createLocalAcsCaller({
      url: "http://127.0.0.1:8080/mcp",
      authorizationResolver: createEncryptedAuthorizationResolver(privateKeyPem),
      fetchFn
    });

    await expect(call(oauthRequest)).resolves.toMatchObject({
      requestId: oauthRequest.requestId,
      statusCode: 200
    });
  });

  it("bounds the local ACS fetch with an AbortSignal", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.signal?.aborted).toBe(false);
      return new Response(null, { status: 202 });
    });
    const call = createLocalAcsCaller({
      url: "http://127.0.0.1:8080/mcp",
      connectorId: "vercel-prod",
      tunnelId: "tunnel_1",
      sessionId: "session_1",
      privateKeyPem: String(privateKey.export({ type: "pkcs8", format: "pem" })),
      maxCallDurationMs: 1_000,
      fetchFn
    });

    await call(request);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("never calls ACS after the execution deadline has passed", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const fetchFn = vi.fn();
    const call = createLocalAcsCaller({
      url: "http://127.0.0.1:8080/mcp",
      connectorId: "vercel-prod",
      tunnelId: "tunnel_1",
      sessionId: "session_1",
      privateKeyPem: String(privateKey.export({ type: "pkcs8", format: "pem" })),
      now: () => new Date("2026-09-18T02:12:01.000Z"),
      fetchFn
    });

    await expect(
      call({
        ...request,
        expiresAt: "2026-09-18T02:12:00.000Z"
      })
    ).rejects.toThrow("expired before local ACS call");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("accepts bodyless ACS responses", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const call = createLocalAcsCaller({
      url: "http://localhost:8080/mcp",
      connectorId: "vercel-prod",
      tunnelId: "tunnel_1",
      sessionId: "session_1",
      privateKeyPem: String(privateKey.export({ type: "pkcs8", format: "pem" })),
      fetchFn: vi.fn(async () => new Response(null, { status: 202 }))
    });

    await expect(call(request)).resolves.toMatchObject({
      requestId: request.requestId,
      statusCode: 202
    });
  });

  it("rejects non-loopback ACS URLs", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    expect(() =>
      createLocalAcsCaller({
        url: "https://example.com/mcp",
        connectorId: "vercel-prod",
        tunnelId: "tunnel_1",
        sessionId: "session_1",
        privateKeyPem: String(privateKey.export({ type: "pkcs8", format: "pem" }))
      })
    ).toThrow("loopback");
  });
});
