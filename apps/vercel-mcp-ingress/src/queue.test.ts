import { describe, expect, it, vi } from "vitest";
import {
  VERCEL_BRIDGE_PROTOCOL_VERSION,
  VERCEL_BRIDGE_REQUEST_TOPIC,
  type BridgeRequestEnvelope,
  type BridgeResultEnvelope
} from "@agent-control-stack/vercel-bridge-contract";
import { BridgeTimeoutError } from "./handler.js";
import { createQueueRoundTrip, createVercelQueueRoundTrip, type PollingQueuePort } from "./queue.js";

const request: BridgeRequestEnvelope = {
  protocolVersion: VERCEL_BRIDGE_PROTOCOL_VERSION,
  requestId: "req_abc",
  resultTopic: "acs-mcp-result-req_abc",
  expiresAt: "2026-09-18T02:12:00.000Z",
  body: { jsonrpc: "2.0", id: 1, method: "ping" }
};

function queueHarness(receives: Array<BridgeResultEnvelope | "empty">): { port: PollingQueuePort; sent: unknown[] } {
  const sent: unknown[] = [];
  const port: PollingQueuePort = {
    send: vi.fn(async (topic, payload, options) => {
      sent.push({ topic, payload, options });
      return { messageId: "msg_request" };
    }),
    receive: vi.fn(async (_topic, _group, handler) => {
      const next = receives.shift() ?? "empty";
      if (next === "empty") return { ok: false as const, reason: "empty" as const };
      await handler(next);
      return { ok: true as const };
    })
  };
  return { port, sent };
}
describe("Vercel queue round trip", () => {
  it("creates an unpinned polling client for cross-deployment delivery", () => {
    const { port } = queueHarness([]);
    const factory = vi.fn(() => port);

    createVercelQueueRoundTrip({ region: "iad1", token: "short-lived-oidc" }, factory);

    expect(factory).toHaveBeenCalledWith({
      region: "iad1",
      token: "short-lived-oidc",
      deploymentId: null
    });
  });

  it("sends the request with an idempotency key and returns the correlated result", async () => {
    const result: BridgeResultEnvelope = {
      protocolVersion: VERCEL_BRIDGE_PROTOCOL_VERSION,
      requestId: request.requestId,
      statusCode: 200,
      body: { jsonrpc: "2.0", id: 1, result: {} }
    };
    const { port, sent } = queueHarness([result]);
    const roundTrip = createQueueRoundTrip(port, {
      consumerGroup: "acs-mcp-ingress",
      pollDelayMs: 0
    });

    await expect(roundTrip(request, 1_000)).resolves.toEqual(result);
    expect(sent).toEqual([
      {
        topic: VERCEL_BRIDGE_REQUEST_TOPIC,
        payload: request,
        options: {
          idempotencyKey: request.requestId,
          retentionSeconds: 300
        }
      }
    ]);
    expect(port.receive).toHaveBeenCalledWith(
      request.resultTopic,
      "acs-mcp-ingress",
      expect.any(Function),
      expect.objectContaining({ limit: 1 })
    );
  });

  it("keeps polling after an empty result queue", async () => {
    const result: BridgeResultEnvelope = {
      protocolVersion: VERCEL_BRIDGE_PROTOCOL_VERSION,
      requestId: request.requestId,
      statusCode: 202
    };
    const { port } = queueHarness(["empty", result]);
    const roundTrip = createQueueRoundTrip(port, {
      consumerGroup: "acs-mcp-ingress",
      pollDelayMs: 0
    });

    await expect(roundTrip(request, 1_000)).resolves.toEqual(result);
    expect(port.receive).toHaveBeenCalledTimes(2);
  });
  it("fails closed on a mismatched result correlation", async () => {
    const mismatched: BridgeResultEnvelope = {
      protocolVersion: VERCEL_BRIDGE_PROTOCOL_VERSION,
      requestId: "req_other",
      statusCode: 200
    };
    const { port } = queueHarness([mismatched]);
    const roundTrip = createQueueRoundTrip(port, {
      consumerGroup: "acs-mcp-ingress",
      pollDelayMs: 0
    });

    await expect(roundTrip(request, 1_000)).rejects.toThrow("bridge result correlation mismatch");
  });

  it("times out when no result arrives", async () => {
    const { port } = queueHarness(["empty", "empty"]);
    const roundTrip = createQueueRoundTrip(port, {
      consumerGroup: "acs-mcp-ingress",
      pollDelayMs: 0,
      now: (() => {
        let value = 0;
        return () => (value += 100);
      })()
    });

    await expect(roundTrip(request, 150)).rejects.toBeInstanceOf(BridgeTimeoutError);
  });

  it("fails closed on an invalid result envelope", async () => {
    const { port } = queueHarness([]);
    vi.mocked(port.receive).mockImplementationOnce(async (_t, _g, handler) => {
      await handler({ requestId: request.requestId, statusCode: 200 });
      return { ok: true };
    });
    const roundTrip = createQueueRoundTrip(port, {
      consumerGroup: "acs-mcp-ingress",
      pollDelayMs: 0
    });

    await expect(roundTrip(request, 1_000)).rejects.toThrow("invalid bridge result");
  });
});
