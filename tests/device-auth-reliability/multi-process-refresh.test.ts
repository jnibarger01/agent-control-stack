import { afterEach, describe, expect, it } from "vitest";
import { readCredentials } from "../../apps/runtime/src/auth/credential-store.js";
import {
  authenticateDevice,
  createTempEnv,
  inspectDeviceRow,
  sha256Hex,
  spawnCliRefreshProcess,
  spawnGatewayProcess,
  type GatewayProcess
} from "./helpers.js";

describe("Scenario A: multi-process concurrent refresh", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!();
    }
  });

  it("spawns two independent OS CLI processes concurrently; both get the same successor, 1 rotation in DB, device active", async () => {
    const env = createTempEnv();
    cleanups.push(env.cleanup);

    const gateway: GatewayProcess = await spawnGatewayProcess({ dbPath: env.dbPath });
    cleanups.push(() => gateway.stop());

    // Force access token into refresh window (already expired locally).
    const auth = await authenticateDevice({
      gatewayUrl: gateway.url,
      credentialsPath: env.credentialsPath,
      scopes: ["acs:device", "acs:work:read"],
      accessTokenExpiresAtOverride: new Date(Date.now() - 60_000).toISOString()
    });
    const originalRefreshHash = sha256Hex(auth.refreshToken);

    const [p1, p2] = await Promise.all([
      spawnCliRefreshProcess({ credentialsPath: env.credentialsPath }),
      spawnCliRefreshProcess({ credentialsPath: env.credentialsPath })
    ]);

    expect(p1.code).toBe(0);
    expect(p2.code).toBe(0);
    expect(p1.parsed?.ok).toBe(true);
    expect(p2.parsed?.ok).toBe(true);
    expect(p1.parsed?.deviceId).toBe(auth.deviceId);
    expect(p2.parsed?.deviceId).toBe(auth.deviceId);

    // Both independent processes must have received the exact same successor tokens (compare hashes only).
    expect(p1.parsed?.accessTokenHash).toBeTruthy();
    expect(p1.parsed?.refreshTokenHash).toBeTruthy();
    expect(p1.parsed?.accessTokenHash).toBe(p2.parsed?.accessTokenHash);
    expect(p1.parsed?.refreshTokenHash).toBe(p2.parsed?.refreshTokenHash);
    expect(p1.parsed?.refreshTokenHash).not.toBe(originalRefreshHash);

    // Exactly one rotation in DB: previous_refresh_token_hash === originalRefreshHash, refresh_token_hash === successor.
    const row = inspectDeviceRow(env.dbPath, auth.deviceId);
    expect(row?.status).toBe("active");
    expect(row?.previous_refresh_token_hash).toBe(originalRefreshHash);
    expect(row?.refresh_token_hash).toBe(p1.parsed?.refreshTokenHash);
    expect(row?.access_token_hash).toBe(p1.parsed?.accessTokenHash);

    // Persisted credentials on disk match the successor and preserve device identity.
    const stored = readCredentials(env.credentialsPath);
    expect(stored?.session?.deviceId).toBe(auth.deviceId);
    expect(sha256Hex(stored!.session!.refreshToken)).toBe(p1.parsed?.refreshTokenHash);
    expect(sha256Hex(stored!.session!.accessToken)).toBe(p1.parsed?.accessTokenHash);

    // New access token works against a real authenticated gateway route.
    const apiRes = await fetch(`${gateway.url}/api/actors`, {
      headers: { authorization: `Bearer ${stored!.session!.accessToken}` }
    });
    expect(apiRes.status).toBe(200);
  });
});
