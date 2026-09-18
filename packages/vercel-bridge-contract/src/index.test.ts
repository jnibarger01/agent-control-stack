import { describe, expect, it } from "vitest";
import {
  MAX_BRIDGE_ENVELOPE_BYTES,
  VERCEL_BRIDGE_PROTOCOL_VERSION,
  VERCEL_BRIDGE_REQUEST_TOPIC,
  bridgeRequestEnvelopeSchema,
  bridgeResultEnvelopeSchema,
  serializedEnvelopeBytes
} from "./index.js";

describe("Vercel bridge contract", () => {
  it("accepts a bounded request envelope", () => {
    const parsed = bridgeRequestEnvelopeSchema.parse({
      protocolVersion: VERCEL_BRIDGE_PROTOCOL_VERSION,
      requestId: "req_123",
      resultTopic: "acs-mcp-result-req_123",
      expiresAt: "2026-09-18T02:12:00.000Z",
      body: { jsonrpc: "2.0", id: 1, method: "ping" }
    });

    expect(parsed.requestId).toBe("req_123");
    expect(VERCEL_BRIDGE_REQUEST_TOPIC).toBe("acs-mcp-requests-v1");
  });

  it("rejects credential and arbitrary header fields", () => {
    const parsed = bridgeRequestEnvelopeSchema.safeParse({
      protocolVersion: VERCEL_BRIDGE_PROTOCOL_VERSION,
      requestId: "req_123",
      resultTopic: "acs-mcp-result-req_123",
      expiresAt: "2026-09-18T02:12:00.000Z",
      body: { jsonrpc: "2.0", id: 1, method: "ping" },
      authorization: "Bearer secret"
    });

    expect(parsed.success).toBe(false);
  });
  it("rejects oversized request envelopes", () => {
    const parsed = bridgeRequestEnvelopeSchema.safeParse({
      protocolVersion: VERCEL_BRIDGE_PROTOCOL_VERSION,
      requestId: "req_large",
      resultTopic: "acs-mcp-result-req_large",
      expiresAt: "2026-09-18T02:12:00.000Z",
      body: { data: "x".repeat(MAX_BRIDGE_ENVELOPE_BYTES) }
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts a bodyless 202 result", () => {
    const parsed = bridgeResultEnvelopeSchema.parse({
      protocolVersion: VERCEL_BRIDGE_PROTOCOL_VERSION,
      requestId: "req_notify",
      statusCode: 202
    });

    expect(parsed.body).toBeUndefined();
  });

  it("rejects invalid status codes and unknown fields", () => {
    expect(
      bridgeResultEnvelopeSchema.safeParse({
        protocolVersion: VERCEL_BRIDGE_PROTOCOL_VERSION,
        requestId: "req_bad",
        statusCode: 99
      }).success
    ).toBe(false);

    expect(
      bridgeResultEnvelopeSchema.safeParse({
        protocolVersion: VERCEL_BRIDGE_PROTOCOL_VERSION,
        requestId: "req_bad",
        statusCode: 200,
        secret: "nope"
      }).success
    ).toBe(false);
  });
  it("measures UTF-8 serialized size", () => {
    expect(serializedEnvelopeBytes({ text: "✓" })).toBe(Buffer.byteLength(JSON.stringify({ text: "✓" }), "utf8"));
  });
});
