import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createTunnelHeartbeat, loadBridgeDaemonConfig, readOwnerOnlySecret, runBridgeDaemon } from "./daemon.js";
import type { WorkerQueuePort } from "./queue-runtime.js";

describe("bridge daemon configuration", () => {
  it("loads required identity and safe defaults", () => {
    const config = loadBridgeDaemonConfig(
      {
        ACS_VERCEL_PROJECT: "acs-ingress",
        ACS_VERCEL_ACCESS_TOKEN_FILE: "/run/credentials/vercel",
        ACS_VERCEL_GATEWAY_TOKEN_FILE: "/run/credentials/gateway",
        ACS_VERCEL_TUNNEL_PRIVATE_KEY_FILE: "/run/credentials/key",
        ACS_VERCEL_CONNECTOR_ID: "vercel-prod",
        ACS_VERCEL_TUNNEL_ID: "tunnel_1",
        ACS_VERCEL_SESSION_ID: "session_1"
      },
      "/srv/acs"
    );

    expect(config).toMatchObject({
      projectIdOrName: "acs-ingress",
      queueRegion: "iad1",
      localMcpUrl: "http://127.0.0.1:3000/mcp",
      heartbeatIntervalMs: 300_000,
      pollIntervalMs: 1_000,
      replayDbPath: "/srv/acs/storage/vercel-bridge-replay.db"
    });
  });

  it("loads OAuth mode without tunnel-only credentials", () => {
    const config = loadBridgeDaemonConfig(
      {
        ACS_VERCEL_PROJECT: "acs-ingress",
        ACS_VERCEL_ACCESS_TOKEN_FILE: "/run/credentials/vercel",
        ACS_VERCEL_AUTH_MODE: "oauth",
        ACS_VERCEL_AUTH_PRIVATE_KEY_FILE: "/run/credentials/oauth-key"
      },
      "/srv/acs"
    );

    expect(config).toEqual(
      expect.objectContaining({
        authMode: "oauth",
        authPrivateKeyFile: "/run/credentials/oauth-key",
        projectIdOrName: "acs-ingress"
      })
    );
    expect("gatewayTokenFile" in config).toBe(false);
    expect("connectorId" in config).toBe(false);
  });

  it("rejects missing required configuration", () => {
    expect(() => loadBridgeDaemonConfig({}, "/srv/acs")).toThrow("ACS_VERCEL_PROJECT is required");
  });
});
describe("bridge daemon secret files", () => {
  it("reads a non-empty owner-only secret", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-bridge-secret-"));
    const path = join(dir, "secret");
    try {
      writeFileSync(path, " secret-value\n", { mode: 0o600 });
      expect(readOwnerOnlySecret(path)).toBe("secret-value");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects group/world-readable secret files", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-bridge-secret-"));
    const path = join(dir, "secret");
    try {
      writeFileSync(path, "secret-value", { mode: 0o600 });
      chmodSync(path, 0o644);
      expect(() => readOwnerOnlySecret(path)).toThrow("must not be group/world accessible");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
describe("bridge daemon tunnel heartbeat", () => {
  it("heartbeats the exact local session using only the local gateway bearer", async () => {
    const fetchFn = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({ session: { status: "active" } })
    );
    const heartbeat = createTunnelHeartbeat({
      localMcpUrl: "http://127.0.0.1:3000/mcp",
      connectorId: "vercel-prod",
      tunnelId: "tunnel_1",
      sessionId: "session_1",
      gatewayBearerToken: "gateway-secret",
      fetchFn
    });

    await heartbeat();

    const [url, init] = fetchFn.mock.calls[0]!;
    expect(String(url)).toBe(
      "http://127.0.0.1:3000/connectors/vercel-prod/tunnels/tunnel_1/sessions/session_1/heartbeat"
    );
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer gateway-secret");
    expect(init?.method).toBe("POST");
  });

  it("fails on a rejected heartbeat without leaking the response body", async () => {
    const heartbeat = createTunnelHeartbeat({
      localMcpUrl: "http://localhost:3000/mcp",
      connectorId: "vercel-prod",
      tunnelId: "tunnel_1",
      sessionId: "session_1",
      gatewayBearerToken: "gateway-secret",
      fetchFn: vi.fn(async () => new Response("gateway-secret should never leak", { status: 401 }))
    });

    await expect(heartbeat()).rejects.toThrow("status 401");
    await expect(heartbeat()).rejects.not.toThrow("gateway-secret");
  });
});

describe("bridge daemon main loop", () => {
  function oauthFixture() {
    const dir = mkdtempSync(join(tmpdir(), "acs-bridge-daemon-"));
    const accessTokenFile = join(dir, "vercel-token");
    const authPrivateKeyFile = join(dir, "oauth-key");
    writeFileSync(accessTokenFile, "vercel-access-token", { mode: 0o600 });
    const { privateKey } = generateKeyPairSync("x25519");
    writeFileSync(authPrivateKeyFile, String(privateKey.export({ type: "pkcs8", format: "pem" })), { mode: 0o600 });
    return {
      dir,
      config: {
        authMode: "oauth" as const,
        projectIdOrName: "acs-ingress",
        queueRegion: "iad1" as const,
        accessTokenFile,
        authPrivateKeyFile,
        localMcpUrl: "http://127.0.0.1:3000/mcp",
        replayDbPath: join(dir, "replay.db"),
        pollIntervalMs: 1
      },
      close() {
        rmSync(dir, { recursive: true, force: true });
      }
    };
  }
  it("runs one OAuth poll with the configured auth mode and stops cleanly", async () => {
    const fixture = oauthFixture();
    const controller = new AbortController();
    const queue = {} as WorkerQueuePort;
    const queueClientFactory = vi.fn(() => queue);
    const pollOnce = vi.fn(async (options) => {
      expect(options.expectedAuthMode).toBe("oauth");
      controller.abort();
      return { ok: false as const, reason: "empty" as const };
    });
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };

    try {
      await runBridgeDaemon(fixture.config, {
        signal: controller.signal,
        logger,
        sleep: vi.fn(async () => undefined),
        oidcProviderFactory: () => ({
          getToken: vi.fn(async () => "short-oidc"),
          invalidate: vi.fn()
        }),
        queueClientFactory,
        pollOnce
      });
      expect(queueClientFactory).toHaveBeenCalledWith({
        region: "iad1",
        token: "short-oidc"
      });
      expect(pollOnce).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalledWith("bridge.stopped");
      expect(logger.error).not.toHaveBeenCalled();
    } finally {
      fixture.close();
    }
  });

  it("recreates the queue client after a non-auth transport failure", async () => {
    const fixture = oauthFixture();
    const controller = new AbortController();
    const queueClientFactory = vi.fn(() => ({}) as WorkerQueuePort);
    let calls = 0;
    const pollOnce = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("temporary transport failure");
      controller.abort();
      return { ok: false as const, reason: "empty" as const };
    });
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };

    try {
      await runBridgeDaemon(fixture.config, {
        signal: controller.signal,
        logger,
        sleep: vi.fn(async () => undefined),
        oidcProviderFactory: () => ({
          getToken: vi.fn(async () => "short-oidc"),
          invalidate: vi.fn()
        }),
        queueClientFactory,
        pollOnce
      });

      expect(queueClientFactory).toHaveBeenCalledTimes(2);
      expect(logger.error).toHaveBeenCalledWith("bridge.poll_failed");
    } finally {
      fixture.close();
    }
  });
});
