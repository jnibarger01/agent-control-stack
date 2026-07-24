import { createConnection, createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startEgressProxy, type EgressDecision, type EgressProxyHandle } from "./egress-proxy.js";

describe("startEgressProxy", () => {
  let dir: string;
  let destServer: Server | undefined;
  let handle: EgressProxyHandle | undefined;

  afterEach(async () => {
    await handle?.close();
    handle = undefined;
    if (destServer) await new Promise<void>((resolvePromise) => destServer?.close(() => resolvePromise()));
    destServer = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function startDest(response: string): Promise<number> {
    return new Promise((resolvePromise) => {
      destServer = createServer((socket: Socket) => {
        socket.end(response);
      });
      destServer.listen(0, "127.0.0.1", () => {
        const address = destServer?.address();
        resolvePromise(typeof address === "object" && address ? address.port : 0);
      });
    });
  }

  function connectRaw(socketPath: string, connectLine: string): Promise<Buffer> {
    return new Promise((resolvePromise, reject) => {
      const socket = createConnection(socketPath, () => {
        socket.write(connectLine);
      });
      const chunks: Buffer[] = [];
      socket.on("data", (chunk: Buffer) => chunks.push(chunk));
      socket.on("close", () => resolvePromise(Buffer.concat(chunks)));
      socket.on("error", reject);
      setTimeout(() => socket.destroy(), 1_500);
    });
  }

  it("bridges an allowlisted CONNECT target and relays bytes end to end", async () => {
    const port = await startDest("dest-reached\n");
    dir = mkdtempSync(join(tmpdir(), "acs-egress-proxy-test-"));
    const socketPath = join(dir, "egress.sock");
    const decisions: EgressDecision[] = [];
    handle = await startEgressProxy({
      socketPath,
      allowlist: [{ host: "127.0.0.1", port }],
      onDecision: (decision) => decisions.push(decision)
    });

    const response = await connectRaw(
      socketPath,
      `CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`
    );
    expect(response.toString("utf8")).toContain("200 Connection Established");
    expect(response.toString("utf8")).toContain("dest-reached");
    expect(decisions).toEqual([{ host: "127.0.0.1", port, allowed: true, at: expect.any(String) }]);
  });

  it("refuses a CONNECT target outside the allowlist and records the denial", async () => {
    const port = await startDest("should-not-be-reached\n");
    dir = mkdtempSync(join(tmpdir(), "acs-egress-proxy-test-"));
    const socketPath = join(dir, "egress.sock");
    const decisions: EgressDecision[] = [];
    handle = await startEgressProxy({
      socketPath,
      allowlist: [{ host: "127.0.0.1", port: port + 1 }],
      onDecision: (decision) => decisions.push(decision)
    });

    const response = await connectRaw(
      socketPath,
      `CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`
    );
    expect(response.toString("utf8")).toContain("403 Forbidden");
    expect(response.toString("utf8")).not.toContain("should-not-be-reached");
    expect(decisions).toEqual([{ host: "127.0.0.1", port, allowed: false, at: expect.any(String) }]);
  });

  it("rejects a non-CONNECT request", async () => {
    dir = mkdtempSync(join(tmpdir(), "acs-egress-proxy-test-"));
    const socketPath = join(dir, "egress.sock");
    handle = await startEgressProxy({ socketPath, allowlist: [{ host: "127.0.0.1", port: 1 }] });

    const response = await connectRaw(socketPath, "GET / HTTP/1.1\r\nHost: x\r\n\r\n");
    expect(response.toString("utf8")).toContain("400 Bad Request");
  });

  it("matches host case-insensitively but denies a different port on an allowed host", async () => {
    const port = await startDest("dest\n");
    dir = mkdtempSync(join(tmpdir(), "acs-egress-proxy-test-"));
    const socketPath = join(dir, "egress.sock");
    handle = await startEgressProxy({ socketPath, allowlist: [{ host: "EXAMPLE.test", port: 443 }] });

    const wrongPort = await connectRaw(
      socketPath,
      `CONNECT example.test:9999 HTTP/1.1\r\nHost: example.test:9999\r\n\r\n`
    );
    expect(wrongPort.toString("utf8")).toContain("403 Forbidden");
    void port;
  });

  it("bounds the header read and destroys connections that never terminate their headers", async () => {
    dir = mkdtempSync(join(tmpdir(), "acs-egress-proxy-test-"));
    const socketPath = join(dir, "egress.sock");
    handle = await startEgressProxy({ socketPath, allowlist: [{ host: "127.0.0.1", port: 1 }] });

    const oversized = `CONNECT 127.0.0.1:1 HTTP/1.1\r\n${"x".repeat(9 * 1024)}`;
    const response = await connectRaw(socketPath, oversized);
    expect(response.length).toBe(0);
  });

  it("removes the socket file on close and can be restarted at the same path", async () => {
    dir = mkdtempSync(join(tmpdir(), "acs-egress-proxy-test-"));
    const socketPath = join(dir, "egress.sock");
    handle = await startEgressProxy({ socketPath, allowlist: [{ host: "127.0.0.1", port: 1 }] });
    await handle.close();
    handle = await startEgressProxy({ socketPath, allowlist: [{ host: "127.0.0.1", port: 1 }] });
    expect(handle.socketPath).toBe(socketPath);
  });
});
