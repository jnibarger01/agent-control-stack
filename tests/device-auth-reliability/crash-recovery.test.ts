import { afterEach, describe, expect, it } from "vitest";
import { readCredentials } from "../../apps/runtime/src/auth/credential-store.js";
import {
  authenticateDevice,
  createTempEnv,
  inspectDeviceRow,
  sha256Hex,
  signRefreshProof,
  spawnCliRefreshProcess,
  spawnGatewayProcess
} from "./helpers.js";

describe("Scenario B: crash recovery and multi-gateway DB sharing", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!();
    }
  });

  it("recovers the exact same successor after SIGKILL before credential persistence", async () => {
    const env = createTempEnv();
    cleanups.push(env.cleanup);

    const gateway = await spawnGatewayProcess({ dbPath: env.dbPath });
    cleanups.push(() => gateway.stop());

    const auth = await authenticateDevice({
      gatewayUrl: gateway.url,
      credentialsPath: env.credentialsPath,
      accessTokenExpiresAtOverride: new Date(Date.now() - 60_000).toISOString()
    });
    const originalRefreshHash = sha256Hex(auth.refreshToken);

    // 1. Client refreshes, gateway commits rotation, client is SIGKILLed before persisting.
    const killed = await spawnCliRefreshProcess({
      credentialsPath: env.credentialsPath,
      killBeforePersist: true
    });
    expect(killed.signal).toBe("SIGKILL");

    // Disk still has the original refresh token; DB has already rotated.
    const beforeRecovery = readCredentials(env.credentialsPath);
    expect(sha256Hex(beforeRecovery!.session!.refreshToken)).toBe(originalRefreshHash);
    const rotatedRow = inspectDeviceRow(env.dbPath, auth.deviceId);
    expect(rotatedRow?.status).toBe("active");
    expect(rotatedRow?.previous_refresh_token_hash).toBe(originalRefreshHash);
    const committedRefreshHash = rotatedRow!.refresh_token_hash!;
    const committedAccessHash = rotatedRow!.access_token_hash!;

    // 2. Restart client without kill hook; it retries with the original refresh token + valid proof.
    const recovered = await spawnCliRefreshProcess({ credentialsPath: env.credentialsPath });
    expect(recovered.code).toBe(0);
    expect(recovered.parsed?.ok).toBe(true);
    expect(recovered.parsed?.deviceId).toBe(auth.deviceId);
    expect(recovered.parsed?.refreshTokenHash).toBe(committedRefreshHash);
    expect(recovered.parsed?.accessTokenHash).toBe(committedAccessHash);

    const afterRecovery = readCredentials(env.credentialsPath);
    expect(sha256Hex(afterRecovery!.session!.refreshToken)).toBe(committedRefreshHash);
    expect(sha256Hex(afterRecovery!.session!.accessToken)).toBe(committedAccessHash);
  });

  it("recovers the exact same successor even when the gateway process restarts between rotation and recovery", async () => {
    const env = createTempEnv();
    cleanups.push(env.cleanup);

    const gw1 = await spawnGatewayProcess({ dbPath: env.dbPath });
    let gw1Stopped = false;
    cleanups.push(async () => {
      if (!gw1Stopped) await gw1.stop();
    });

    const auth = await authenticateDevice({
      gatewayUrl: gw1.url,
      credentialsPath: env.credentialsPath,
      accessTokenExpiresAtOverride: new Date(Date.now() - 60_000).toISOString()
    });
    const originalRefreshHash = sha256Hex(auth.refreshToken);

    const killed = await spawnCliRefreshProcess({
      credentialsPath: env.credentialsPath,
      killBeforePersist: true
    });
    expect(killed.signal).toBe("SIGKILL");

    const rotatedRow = inspectDeviceRow(env.dbPath, auth.deviceId);
    expect(rotatedRow?.previous_refresh_token_hash).toBe(originalRefreshHash);
    const committedRefreshHash = rotatedRow!.refresh_token_hash!;
    const committedAccessHash = rotatedRow!.access_token_hash!;

    // Restart gateway on same DB + same recovery key.
    await gw1.stop();
    gw1Stopped = true;
    const gw2 = await spawnGatewayProcess({ dbPath: env.dbPath });
    cleanups.push(() => gw2.stop());

    // Update acsUrl in credentials to point to the restarted gateway's new ephemeral port (same device key + old refresh token).
    const stored = readCredentials(env.credentialsPath)!;
    const issuedAt = Math.floor(Date.now() / 1000);
    const proof = signRefreshProof({
      privateKeyPem: stored.devicePrivateKeyPem,
      clientId: stored.clientId,
      deviceId: auth.deviceId,
      refreshToken: stored.session!.refreshToken,
      issuedAt
    });
    const res = await fetch(`${gw2.url}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: stored.clientId,
        device_id: auth.deviceId,
        refresh_token: stored.session!.refreshToken,
        proof_issued_at: String(issuedAt),
        refresh_proof: proof
      }).toString()
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { access_token: string; refresh_token: string; device_id: string };
    expect(body.device_id).toBe(auth.deviceId);
    expect(sha256Hex(body.refresh_token)).toBe(committedRefreshHash);
    expect(sha256Hex(body.access_token)).toBe(committedAccessHash);
  });

  it("serializes concurrent refresh across two independent gateway processes sharing one SQLite DB", async () => {
    const env = createTempEnv();
    cleanups.push(env.cleanup);

    const gw1 = await spawnGatewayProcess({ dbPath: env.dbPath });
    cleanups.push(() => gw1.stop());
    const gw2 = await spawnGatewayProcess({ dbPath: env.dbPath });
    cleanups.push(() => gw2.stop());

    const auth = await authenticateDevice({
      gatewayUrl: gw1.url,
      credentialsPath: env.credentialsPath
    });
    const originalRefreshHash = sha256Hex(auth.refreshToken);

    const makeRefresh = (url: string) => {
      const issuedAt = Math.floor(Date.now() / 1000);
      const proof = signRefreshProof({
        privateKeyPem: auth.credentials.devicePrivateKeyPem,
        clientId: auth.credentials.clientId,
        deviceId: auth.deviceId,
        refreshToken: auth.refreshToken,
        issuedAt
      });
      return fetch(`${url}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: auth.credentials.clientId,
          device_id: auth.deviceId,
          refresh_token: auth.refreshToken,
          proof_issued_at: String(issuedAt),
          refresh_proof: proof
        }).toString()
      });
    };

    const [r1, r2] = await Promise.all([makeRefresh(gw1.url), makeRefresh(gw2.url)]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const b1 = (await r1.json()) as { access_token: string; refresh_token: string; device_id: string };
    const b2 = (await r2.json()) as { access_token: string; refresh_token: string; device_id: string };

    expect(sha256Hex(b1.refresh_token)).toBe(sha256Hex(b2.refresh_token));
    expect(sha256Hex(b1.access_token)).toBe(sha256Hex(b2.access_token));
    expect(sha256Hex(b1.refresh_token)).not.toBe(originalRefreshHash);

    const row = inspectDeviceRow(env.dbPath, auth.deviceId);
    expect(row?.status).toBe("active");
    expect(row?.previous_refresh_token_hash).toBe(originalRefreshHash);
    expect(row?.refresh_token_hash).toBe(sha256Hex(b1.refresh_token));
  });
});
