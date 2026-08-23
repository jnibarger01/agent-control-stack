import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { afterEach, describe, expect, it } from "vitest";
import { buildGateway } from "./server.js";

const testAuth = { token: "operator-token-0123456789abcdef", actor: "user", actorId: "operator-1" } as const;

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

  async function buildTestApp() {
    dir = mkdtempSync(join(tmpdir(), "acs-device-http-"));
    const dbPath = join(dir, "control.db");
    seedActor(dbPath);
    const app = buildGateway({ dbPath, logger: false, auth: testAuth });
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
          device_public_key: "PEM",
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
        payload: form({ client_id: "not-acs-cli", device_public_key: "PEM" })
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

  it("full approval round trip: issue -> pending poll -> authenticated approve -> token exchange -> replay rejected", async () => {
    const app = await buildTestApp();
    try {
      const issueResponse = await app.inject({
        method: "POST",
        url: "/oauth/device/code",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: form({ client_id: "acs-cli", device_public_key: "PEM-ROUNDTRIP", device_name: "laptop" })
      });
      const { device_code: deviceCode, user_code: userCode } = issueResponse.json();

      const pendingPoll = await app.inject({
        method: "POST",
        url: "/oauth/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: form({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: deviceCode,
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
        payload: form({ client_id: "acs-cli", device_public_key: "PEM-DENY", device_name: "laptop" })
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

  it("does not echo the raw device_code or user_code back in the /device/verify HTML", async () => {
    const app = await buildTestApp();
    try {
      const issueResponse = await app.inject({
        method: "POST",
        url: "/oauth/device/code",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: form({ client_id: "acs-cli", device_public_key: "PEM-REDACT", device_name: "laptop" })
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
});
