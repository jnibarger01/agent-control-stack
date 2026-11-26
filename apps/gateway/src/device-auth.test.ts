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
const devicePublicJwk = devicePair.publicKey.export({ format: "jwk" }) as { kty: string; crv: string; x: string };

function signDpopProof(input: {
  privateKey?: ReturnType<typeof generateKeyPairSync>["privateKey"];
  publicJwk?: Record<string, unknown>;
  alg?: string;
  typ?: string;
  htm: string;
  htu: string;
  accessToken?: string;
  jti?: string;
  iat?: number;
  nonce?: string;
}): string {
  const key = input.privateKey ?? devicePair.privateKey;
  const jwk = input.publicJwk ?? { kty: devicePublicJwk.kty, crv: devicePublicJwk.crv, x: devicePublicJwk.x };
  const header = Buffer.from(
    JSON.stringify({
      typ: input.typ ?? "dpop+jwt",
      alg: input.alg ?? "EdDSA",
      jwk
    }),
    "utf8"
  ).toString("base64url");
  const claims: Record<string, unknown> = {
    jti: input.jti ?? randomBytes(16).toString("base64url"),
    htm: input.htm,
    htu: input.htu,
    iat: input.iat ?? Math.floor(Date.now() / 1000)
  };
  if (input.accessToken !== undefined) {
    claims.ath = createHash("sha256").update(input.accessToken, "ascii").digest("base64url");
  }
  if (input.nonce !== undefined) {
    claims.nonce = input.nonce;
  }
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signingInput = `${header}.${payload}`;
  const sig =
    (input.alg ?? "EdDSA") === "EdDSA"
      ? sign(null, Buffer.from(signingInput, "utf8"), key).toString("base64url")
      : Buffer.alloc(64, 1).toString("base64url");
  return `${signingInput}.${sig}`;
}

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
    },
    extraOptions?: {
      dbPath?: string;
      publicOrigin?: string;
      dpopNonceRequired?: boolean;
      dpopNonceSecret?: string;
    }
  ) {
    if (!extraOptions?.dbPath) {
      dir = mkdtempSync(join(tmpdir(), "acs-device-http-"));
    }
    const dbPath = extraOptions?.dbPath ?? join(dir!, "control.db");
    seedActor(dbPath);
    const app = buildGateway({
      dbPath,
      logger: false,
      auth,
      deviceRefreshRecovery,
      ...(extraOptions?.publicOrigin ? { publicOrigin: extraOptions.publicOrigin } : {}),
      ...(extraOptions?.dpopNonceRequired !== undefined ? { dpopNonceRequired: extraOptions.dpopNonceRequired } : {}),
      ...(extraOptions?.dpopNonceSecret ? { dpopNonceSecret: extraOptions.dpopNonceSecret } : {}),
      ...(rateLimit ? { rateLimit } : {}),
      ...(authLockout ? { authLockout } : {})
    });
    await app.ready();
    return app;
  }

  it("issues a device code using trusted publicOrigin and ignores forged Host / X-Forwarded-* headers", async () => {
    const app = await buildTestApp(undefined, testAuth, undefined, undefined, {
      publicOrigin: "https://acs.example.test"
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/oauth/device/code",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          host: "evil.attacker.test",
          "x-forwarded-host": "evil.attacker.test",
          "x-forwarded-proto": "http"
        },
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
      expect(body.verification_uri).toBe("https://acs.example.test/device/verify");
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

  it("rejects duplicated form fields (RFC 6749 section 3.2) and never lets a repeated action or user_code pick approve", async () => {
    const app = await buildTestApp();
    try {
      const issue = await app.inject({
        method: "POST",
        url: "/oauth/device/code",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: form({ client_id: "acs-cli", device_public_key: devicePublicKeyPem })
      });
      const { user_code: userCode } = issue.json();
      const auth = { authorization: `Bearer ${testAuth.token}`, "content-type": "application/x-www-form-urlencoded" };
      const decide = (payload: string) => app.inject({ method: "POST", url: "/device/verify", headers: auth, payload });

      // deny first, approve last: a last-wins parser would approve.
      const dupAction = await decide(`user_code=${encodeURIComponent(userCode)}&action=deny&action=approve`);
      expect(dupAction.statusCode).toBe(400);
      // approve first, deny last: a first-wins parser would approve.
      const dupAction2 = await decide(`user_code=${encodeURIComponent(userCode)}&action=approve&action=deny`);
      expect(dupAction2.statusCode).toBe(400);
      // the code a different user_code would have been decided against
      const dupCode = await decide(`user_code=AAAA-BBBB&user_code=${encodeURIComponent(userCode)}&action=approve`);
      expect(dupCode.statusCode).toBe(400);
      // Duplicated protocol fields on the other form endpoints fail closed too.
      const dupClient = await app.inject({
        method: "POST",
        url: "/oauth/device/code",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: `client_id=acs-cli&client_id=other&device_public_key=${encodeURIComponent(devicePublicKeyPem)}`
      });
      expect(dupClient.statusCode).toBe(400);

      // None of the rejected requests decided the code: a single-valued approve still works afterwards.
      const ok = await decide(`user_code=${encodeURIComponent(userCode)}&action=approve`);
      expect(ok.statusCode).toBe(200);
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
      expect(tokenBody.token_type).toBe("DPoP");
      expect(tokenBody.cnf).toEqual({ jkt: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });

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
        payload: form({
          client_id: "acs-cli",
          scope: "acs:work:read",
          device_public_key: devicePublicKeyPem,
          device_name: "laptop"
        })
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
        payload: form({
          client_id: "acs-cli",
          scope: "acs:work:read",
          device_public_key: devicePublicKeyPem,
          device_name: "laptop"
        })
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

      // Device access token works on authenticated read path with valid DPoP proof before revocation
      const beforeRevoke = await app.inject({
        method: "GET",
        url: "/work-items",
        headers: {
          authorization: `DPoP ${initial.access_token}`,
          dpop: signDpopProof({
            htm: "GET",
            htu: "http://127.0.0.1/work-items",
            accessToken: initial.access_token
          })
        }
      });
      expect(beforeRevoke.statusCode).toBe(200);

      // Plain Bearer downgrade with a device access token MUST fail closed (401)
      const bearerDowngrade = await app.inject({
        method: "GET",
        url: "/work-items",
        headers: { authorization: `Bearer ${initial.access_token}` }
      });
      expect(bearerDowngrade.statusCode).toBe(401);
      expect(bearerDowngrade.headers["www-authenticate"]).toContain("DPoP");

      // Device token itself CANNOT call POST /devices/:id/revoke (even with DPoP + acs:work:create)
      const selfRevoke = await app.inject({
        method: "POST",
        url: `/devices/${initial.device_id}/revoke`,
        headers: {
          authorization: `DPoP ${initial.access_token}`,
          dpop: signDpopProof({
            htm: "POST",
            htu: `http://127.0.0.1/devices/${initial.device_id}/revoke`,
            accessToken: initial.access_token
          })
        }
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

      // Access token fails immediately on authenticated path even with a fresh valid DPoP proof
      const afterRevoke = await app.inject({
        method: "GET",
        url: "/work-items",
        headers: {
          authorization: `DPoP ${initial.access_token}`,
          dpop: signDpopProof({
            htm: "GET",
            htu: "http://127.0.0.1/work-items",
            accessToken: initial.access_token
          })
        }
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

  it("enforces RFC 9449 DPoP on protected ACS requests, blocks jti replay across restarts, and preserves scope boundaries", async () => {
    dir = mkdtempSync(join(tmpdir(), "acs-device-dpop-"));
    const dbPath = join(dir, "control.db");
    const app1 = await buildTestApp(undefined, testAuth, undefined, undefined, {
      dbPath,
      publicOrigin: "https://acs.example.test"
    });
    const pair2 = generateKeyPairSync("ed25519");
    const pem2 = pair2.publicKey.export({ type: "spki", format: "pem" }).toString();
    const jwk2 = pair2.publicKey.export({ format: "jwk" }) as { kty: string; crv: string; x: string };

    let initial: { access_token: string; device_id: string; cnf: { jkt: string } };
    try {
      const issue = await app1.inject({
        method: "POST",
        url: "/oauth/device/code",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: form({
          client_id: "jace-commander",
          scope: "acs:device acs:work:create acs:work:read",
          device_public_key: devicePublicKeyPem,
          device_name: "jc-laptop"
        })
      });
      expect(issue.statusCode).toBe(200);
      const { device_code: deviceCode, user_code: userCode } = issue.json();
      expect((await app1.inject({
        method: "POST",
        url: "/device/verify",
        headers: { authorization: `Bearer ${testAuth.token}` },
        payload: { user_code: userCode, action: "approve" }
      })).statusCode).toBe(200);

      const tok = await app1.inject({
        method: "POST",
        url: "/oauth/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: form({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: deviceCode,
          device_signature: deviceProof(deviceCode),
          client_id: "jace-commander"
        })
      });
      expect(tok.statusCode).toBe(200);
      initial = tok.json();

      // Enroll a second device for the same principal to test multi-device GET /devices
      const issue2 = await app1.inject({
        method: "POST",
        url: "/oauth/device/code",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: form({
          client_id: "acs-cli",
          scope: "acs:device",
          device_public_key: pem2,
          device_name: "acs-workstation"
        })
      });
      const code2 = issue2.json();
      await app1.inject({
        method: "POST",
        url: "/device/verify",
        headers: { authorization: `Bearer ${testAuth.token}` },
        payload: { user_code: code2.user_code, action: "approve" }
      });
      await app1.inject({
        method: "POST",
        url: "/oauth/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: form({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: code2.device_code,
          device_signature: sign(null, Buffer.from(`acs-device-code-proof-v1\n${code2.device_code}`, "utf8"), pair2.privateKey).toString("base64url"),
          client_id: "acs-cli"
        })
      });

      const targetHtu = "https://acs.example.test/work-items";
      const replayedJti = "fixed-jti-0123456789abcdef";

      // Valid DPoP request succeeds (even with query params in request URL; htu strips query)
      const okRes = await app1.inject({
        method: "GET",
        url: "/work-items?limit=10",
        headers: {
          authorization: `DPoP ${initial.access_token}`,
          dpop: signDpopProof({ htm: "GET", htu: targetHtu, accessToken: initial.access_token, jti: replayedJti })
        }
      });
      expect(okRes.statusCode).toBe(200);

      // Replaying the same jti on the same gateway fails closed (401)
      const sameReplay = await app1.inject({
        method: "GET",
        url: "/work-items",
        headers: {
          authorization: `DPoP ${initial.access_token}`,
          dpop: signDpopProof({ htm: "GET", htu: targetHtu, accessToken: initial.access_token, jti: replayedJti })
        }
      });
      expect(sameReplay.statusCode).toBe(401);

      // Forged Host / X-Forwarded-Host matching forged htu MUST fail (server trusts configured publicOrigin only)
      const forgedHost = await app1.inject({
        method: "GET",
        url: "/work-items",
        headers: {
          host: "evil.attacker.test",
          "x-forwarded-host": "evil.attacker.test",
          "x-forwarded-proto": "http",
          authorization: `DPoP ${initial.access_token}`,
          dpop: signDpopProof({ htm: "GET", htu: "http://evil.attacker.test/work-items", accessToken: initial.access_token })
        }
      });
      expect(forgedHost.statusCode).toBe(401);

      // Negative DPoP claims & header checks
      const badCases = [
        // Missing DPoP header
        { headers: { authorization: `DPoP ${initial.access_token}` } },
        // Bearer downgrade
        { headers: { authorization: `Bearer ${initial.access_token}` } },
        // ath mismatch
        {
          headers: {
            authorization: `DPoP ${initial.access_token}`,
            dpop: signDpopProof({ htm: "GET", htu: targetHtu, accessToken: "wrong-token" })
          }
        },
        // htm mismatch
        {
          headers: {
            authorization: `DPoP ${initial.access_token}`,
            dpop: signDpopProof({ htm: "POST", htu: targetHtu, accessToken: initial.access_token })
          }
        },
        // htu with query string
        {
          headers: {
            authorization: `DPoP ${initial.access_token}`,
            dpop: signDpopProof({ htm: "GET", htu: `${targetHtu}?limit=10`, accessToken: initial.access_token })
          }
        },
        // iat expired (> 60s)
        {
          headers: {
            authorization: `DPoP ${initial.access_token}`,
            dpop: signDpopProof({
              htm: "GET",
              htu: targetHtu,
              accessToken: initial.access_token,
              iat: Math.floor(Date.now() / 1000) - 65
            })
          }
        },
        // Wrong signing key (different device jkt)
        {
          headers: {
            authorization: `DPoP ${initial.access_token}`,
            dpop: signDpopProof({
              privateKey: pair2.privateKey,
              publicJwk: { kty: jwk2.kty, crv: jwk2.crv, x: jwk2.x },
              htm: "GET",
              htu: targetHtu,
              accessToken: initial.access_token
            })
          }
        },
        // Private parameter d in jwk
        {
          headers: {
            authorization: `DPoP ${initial.access_token}`,
            dpop: signDpopProof({
              publicJwk: { kty: devicePublicJwk.kty, crv: devicePublicJwk.crv, x: devicePublicJwk.x, d: "secret" },
              htm: "GET",
              htu: targetHtu,
              accessToken: initial.access_token
            })
          }
        },
        // Disallowed alg
        {
          headers: {
            authorization: `DPoP ${initial.access_token}`,
            dpop: signDpopProof({ alg: "HS256", htm: "GET", htu: targetHtu, accessToken: initial.access_token })
          }
        }
      ];
      for (const bad of badCases) {
        const res = await app1.inject({ method: "GET", url: "/work-items", headers: bad.headers });
        expect(res.statusCode).toBe(401);
      }

      // GET /devices works for DPoP device (scoped to its principal) and for operator
      const deviceList = await app1.inject({
        method: "GET",
        url: "/devices",
        headers: {
          authorization: `DPoP ${initial.access_token}`,
          dpop: signDpopProof({ htm: "GET", htu: "https://acs.example.test/devices", accessToken: initial.access_token })
        }
      });
      expect(deviceList.statusCode).toBe(200);
      expect(deviceList.json().devices).toHaveLength(2);

      // Device cannot query another principal_id
      const foreignList = await app1.inject({
        method: "GET",
        url: "/devices?principal_id=operator-2",
        headers: {
          authorization: `DPoP ${initial.access_token}`,
          dpop: signDpopProof({ htm: "GET", htu: "https://acs.example.test/devices", accessToken: initial.access_token })
        }
      });
      expect(foreignList.statusCode).toBe(403);

      // Scope & approval isolation preserved even with valid DPoP
      const adminEscalation = await app1.inject({
        method: "POST",
        url: "/execution-mode",
        headers: {
          authorization: `DPoP ${initial.access_token}`,
          dpop: signDpopProof({ htm: "POST", htu: "https://acs.example.test/execution-mode", accessToken: initial.access_token }),
          "content-type": "application/json"
        },
        payload: { mode: "admin", reason: "device must not elevate" }
      });
      expect(adminEscalation.statusCode).toBe(403);
    } finally {
      await app1.close();
    }

    // Restart gateway on the same DB: replaying the same jti MUST still fail!
    const app2 = await buildTestApp(undefined, testAuth, undefined, undefined, {
      dbPath,
      publicOrigin: "https://acs.example.test"
    });
    try {
      const restartReplay = await app2.inject({
        method: "GET",
        url: "/work-items",
        headers: {
          authorization: `DPoP ${initial.access_token}`,
          dpop: signDpopProof({
            htm: "GET",
            htu: "https://acs.example.test/work-items",
            accessToken: initial.access_token,
            jti: "fixed-jti-0123456789abcdef"
          })
        }
      });
      expect(restartReplay.statusCode).toBe(401);

      const freshAfterRestart = await app2.inject({
        method: "GET",
        url: "/work-items",
        headers: {
          authorization: `DPoP ${initial.access_token}`,
          dpop: signDpopProof({
            htm: "GET",
            htu: "https://acs.example.test/work-items",
            accessToken: initial.access_token
          })
        }
      });
      expect(freshAfterRestart.statusCode).toBe(200);
    } finally {
      await app2.close();
    }
  });

  it("enforces DPoP-Nonce challenge and retry when dpopNonceRequired is enabled", async () => {
    const app = await buildTestApp(undefined, testAuth, undefined, undefined, {
      publicOrigin: "https://acs.example.test",
      dpopNonceRequired: true,
      dpopNonceSecret: "test-acs-dpop-nonce-secret-0123456789"
    });
    try {
      const issue = await app.inject({
        method: "POST",
        url: "/oauth/device/code",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: form({
          client_id: "acs-cli",
          scope: "acs:work:read",
          device_public_key: devicePublicKeyPem,
          device_name: "laptop"
        })
      });
      const { device_code: deviceCode, user_code: userCode } = issue.json();
      await app.inject({
        method: "POST",
        url: "/device/verify",
        headers: { authorization: `Bearer ${testAuth.token}` },
        payload: { user_code: userCode, action: "approve" }
      });
      const tok = await app.inject({
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
      const initial = tok.json();

      // Missing nonce -> 401 with WWW-Authenticate: DPoP error="use_dpop_nonce" and DPoP-Nonce header
      const noNonce = await app.inject({
        method: "GET",
        url: "/work-items",
        headers: {
          authorization: `DPoP ${initial.access_token}`,
          dpop: signDpopProof({ htm: "GET", htu: "https://acs.example.test/work-items", accessToken: initial.access_token })
        }
      });
      expect(noNonce.statusCode).toBe(401);
      expect(noNonce.headers["www-authenticate"]).toContain('error="use_dpop_nonce"');
      const nonce = noNonce.headers["dpop-nonce"] as string;
      expect(nonce).toBeTruthy();

      // Forged nonce -> 401 use_dpop_nonce
      const badNonce = await app.inject({
        method: "GET",
        url: "/work-items",
        headers: {
          authorization: `DPoP ${initial.access_token}`,
          dpop: signDpopProof({
            htm: "GET",
            htu: "https://acs.example.test/work-items",
            accessToken: initial.access_token,
            nonce: "forged-nonce"
          })
        }
      });
      expect(badNonce.statusCode).toBe(401);

      // Valid nonce -> 200
      const withNonce = await app.inject({
        method: "GET",
        url: "/work-items",
        headers: {
          authorization: `DPoP ${initial.access_token}`,
          dpop: signDpopProof({
            htm: "GET",
            htu: "https://acs.example.test/work-items",
            accessToken: initial.access_token,
            nonce
          })
        }
      });
      expect(withNonce.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });
});
