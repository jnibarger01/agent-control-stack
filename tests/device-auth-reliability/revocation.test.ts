import { afterEach, describe, expect, it } from "vitest";
import {
  authenticateDevice,
  countRecoveryEnvelopes,
  createTempEnv,
  dpopHeaders,
  inspectDeviceRow,
  OPERATOR_TOKEN,
  signRefreshProof,
  spawnGatewayProcess
} from "./helpers.js";

describe("Scenario C: device revocation hardening", () => {
  const cleanups: Array<() => Promise<void> | void> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      await cleanups.pop()!();
    }
  });

  it("enforces immediate revocation across access tokens, current+previous refresh tokens, restarts, re-registration, and unauthorized callers", async () => {
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
      scopes: ["acs:device", "acs:work:read"]
    });

    // Bearer downgrade with a device access token MUST fail closed (401); DPoP succeeds (200).
    const bearerDowngradeRes = await fetch(`${gw1.url}/api/actors`, {
      headers: { authorization: `Bearer ${auth.accessToken}` }
    });
    expect(bearerDowngradeRes.status).toBe(401);

    const okRes = await fetch(`${gw1.url}/api/actors`, {
      headers: dpopHeaders({
        accessToken: auth.accessToken,
        devicePublicKeyPem: auth.credentials.devicePublicKeyPem,
        devicePrivateKeyPem: auth.credentials.devicePrivateKeyPem,
        method: "GET",
        url: `${gw1.url}/api/actors`
      })
    });
    expect(okRes.status).toBe(200);

    // Rotate once so we have both a previous refresh token (inside recovery window) and a current refresh token.
    const issuedAt1 = Math.floor(Date.now() / 1000);
    const refreshRes1 = await fetch(`${gw1.url}/oauth/token`, {
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
    expect(refreshRes1.status).toBe(200);
    const rotated = (await refreshRes1.json()) as { access_token: string; refresh_token: string };

    // Unauthorized caller cannot revoke (no token -> 401; device token -> 403).
    const unauthRevoke = await fetch(`${gw1.url}/devices/${auth.deviceId}/revoke`, { method: "POST" });
    expect(unauthRevoke.status).toBe(401);

    const deviceRevoke = await fetch(`${gw1.url}/devices/${auth.deviceId}/revoke`, {
      method: "POST",
      headers: dpopHeaders({
        accessToken: rotated.access_token,
        devicePublicKeyPem: auth.credentials.devicePublicKeyPem,
        devicePrivateKeyPem: auth.credentials.devicePrivateKeyPem,
        method: "POST",
        url: `${gw1.url}/devices/${auth.deviceId}/revoke`
      })
    });
    expect(deviceRevoke.status).toBe(403);

    // Authorized operator revokes device.
    const opRevoke = await fetch(`${gw1.url}/devices/${auth.deviceId}/revoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` }
    });
    expect(opRevoke.status).toBe(200);

    // Direct database assertions: all token hashes, expiries, and recovery envelopes are cleared.
    const revokedRow = inspectDeviceRow(env.dbPath, auth.deviceId);
    expect(revokedRow).toBeDefined();
    expect(revokedRow?.status).toBe("revoked");
    expect(revokedRow?.revoked_at).toBeTruthy();
    expect(revokedRow?.access_token_hash).toBeNull();
    expect(revokedRow?.access_token_expires_at).toBeNull();
    expect(revokedRow?.refresh_token_hash).toBeNull();
    expect(revokedRow?.refresh_token_expires_at).toBeNull();
    expect(revokedRow?.previous_refresh_token_hash).toBeNull();
    expect(countRecoveryEnvelopes(env.dbPath, auth.deviceId)).toBe(0);

    // Cached unexpired access token fails immediately even with a valid DPoP proof.
    const revokedAccess = await fetch(`${gw1.url}/api/actors`, {
      headers: dpopHeaders({
        accessToken: rotated.access_token,
        devicePublicKeyPem: auth.credentials.devicePublicKeyPem,
        devicePrivateKeyPem: auth.credentials.devicePrivateKeyPem,
        method: "GET",
        url: `${gw1.url}/api/actors`
      })
    });
    expect(revokedAccess.status).toBe(401);

    // Both current and previous refresh tokens fail (even inside recovery window).
    for (const tokenToTry of [rotated.refresh_token, auth.refreshToken]) {
      const issuedAt = Math.floor(Date.now() / 1000);
      const res = await fetch(`${gw1.url}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: auth.credentials.clientId,
          device_id: auth.deviceId,
          refresh_token: tokenToTry,
          proof_issued_at: String(issuedAt),
          refresh_proof: signRefreshProof({
            privateKeyPem: auth.credentials.devicePrivateKeyPem,
            clientId: auth.credentials.clientId,
            deviceId: auth.deviceId,
            refreshToken: tokenToTry,
            issuedAt
          })
        }).toString()
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; acs_reason?: string };
      expect(body.acs_reason).toBe("device_revoked");
    }

    // Invalid proofs against a revoked device ID vs a nonexistent device ID must return
    // identical HTTP status and JSON error payload (no existence/revocation oracle).
    const invalidProofIssuedAt = Math.floor(Date.now() / 1000);
    const revokedInvalidProofRes = await fetch(`${gw1.url}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: auth.credentials.clientId,
        device_id: auth.deviceId,
        refresh_token: rotated.refresh_token,
        proof_issued_at: String(invalidProofIssuedAt),
        refresh_proof: "invalid-proof-signature"
      }).toString()
    });
    const nonexistentInvalidProofRes = await fetch(`${gw1.url}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: auth.credentials.clientId,
        device_id: "nonexistent-device-id",
        refresh_token: rotated.refresh_token,
        proof_issued_at: String(invalidProofIssuedAt),
        refresh_proof: "invalid-proof-signature"
      }).toString()
    });
    const revokedInvalidProofBody = (await revokedInvalidProofRes.json()) as {
      error: string;
      acs_reason?: string;
    };
    const nonexistentInvalidProofBody = (await nonexistentInvalidProofRes.json()) as {
      error: string;
      acs_reason?: string;
    };
    expect(revokedInvalidProofRes.status).toBe(400);
    expect(revokedInvalidProofRes.status).toBe(nonexistentInvalidProofRes.status);
    expect(revokedInvalidProofBody).toEqual({
      error: "invalid_grant",
      acs_reason: "unknown_refresh_token"
    });
    expect(revokedInvalidProofBody).toEqual(nonexistentInvalidProofBody);

    // Restart gateway; device remains revoked.
    await gw1.stop();
    gw1Stopped = true;
    const gw2 = await spawnGatewayProcess({ dbPath: env.dbPath });
    cleanups.push(() => gw2.stop());

    const afterRestartAccess = await fetch(`${gw2.url}/api/actors`, {
      headers: dpopHeaders({
        accessToken: rotated.access_token,
        devicePublicKeyPem: auth.credentials.devicePublicKeyPem,
        devicePrivateKeyPem: auth.credentials.devicePrivateKeyPem,
        method: "GET",
        url: `${gw2.url}/api/actors`
      })
    });
    expect(afterRestartAccess.status).toBe(401);

    // Re-registering the same public key cannot silently restore the revoked device.
    const reCodeRes = await fetch(`${gw2.url}/oauth/device/code`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: auth.credentials.clientId,
        device_public_key: auth.credentials.devicePublicKeyPem,
        device_name: "re-register-attempt",
        scope: "acs:device"
      }).toString()
    });
    if (reCodeRes.ok) {
      const reCode = (await reCodeRes.json()) as { user_code: string };
      const reApprove = await fetch(`${gw2.url}/device/verify`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${OPERATOR_TOKEN}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({ user_code: reCode.user_code, action: "approve" })
      });
      expect(reApprove.ok).toBe(false);
    } else {
      expect(reCodeRes.status).toBe(400);
    }
  });
});
