import { generateKeyPairSync, sign } from "node:crypto";
import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { readCredentials, writeCredentials } from "../../apps/runtime/src/auth/credential-store.js";
import {
  authenticateDevice,
  createTempEnv,
  inspectDeviceRow,
  OPERATOR_TOKEN,
  sha256Hex,
  signRefreshProof,
  spawnGatewayProcess
} from "./helpers.js";

describe("Scenario D: adversarial refresh, recovery, and credential-store checks", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!();
    }
  });

  it("rejects missing proof, wrong signature, another device's signature, wrong client_id, and does not revoke on invalid proof", async () => {
    const env = createTempEnv();
    cleanups.push(env.cleanup);
    const gw = await spawnGatewayProcess({ dbPath: env.dbPath });
    cleanups.push(() => gw.stop());

    const auth = await authenticateDevice({ gatewayUrl: gw.url, credentialsPath: env.credentialsPath });
    const issuedAt = Math.floor(Date.now() / 1000);

    // Missing proof
    const missingProof = await fetch(`${gw.url}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: auth.credentials.clientId,
        refresh_token: auth.refreshToken
      }).toString()
    });
    expect(missingProof.status).toBe(400);
    expect((await missingProof.json()).acs_reason).toBe("missing_proof");

    // Wrong signature
    const wrongSig = await fetch(`${gw.url}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: auth.credentials.clientId,
        device_id: auth.deviceId,
        refresh_token: auth.refreshToken,
        proof_issued_at: String(issuedAt),
        refresh_proof: Buffer.alloc(64, 1).toString("base64url")
      }).toString()
    });
    expect(wrongSig.status).toBe(400);
    expect((await wrongSig.json()).acs_reason).toBe("invalid_proof");

    // Signature from another device's key
    const otherPair = generateKeyPairSync("ed25519");
    const otherPem = otherPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const otherSig = await fetch(`${gw.url}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: auth.credentials.clientId,
        device_id: auth.deviceId,
        refresh_token: auth.refreshToken,
        proof_issued_at: String(issuedAt),
        refresh_proof: signRefreshProof({
          privateKeyPem: otherPem,
          clientId: auth.credentials.clientId,
          deviceId: auth.deviceId,
          refreshToken: auth.refreshToken,
          issuedAt
        })
      }).toString()
    });
    expect(otherSig.status).toBe(400);
    expect((await otherSig.json()).acs_reason).toBe("invalid_proof");

    // Wrong client_id
    const wrongClient = await fetch(`${gw.url}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: "wrong-client",
        device_id: auth.deviceId,
        refresh_token: auth.refreshToken,
        proof_issued_at: String(issuedAt),
        refresh_proof: signRefreshProof({
          privateKeyPem: auth.credentials.devicePrivateKeyPem,
          clientId: "wrong-client",
          deviceId: auth.deviceId,
          refreshToken: auth.refreshToken,
          issuedAt
        })
      }).toString()
    });
    expect(wrongClient.status).toBe(400);

    // Device must still be active (invalid proof must not DoS-revoke).
    expect(inspectDeviceRow(env.dbPath, auth.deviceId)?.status).toBe("active");
  });

  it("revokes device on refresh reuse outside the recovery window", async () => {
    const env = createTempEnv();
    cleanups.push(env.cleanup);
    const gw = await spawnGatewayProcess({ dbPath: env.dbPath, recoveryWindowSeconds: 1 });
    cleanups.push(() => gw.stop());

    const auth = await authenticateDevice({ gatewayUrl: gw.url, credentialsPath: env.credentialsPath });
    const issuedAt1 = Math.floor(Date.now() / 1000);
    const r1 = await fetch(`${gw.url}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: auth.credentials.clientId,
        device_id: auth.deviceId,
        refresh_token: auth.refreshToken,
        proof_issued_at: String(issuedAt1),
        refresh_proof: signRefreshProof({
          privateKeyPem: auth.credentials.devicePrivateKeyPem,
          clientId: auth.credentials.clientId,
          deviceId: auth.deviceId,
          refreshToken: auth.refreshToken,
          issuedAt: issuedAt1
        })
      }).toString()
    });
    expect(r1.status).toBe(200);

    // Wait past the 1s recovery window.
    await new Promise((r) => setTimeout(r, 1_250));

    const issuedAt2 = Math.floor(Date.now() / 1000);
    const replay = await fetch(`${gw.url}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: auth.credentials.clientId,
        device_id: auth.deviceId,
        refresh_token: auth.refreshToken,
        proof_issued_at: String(issuedAt2),
        refresh_proof: signRefreshProof({
          privateKeyPem: auth.credentials.devicePrivateKeyPem,
          clientId: auth.credentials.clientId,
          deviceId: auth.deviceId,
          refreshToken: auth.refreshToken,
          issuedAt: issuedAt2
        })
      }).toString()
    });
    expect(replay.status).toBe(400);
    expect((await replay.json()).acs_reason).toBe("refresh_replay");
    expect(inspectDeviceRow(env.dbPath, auth.deviceId)?.status).toBe("revoked");
  });

  it("rejects expired refresh token, replayed device-code authorization, and revoked-device refresh", async () => {
    const env = createTempEnv();
    cleanups.push(env.cleanup);
    const gw = await spawnGatewayProcess({ dbPath: env.dbPath });
    cleanups.push(() => gw.stop());

    // Replayed device-code authorization
    const pair = generateKeyPairSync("ed25519");
    const pub = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
    const codeRes = await fetch(`${gw.url}/oauth/device/code`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: "acs-cli", device_public_key: pub, scope: "acs:device" }).toString()
    });
    const code = (await codeRes.json()) as { device_code: string; user_code: string };
    await fetch(`${gw.url}/device/verify`, {
      method: "POST",
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ user_code: code.user_code, action: "approve" })
    });
    const sig = sign(
      null,
      Buffer.from(`acs-device-code-proof-v1\n${code.device_code}`, "utf8"),
      pair.privateKey
    ).toString("base64url");
    const firstExchange = await fetch(`${gw.url}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: code.device_code,
        device_signature: sig,
        client_id: "acs-cli"
      }).toString()
    });
    expect(firstExchange.status).toBe(200);
    const firstBody = (await firstExchange.json()) as { device_id: string; refresh_token: string };

    const replayCode = await fetch(`${gw.url}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: code.device_code,
        device_signature: sig,
        client_id: "acs-cli"
      }).toString()
    });
    expect(replayCode.status).toBe(400);
    expect((await replayCode.json()).error).toBe("invalid_grant");

    // Force refresh token expiry in DB -> refresh_expired
    const db = new DatabaseSync(env.dbPath);
    db.prepare(`UPDATE devices SET refresh_token_expires_at = ? WHERE id = ?`).run(
      new Date(Date.now() - 60_000).toISOString(),
      firstBody.device_id
    );
    db.close();

    const issuedAt = Math.floor(Date.now() / 1000);
    const expiredRes = await fetch(`${gw.url}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: "acs-cli",
        device_id: firstBody.device_id,
        refresh_token: firstBody.refresh_token,
        proof_issued_at: String(issuedAt),
        refresh_proof: signRefreshProof({
          privateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
          clientId: "acs-cli",
          deviceId: firstBody.device_id,
          refreshToken: firstBody.refresh_token,
          issuedAt
        })
      }).toString()
    });
    expect(expiredRes.status).toBe(400);
    expect((await expiredRes.json()).acs_reason).toBe("refresh_expired");
  });

  it("fails closed without rotating when recovery key is missing on the gateway", async () => {
    const env = createTempEnv();
    cleanups.push(env.cleanup);
    const gw = await spawnGatewayProcess({ dbPath: env.dbPath, recoveryKey: null });
    cleanups.push(() => gw.stop());

    const auth = await authenticateDevice({ gatewayUrl: gw.url, credentialsPath: env.credentialsPath });
    const originalRefreshHash = sha256Hex(auth.refreshToken);

    const issuedAt = Math.floor(Date.now() / 1000);
    const res = await fetch(`${gw.url}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: auth.credentials.clientId,
        device_id: auth.deviceId,
        refresh_token: auth.refreshToken,
        proof_issued_at: String(issuedAt),
        refresh_proof: signRefreshProof({
          privateKeyPem: auth.credentials.devicePrivateKeyPem,
          clientId: auth.credentials.clientId,
          deviceId: auth.deviceId,
          refreshToken: auth.refreshToken,
          issuedAt
        })
      }).toString()
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; acs_reason?: string };
    expect(body.acs_reason).toBe("recovery_unavailable");

    // Must not have rotated in DB.
    const row = inspectDeviceRow(env.dbPath, auth.deviceId);
    expect(row?.refresh_token_hash).toBe(originalRefreshHash);
    expect(row?.previous_refresh_token_hash).toBeNull();
  });

  it("handles corrupt credential files with a typed error and cleans up stale temp files on write", () => {
    const env = createTempEnv();
    cleanups.push(env.cleanup);

    // Corrupt JSON
    writeFileSync(env.credentialsPath, "{not-valid-json", { mode: 0o600 });
    expect(() => readCredentials(env.credentialsPath)).toThrow();

    // Schema-invalid JSON
    writeFileSync(env.credentialsPath, JSON.stringify({ v: 1, broken: true }), { mode: 0o600 });
    expect(() => readCredentials(env.credentialsPath)).toThrow();

    // Interrupted temp write alongside valid credential write
    const staleTmp = `${env.credentialsPath}.tmp-stale-1234`;
    writeFileSync(staleTmp, "partial", { mode: 0o600 });
    const pair = generateKeyPairSync("ed25519");
    writeCredentials(env.credentialsPath, {
      v: 1,
      acsUrl: "http://127.0.0.1:1",
      clientId: "acs-cli",
      deviceName: "dev",
      devicePrivateKeyPem: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      devicePublicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString()
    });
    expect(readCredentials(env.credentialsPath)?.deviceName).toBe("dev");
  });
});
