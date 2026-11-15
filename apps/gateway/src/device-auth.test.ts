import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { afterEach, describe, expect, it } from "vitest";
import { buildGateway, type GatewayAuthOptions } from "./server.js";

const testAuth = { token: "operator-token-0123456789abcdef", actor: "user", actorId: "operator-1" } as const;
const testRecoveryKey = randomBytes(32).toString("base64");

const devicePair = generateKeyPairSync("ed25519");
const devicePublicKeyPem = devicePair.publicKey.export({ type: "spki", format: "pem" }).toString();

function deviceProof(deviceCode: string): string {
  return sign(null, Buffer.from(`acs-device-code-proof-v1\n${deviceCode}`, "utf8"), devicePair.privateKey).toString(
    "base64url"
  );
}

function refreshProof(
  input: { clientId: string; deviceId: string; refreshToken: string; issuedAt: number },
  privateKey = devicePair.privateKey
): string {
  const tokenSha256 = createHash("sha256").update(input.refreshToken).digest("hex");
  const message = [
    "acs-device-refresh-proof-v1",
    `client_id=${input.clientId}`,
    `device_id=${input.deviceId}`,
    `refresh_token_sha256=${tokenSha256}`,
    "operation=refresh_token",
    `issued_at=${input.issuedAt}`
  ].join("\n");
  return sign(null, Buffer.from(message, "utf8"), privateKey).toString("base64url");
}

function seedActor(dbPath: string): void {
  const store = new SqliteWorkItemStore(dbPath);
  try {
    store.registerActor({ id: testAuth.actorId, actorType: "HUMAN", displayName: "Operator One" });
  } finally {
    store.close();
  }
}

function form(fields: Record<string, string>) {
  return new URLSearchParams(fields).toString();
}

