import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  VERCEL_BRIDGE_PROTOCOL_VERSION,
  type BridgeRequestEnvelope,
  type BridgeResultEnvelope
} from "@agent-control-stack/vercel-bridge-contract";
import { BridgeReplayConflictError, SqliteBridgeReplayStore, bridgeRequestHash } from "./replay-store.js";

const request: BridgeRequestEnvelope = {
  protocolVersion: VERCEL_BRIDGE_PROTOCOL_VERSION,
  requestId: "req_replay",
  resultTopic: "acs-mcp-result-req_replay",
  expiresAt: "2026-09-18T02:12:00.000Z",
  body: { jsonrpc: "2.0", id: 1, method: "ping" }
};

const result: BridgeResultEnvelope = {
  protocolVersion: VERCEL_BRIDGE_PROTOCOL_VERSION,
  requestId: request.requestId,
  statusCode: 200,
  body: { jsonrpc: "2.0", id: 1, result: {} }
};

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "acs-vercel-replay-"));
  const store = new SqliteBridgeReplayStore(join(dir, "replay.db"));
  return {
    store,
    close() {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}
describe("bridge replay store", () => {
  it("returns no result before completion and the stored result after completion", () => {
    const f = fixture();
    try {
      expect(f.store.get(request)).toBeUndefined();
      f.store.put(request, result);
      expect(f.store.get(request)).toEqual(result);
    } finally {
      f.close();
    }
  });

  it("is idempotent for the same request and result", () => {
    const f = fixture();
    try {
      f.store.put(request, result);
      f.store.put(request, result);
      expect(f.store.get(request)).toEqual(result);
    } finally {
      f.close();
    }
  });

  it("fails closed when a request id is reused with a different payload", () => {
    const f = fixture();
    try {
      f.store.put(request, result);
      const conflicting = {
        ...request,
        body: { jsonrpc: "2.0", id: 1, method: "tools/list" }
      };
      expect(() => f.store.get(conflicting)).toThrow(BridgeReplayConflictError);
      expect(() => f.store.put(conflicting, result)).toThrow(BridgeReplayConflictError);
    } finally {
      f.close();
    }
  });
  it("uses a deterministic request hash", () => {
    expect(bridgeRequestHash(request)).toBe(bridgeRequestHash({ ...request }));
    expect(
      bridgeRequestHash({
        ...request,
        body: { jsonrpc: "2.0", id: 1, method: "tools/list" }
      })
    ).not.toBe(bridgeRequestHash(request));
  });

  it("does not persist authorization or key material", () => {
    const f = fixture();
    try {
      f.store.put(request, result);
      const raw = f.store.debugRawRow(request.requestId);
      expect(JSON.stringify(raw)).not.toContain("Bearer");
      expect(JSON.stringify(raw)).not.toContain("PRIVATE KEY");
    } finally {
      f.close();
    }
  });
});
