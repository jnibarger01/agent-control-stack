import { describe, expect, it, vi } from "vitest";
import {
  VERCEL_BRIDGE_PROTOCOL_VERSION,
  VERCEL_BRIDGE_REQUEST_TOPIC,
  type BridgeRequestEnvelope,
  type BridgeResultEnvelope
} from "@agent-control-stack/vercel-bridge-contract";
import {
  MAX_BRIDGE_DELIVERIES,
  InvalidBridgeQueueRequestError,
  createWorkerQueueClient,
  pollBridgeOnce,
  type WorkerQueuePort
} from "./queue-runtime.js";
import type { BridgeReplayPort } from "./worker.js";

const request: BridgeRequestEnvelope = {
  protocolVersion: VERCEL_BRIDGE_PROTOCOL_VERSION,
  requestId: "req_runtime",
  resultTopic: "acs-mcp-result-req_runtime",
  expiresAt: "2099-01-01T00:00:00.000Z",
  body: { jsonrpc: "2.0", id: 1, method: "ping" }
};

const result: BridgeResultEnvelope = {
  protocolVersion: VERCEL_BRIDGE_PROTOCOL_VERSION,
  requestId: request.requestId,
  statusCode: 200,
  body: { jsonrpc: "2.0", id: 1, result: {} }
};

function replay(): BridgeReplayPort {
  let stored: BridgeResultEnvelope | undefined;
  return {
    get: vi.fn(() => stored),
    put: vi.fn((_request, value) => {
      stored = value;
    })
  };
}
describe("worker queue runtime", () => {
  it("creates an unpinned queue client", () => {
    const queue = {} as WorkerQueuePort;
    const factory = vi.fn(() => queue);
    expect(createWorkerQueueClient({ region: "iad1", token: "short-oidc" }, factory)).toBe(queue);
    expect(factory).toHaveBeenCalledWith({
      region: "iad1",
      token: "short-oidc",
      deploymentId: null
    });
  });

  it("processes one request and publishes a correlated result", async () => {
    const send = vi.fn(async () => ({ messageId: "msg_result" }));
    const receive = vi.fn(async (topic, group, handler, options) => {
      expect(topic).toBe(VERCEL_BRIDGE_REQUEST_TOPIC);
      expect(group).toBe("acs-local-bridge");
      expect(options).toMatchObject({
        limit: 1,
        visibilityTimeoutSeconds: 300
      });
      await handler(request, {
        messageId: "msg_request",
        deliveryCount: 1
      });
      return { ok: true as const };
    });
    const queue: WorkerQueuePort = { send, receive };
    const callAcs = vi.fn(async () => result);

    await expect(
      pollBridgeOnce({
        queue,
        replay: replay(),
        callAcs
      })
    ).resolves.toEqual({ ok: true });

    expect(callAcs).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(request.resultTopic, result, {
      idempotencyKey: `result-${request.requestId}`,
      retentionSeconds: 300
    });
  });
  it("rejects auth-mode mismatches before ACS execution", async () => {
    const queue: WorkerQueuePort = {
      send: vi.fn(),
      receive: vi.fn(async (_topic, _group, handler) => {
        await expect(
          handler(request, {
            messageId: "mode-mismatch",
            deliveryCount: 1
          })
        ).rejects.toThrow("missing encrypted authorization");
        return { ok: true as const };
      })
    };
    const callAcs = vi.fn();

    await pollBridgeOnce({
      queue,
      replay: replay(),
      callAcs,
      expectedAuthMode: "oauth"
    });

    expect(callAcs).not.toHaveBeenCalled();
  });

  it("marks malformed queue payloads as non-retryable poison messages", async () => {
    let retry: ((error: unknown, metadata: { deliveryCount: number }) => unknown) | undefined;
    const queue: WorkerQueuePort = {
      send: vi.fn(),
      receive: vi.fn(async (_topic, _group, handler, options) => {
        retry = options?.retry;
        await expect(
          handler(
            { authorization: "Bearer poison" },
            {
              messageId: "bad",
              deliveryCount: 1
            }
          )
        ).rejects.toBeInstanceOf(InvalidBridgeQueueRequestError);
        return { ok: true as const };
      })
    };

    await pollBridgeOnce({
      queue,
      replay: replay(),
      callAcs: vi.fn()
    });

    expect(retry).toBeTypeOf("function");
    expect(retry?.(new InvalidBridgeQueueRequestError(), { deliveryCount: 1 })).toEqual({ acknowledge: true });
    expect(retry?.(new Error("temporary"), { deliveryCount: 2 })).toEqual({ afterSeconds: 4 });
    expect(
      retry?.(new Error("persistent"), {
        deliveryCount: MAX_BRIDGE_DELIVERIES
      })
    ).toEqual({ acknowledge: true });
  });
});