describe("device authorization HTTP surface", () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function buildTestApp(
    rateLimit?: { windowMs: number; maxRequests: number },
    auth: GatewayAuthOptions = testAuth,
    authLockout?: { windowMs: number; maxFailures: number },
    deviceRefreshRecovery: { primaryKeyBase64: string; windowSeconds?: number } | false = {
      primaryKeyBase64: testRecoveryKey,
      windowSeconds: 120
    }
  ) {
    dir = mkdtempSync(join(tmpdir(), "acs-device-http-"));
    const dbPath = join(dir, "control.db");
    seedActor(dbPath);
    const app = buildGateway({
      dbPath,
      logger: false,
      auth,
      deviceRefreshRecovery,
      ...(rateLimit ? { rateLimit } : {}),
      ...(authLockout ? { authLockout } : {})
    });
    await app.ready();
    return app;
  }

  it("issues a device code over form-urlencoded, with a Host-derived verification URI", async () => {
    const app = await buildTestApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/oauth/device/code",
        headers: { "content-type": "application/x-www-form-urlencoded", host: "acs.example.test" },
        payload: form({
          client_id: "acs-cli",
          scope: "acs:device",
          device_public_key: devicePublicKeyPem,
          device_name: "workstation"
        })
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.device_code).toBeTruthy();
      expect(body.user_code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
      expect(body.verification_uri).toBe("http://acs.example.test/device/verify");
      expect(body.verification_uri_complete).toContain(encodeURIComponent(body.user_code));
      expect(body.expires_in).toBeGreaterThan(0);
      expect(body.interval).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });

  it("rejects an unrecognized client_id at issuance", async () => {
    const app = await buildTestApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/oauth/device/code",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: form({ client_id: "not-acs-cli", device_public_key: devicePublicKeyPem })
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "invalid_client" });
    } finally {
      await app.close();
    }
  });

  it("GET /device/verify redirects an unauthenticated browser to the login page instead of the device UI", async () => {
    const app = await buildTestApp();
    try {
      const response = await app.inject({ method: "GET", url: "/device/verify" });
      expect(response.statusCode).toBe(401);
      expect(response.body).toContain("Mission Control");
      expect(response.body).not.toContain("Approve this device");
    } finally {
      await app.close();
    }
  });

  it("rate limits repeated GET /device/verify authorization attempts", async () => {
    const app = await buildTestApp({ windowMs: 60_000, maxRequests: 1 });
    try {
      const first = await app.inject({ method: "GET", url: "/device/verify" });
      const limited = await app.inject({ method: "GET", url: "/device/verify" });
      expect(first.statusCode).toBe(401);
      expect(limited.statusCode).toBe(429);
      expect(limited.headers["retry-after"]).toBeDefined();
      expect(limited.json()).toMatchObject({ code: "rate_limited" });
    } finally {
      await app.close();
    }
  });

  it("POST /device/verify rejects an unauthenticated approval attempt", async () => {
    const app = await buildTestApp();
    try {
      const response = await app.inject({
        method: "POST",
        url: "/device/verify",
        payload: { user_code: "AAAA-BBBB", action: "approve" }
      });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("rejects device token polling without proof of possession", async () => {
    const app = await buildTestApp();
    try {
      const issue = await app.inject({
        method: "POST",
        url: "/oauth/device/code",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: form({ client_id: "acs-cli", device_public_key: devicePublicKeyPem })
      });
      const { device_code: deviceCode } = issue.json();
      const poll = await app.inject({
        method: "POST",
        url: "/oauth/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: form({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: deviceCode,
          client_id: "acs-cli"
        })
      });
      expect(poll.statusCode).toBe(400);
      expect(poll.json()).toEqual({ error: "invalid_request" });
    } finally {
      await app.close();
    }
  });

  it("does not allow a read-only gateway credential to approve a device", async () => {
    const readOnlyAuth: GatewayAuthOptions = {
      token: "",
      actor: "",
      credentials: [
        {
          id: "reader",
          token: "reader-token-0123456789abcdef012345",
          actor: "user",
          actorId: "operator-1",
          roles: ["operator"],
          scopes: ["acs:read", "acs:device"]
        }
      ]
    };
    const app = await buildTestApp(undefined, readOnlyAuth);
    try {
      const issue = await app.inject({
        method: "POST",
        url: "/oauth/device/code",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: form({ client_id: "acs-cli", device_public_key: devicePublicKeyPem })
      });
      const { user_code: userCode } = issue.json();
      const approve = await app.inject({
        method: "POST",
        url: "/device/verify",
        headers: { authorization: "Bearer reader-token-0123456789abcdef012345" },
        payload: { user_code: userCode, action: "approve" }
      });
      expect(approve.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("full approval round trip: issue -> pending poll -> authenticated approve -> token exchange -> replay rejected", async () => {
    const app = await buildTestApp();
    try {
      const issueResponse = await app.inject({
        method: "POST",
        url: "/oauth/device/code",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: form({ client_id: "acs-cli", device_public_key: devicePublicKeyPem, device_name: "laptop" })
      });
      const { device_code: deviceCode, user_code: userCode } = issueResponse.json();

      const pendingPoll = await app.inject({
        method: "POST",
        url: "/oauth/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: form({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: deviceCode,
          device_signature: deviceProof(deviceCode),
          client_id: "acs-cli"
        })
      });
      expect(pendingPoll.statusCode).toBe(400);
      expect(pendingPoll.json()).toEqual({ error: "authorization_pending" });

      const verifyPage = await app.inject({
        method: "GET",
        url: `/device/verify?user_code=${encodeURIComponent(userCode)}`,
        headers: { authorization: `Bearer ${testAuth.token}` }
      });
      expect(verifyPage.statusCode).toBe(200);
      expect(verifyPage.body).toContain("Approve this device");
      expect(verifyPage.body).toContain("laptop");

      const approve = await app.inject({
        method: "POST",
        url: "/device/verify",
        headers: { authorization: `Bearer ${testAuth.token}` },
        payload: { user_code: userCode, action: "approve" }
      });
      expect(approve.statusCode).toBe(200);
      expect(approve.json()).toEqual({ ok: true });

      const tokenResponse = await app.inject({
        method: "POST",
        url: "/oauth/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: form({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: deviceCode,
          device_signature: deviceProof(deviceCode),
          client_id: "acs-cli"
        })
      });
      expect(tokenResponse.statusCode).toBe(200);
      const tokenBody = tokenResponse.json();
      expect(tokenBody.access_token).toBeTruthy();
      expect(tokenBody.refresh_token).toBeTruthy();
      expect(tokenBody.token_type).toBe("Bearer");

      // Replay: same device_code cannot be exchanged twice.
      const replay = await app.inject({
        method: "POST",
        url: "/oauth/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: form({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: deviceCode,
          device_signature: deviceProof(deviceCode),
          client_id: "acs-cli"
        })
      });
      expect(replay.statusCode).toBe(400);
      expect(replay.json()).toEqual({ error: "invalid_grant" });
    } finally {
      await app.close();
    }
  });

  it("denial path: browser denies, CLI polling reports access_denied, and approval is no longer possible", async () => {
    const app = await buildTestApp();
    try {
      const issueResponse = await app.inject({
        method: "POST",
        url: "/oauth/device/code",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: form({ client_id: "acs-cli", device_public_key: devicePublicKeyPem, device_name: "laptop" })
      });
      const { device_code: deviceCode, user_code: userCode } = issueResponse.json();

      const deny = await app.inject({
        method: "POST",
        url: "/device/verify",
        headers: { authorization: `Bearer ${testAuth.token}` },
        payload: { user_code: userCode, action: "deny" }
      });
      expect(deny.statusCode).toBe(200);

      const poll = await app.inject({
        method: "POST",
        url: "/oauth/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: form({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: deviceCode,
          device_signature: deviceProof(deviceCode),
          client_id: "acs-cli"
        })
      });
      expect(poll.statusCode).toBe(400);
      expect(poll.json()).toEqual({ error: "access_denied" });

      const lateApprove = await app.inject({
        method: "POST",
        url: "/device/verify",
        headers: { authorization: `Bearer ${testAuth.token}` },
        payload: { user_code: userCode, action: "approve" }
      });
      expect(lateApprove.statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });

  it("locks device-auth verification after N failed user_code attempts and stays 429 until cleared by success", async () => {
    const app = await buildTestApp({ windowMs: 60_000, maxRequests: 100 }, testAuth, {
      windowMs: 60_000,
      maxFailures: 3
    });
    try {
      const issue = await app.inject({
        method: "POST",
        url: "/oauth/device/code",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: form({ client_id: "acs-cli", device_public_key: devicePublicKeyPem, device_name: "laptop" })
      });
      const { user_code: userCode } = issue.json();

      const fail = async (code: string) =>
        app.inject({
          method: "POST",
          url: "/device/verify",
          headers: { authorization: `Bearer ${testAuth.token}` },
          payload: { user_code: code, action: "approve" }
        });

      expect((await fail("AAAA-BBBB")).statusCode).toBe(404);
      expect((await fail("CCCC-DDDD")).statusCode).toBe(404);
      const locked = await fail("EEEE-FFFF");
      expect(locked.statusCode).toBe(429);
      expect(locked.headers["retry-after"]).toBeDefined();
      expect(locked.json()).toMatchObject({
        error: "too many failed verification attempts",
        code: "auth_lockout",
        retry_after_seconds: expect.any(Number)
      });

      // Further attempts (even with the real user_code) stay locked — skip store lookup.
      const stillLocked = await fail(userCode);
      expect(stillLocked.statusCode).toBe(429);
      expect(stillLocked.json()).toMatchObject({ code: "auth_lockout" });

      const metrics = await app.inject({
        method: "GET",
        url: "/metrics",
        headers: { authorization: `Bearer ${testAuth.token}` }
      });
      expect(metrics.body).toContain('acs_auth_lockout_total{route="/device/verify"}');
      expect(metrics.body).not.toContain(userCode);
      expect(metrics.body).not.toContain("AAAA-BBBB");
    } finally {
      await app.close();
    }
  });

  it("clears device-auth failure streak after a successful verification", async () => {
    const app = await buildTestApp({ windowMs: 60_000, maxRequests: 100 }, testAuth, {
      windowMs: 60_000,
      maxFailures: 3
    });
    try {
      const issue = await app.inject({
        method: "POST",
        url: "/oauth/device/code",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: form({ client_id: "acs-cli", device_public_key: devicePublicKeyPem, device_name: "laptop" })
      });
      const { user_code: userCode } = issue.json();

      expect(
        (
          await app.inject({
            method: "POST",
            url: "/device/verify",
            headers: { authorization: `Bearer ${testAuth.token}` },
            payload: { user_code: "AAAA-BBBB", action: "approve" }
          })
        ).statusCode
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/device/verify",
            headers: { authorization: `Bearer ${testAuth.token}` },
            payload: { user_code: "CCCC-DDDD", action: "approve" }
          })
        ).statusCode
      ).toBe(404);

      const approve = await app.inject({
        method: "POST",
        url: "/device/verify",
        headers: { authorization: `Bearer ${testAuth.token}` },
        payload: { user_code: userCode, action: "approve" }
      });
      expect(approve.statusCode).toBe(200);

      // IP streak cleared: two more bad codes do not lock yet.
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/device/verify",
            headers: { authorization: `Bearer ${testAuth.token}` },
            payload: { user_code: "EEEE-FFFF", action: "approve" }
          })
        ).statusCode
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/device/verify",
            headers: { authorization: `Bearer ${testAuth.token}` },
            payload: { user_code: "GGGG-HHHH", action: "approve" }
          })
        ).statusCode
      ).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("does not echo the raw device_code or user_code back in the /device/verify HTML", async () => {
    const app = await buildTestApp();
    try {
      const issueResponse = await app.inject({
        method: "POST",
        url: "/oauth/device/code",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: form({ client_id: "acs-cli", device_public_key: devicePublicKeyPem, device_name: "laptop" })
      });
      const { device_code: deviceCode, user_code: userCode } = issueResponse.json();
      const verifyPage = await app.inject({
        method: "GET",
        url: `/device/verify?user_code=${encodeURIComponent(userCode)}`,
        headers: { authorization: `Bearer ${testAuth.token}` }
      });
      expect(verifyPage.body).not.toContain(deviceCode);
    } finally {
      await app.close();
    }
  });

  it("POST /oauth/token grant_type=refresh_token enforces Ed25519 proof, supports idempotent recovery, and returns distinct acs_reason codes", async () => {
    const app = await buildTestApp();
    try {
      const issueResponse = await app.inject({
        method: "POST",
        url: "/oauth/device/code",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: form({ client_id: "acs-cli", device_public_key: devicePublicKeyPem, device_name: "laptop" })
      });
      const { device_code: deviceCode, user_code: userCode } = issueResponse.json();
      await app.inject({
        method: "POST",
        url: "/device/verify",
        headers: { authorization: `Bearer ${testAuth.token}` },
        payload: { user_code: userCode, action: "approve" }
      });
      const tokenResponse = await app.inject({
        method: "POST",
        url: "/oauth/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: form({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: deviceCode,
          device_signature: deviceProof(deviceCode),
          client_id: "acs-cli"
        })
      });
      const initial = tokenResponse.json();

      // Missing proof -> 400 invalid_request / missing_proof
      const missingProof = await app.inject({
        method: "POST",
        url: "/oauth/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: form({
          grant_type: "refresh_token",
          client_id: "acs-cli",
          refresh_token: initial.refresh_token
        })
      });
      expect(missingProof.statusCode).toBe(400);
      expect(missingProof.json()).toEqual({ error: "invalid_request", acs_reason: "missing_proof" });

      // Valid proof -> rotates
      const nowSec = Math.floor(Date.now() / 1000);
      const refresh1 = await app.inject({
        method: "POST",
        url: "/oauth/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: form({
          grant_type: "refresh_token",
          client_id: "acs-cli",
          device_id: initial.device_id,
          refresh_token: initial.refresh_token,
          proof_issued_at: String(nowSec),
          refresh_proof: refreshProof({
            clientId: "acs-cli",
            deviceId: initial.device_id,
            refreshToken: initial.refresh_token,
            issuedAt: nowSec
          })
        })
      });
      expect(refresh1.statusCode).toBe(200);
      const rotated = refresh1.json();
      expect(rotated.refresh_token).not.toBe(initial.refresh_token);

      // Idempotent retry with predecessor inside window -> same successor
      const retry = await app.inject({
        method: "POST",
        url: "/oauth/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: form({
          grant_type: "refresh_token",
          client_id: "acs-cli",
          device_id: initial.device_id,
          refresh_token: initial.refresh_token,
          proof_issued_at: String(nowSec),
          refresh_proof: refreshProof({
            clientId: "acs-cli",
            deviceId: initial.device_id,
            refreshToken: initial.refresh_token,
            issuedAt: nowSec
          })
        })
      });
      expect(retry.statusCode).toBe(200);
      expect(retry.json()).toEqual(rotated);

      // Unknown refresh token -> unknown_refresh_token
      const unknown = await app.inject({
        method: "POST",
        url: "/oauth/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: form({
          grant_type: "refresh_token",
          client_id: "acs-cli",
          device_id: initial.device_id,
          refresh_token: "not-a-real-refresh-token",
          proof_issued_at: String(nowSec),
          refresh_proof: refreshProof({
            clientId: "acs-cli",
            deviceId: initial.device_id,
            refreshToken: "not-a-real-refresh-token",
            issuedAt: nowSec
          })
        })
      });
      expect(unknown.statusCode).toBe(400);
      expect(unknown.json()).toEqual({ error: "invalid_grant", acs_reason: "unknown_refresh_token" });
    } finally {
      await app.close();
    }
  });

  it("POST /oauth/token grant_type=refresh_token fails closed with 503 recovery_unavailable when recovery key is absent", async () => {
    const app = await buildTestApp(undefined, testAuth, undefined, false);
    try {
      const issueResponse = await app.inject({
        method: "POST",
        url: "/oauth/device/code",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: form({ client_id: "acs-cli", device_public_key: devicePublicKeyPem, device_name: "laptop" })
      });
      const { device_code: deviceCode, user_code: userCode } = issueResponse.json();
      await app.inject({
        method: "POST",
        url: "/device/verify",
        headers: { authorization: `Bearer ${testAuth.token}` },
        payload: { user_code: userCode, action: "approve" }
      });
      const tokenResponse = await app.inject({
        method: "POST",
        url: "/oauth/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: form({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: deviceCode,
          device_signature: deviceProof(deviceCode),
          client_id: "acs-cli"
        })
      });
      const initial = tokenResponse.json();
      const nowSec = Math.floor(Date.now() / 1000);
      const refreshRes = await app.inject({
        method: "POST",
        url: "/oauth/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: form({
          grant_type: "refresh_token",
          client_id: "acs-cli",
          device_id: initial.device_id,
          refresh_token: initial.refresh_token,
          proof_issued_at: String(nowSec),
          refresh_proof: refreshProof({
            clientId: "acs-cli",
            deviceId: initial.device_id,
            refreshToken: initial.refresh_token,
            issuedAt: nowSec
          })
        })
      });
      expect(refreshRes.statusCode).toBe(503);
      expect(refreshRes.json()).toEqual({ error: "server_error", acs_reason: "recovery_unavailable" });
    } finally {
      await app.close();
    }
  });

  it("POST /devices/:id/revoke requires operator authorization, rejects device tokens, and immediately invalidates access and refresh tokens", async () => {
    const app = await buildTestApp();
    try {
      const issueResponse = await app.inject({
        method: "POST",
        url: "/oauth/device/code",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: form({
          client_id: "acs-cli",
          scope: "acs:device acs:work:create acs:work:read",
          device_public_key: devicePublicKeyPem,
          device_name: "laptop"
        })
      });
      const { device_code: deviceCode, user_code: userCode } = issueResponse.json();
      await app.inject({
        method: "POST",
        url: "/device/verify",
        headers: { authorization: `Bearer ${testAuth.token}` },
        payload: { user_code: userCode, action: "approve" }
      });
      const tokenResponse = await app.inject({
        method: "POST",
        url: "/oauth/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: form({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: deviceCode,
          device_signature: deviceProof(deviceCode),
          client_id: "acs-cli"
        })
      });
      const initial = tokenResponse.json();

      // Device access token works on authenticated read path before revocation
      const beforeRevoke = await app.inject({
        method: "GET",
        url: "/work-items",
        headers: { authorization: `Bearer ${initial.access_token}` }
      });
      expect(beforeRevoke.statusCode).toBe(200);

      // Device token itself CANNOT call POST /devices/:id/revoke (even with acs:work:create)
      const selfRevoke = await app.inject({
        method: "POST",
        url: `/devices/${initial.device_id}/revoke`,
        headers: { authorization: `Bearer ${initial.access_token}` }
      });
      expect(selfRevoke.statusCode).toBe(403);

      // Operator CAN revoke
      const opRevoke = await app.inject({
        method: "POST",
        url: `/devices/${initial.device_id}/revoke`,
        headers: { authorization: `Bearer ${testAuth.token}` }
      });
      expect(opRevoke.statusCode).toBe(200);
      expect(opRevoke.json()).toEqual({ ok: true });

      // Access token fails immediately on authenticated path
      const afterRevoke = await app.inject({
        method: "GET",
        url: "/work-items",
        headers: { authorization: `Bearer ${initial.access_token}` }
      });
      expect(afterRevoke.statusCode).toBe(401);

      // Refresh token fails with device_revoked
      const nowSec = Math.floor(Date.now() / 1000);
      const refreshAfterRevoke = await app.inject({
        method: "POST",
        url: "/oauth/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: form({
          grant_type: "refresh_token",
          client_id: "acs-cli",
          device_id: initial.device_id,
          refresh_token: initial.refresh_token,
          proof_issued_at: String(nowSec),
          refresh_proof: refreshProof({
            clientId: "acs-cli",
            deviceId: initial.device_id,
            refreshToken: initial.refresh_token,
            issuedAt: nowSec
          })
        })
      });
      expect(refreshAfterRevoke.statusCode).toBe(400);
      expect(refreshAfterRevoke.json()).toEqual({ error: "invalid_grant", acs_reason: "device_revoked" });

      // Invalid proof against a revoked device returns the exact same HTTP status and error
      // payload as a nonexistent device ID (no device-existence / revocation oracle).
      const invalidProofRevoked = await app.inject({
        method: "POST",
        url: "/oauth/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: form({
          grant_type: "refresh_token",
          client_id: "acs-cli",
          device_id: initial.device_id,
          refresh_token: initial.refresh_token,
          proof_issued_at: String(nowSec),
          refresh_proof: "invalid-proof-signature"
        })
      });
      const invalidProofNonexistent = await app.inject({
        method: "POST",
        url: "/oauth/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: form({
          grant_type: "refresh_token",
          client_id: "acs-cli",
          device_id: "nonexistent-device-id",
          refresh_token: initial.refresh_token,
          proof_issued_at: String(nowSec),
          refresh_proof: "invalid-proof-signature"
        })
      });
      expect(invalidProofRevoked.statusCode).toBe(400);
      expect(invalidProofRevoked.statusCode).toBe(invalidProofNonexistent.statusCode);
      expect(invalidProofRevoked.json()).toEqual({
        error: "invalid_grant",
        acs_reason: "unknown_refresh_token"
      });
      expect(invalidProofRevoked.json()).toEqual(invalidProofNonexistent.json());
    } finally {
      await app.close();
    }
  });
});
