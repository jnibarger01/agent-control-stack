import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGateway } from "./server.js";

/**
 * With ACS_DEVICE_CLIENT_IDS adding a public client (ARES Studio), /device/verify must show the approving human
 * only the documented fields and nothing else. All tokens and keys here are synthetic.
 */
const OPERATOR = { token: "SYNTH-operator-token-0123456789abcdef", actor: "user", actorId: "operator-1" } as const;
const pem = (
  generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }) as string | Buffer
).toString();

describe("/device/verify exposure with ACS_DEVICE_CLIENT_IDS set", () => {
  let dir: string | undefined;
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.ACS_DEVICE_CLIENT_IDS;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.ACS_DEVICE_CLIENT_IDS;
    else process.env.ACS_DEVICE_CLIENT_IDS = saved;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function app(clientIds: string | undefined) {
    if (clientIds === undefined) delete process.env.ACS_DEVICE_CLIENT_IDS;
    else process.env.ACS_DEVICE_CLIENT_IDS = clientIds;
    dir = mkdtempSync(join(tmpdir(), "acs-device-exposure-"));
    const dbPath = join(dir, "control.db");
    const store = new SqliteWorkItemStore(dbPath);
    try {
      store.registerActor({ id: OPERATOR.actorId, actorType: "HUMAN", displayName: "Operator One" });
    } finally {
      store.close();
    }
    const gateway = buildGateway({ dbPath, logger: false, auth: OPERATOR });
    await gateway.ready();
    return gateway;
  }

  const code = (gateway: Awaited<ReturnType<typeof app>>, clientId: string, deviceName: string) =>
    gateway.inject({
      method: "POST",
      url: "/oauth/device/code",
      headers: { "content-type": "application/json" },
      payload: {
        client_id: clientId,
        device_public_key: pem,
        device_name: deviceName,
        scope: "acs:work:create acs:work:read"
      }
    });

  it("shows the requesting client, device, fingerprint and actual scopes without secrets", async () => {
    const gateway = await app("acs-cli,ares-studio");
    try {
      const issued = await code(gateway, "ares-studio", `Alice's ARES <script>alert(1)</script>`);
      expect(issued.statusCode).toBe(200);
      const { user_code: userCode, device_code: deviceCode } = issued.json() as {
        user_code: string;
        device_code: string;
      };
      const page = await gateway.inject({
        method: "GET",
        url: `/device/verify?user_code=${encodeURIComponent(userCode)}`,
        headers: { authorization: `Bearer ${OPERATOR.token}` }
      });
      expect(page.statusCode).toBe(200);
      const html = page.body;
      const labels = [...html.matchAll(/<dt>([^<]+)<\/dt>/g)].map((m) => m[1]);
      expect(labels).toEqual(["Client ID", "Device", "Public key fingerprint", "Requested scopes"]);
      expect(html).toContain("<dt>Client ID</dt><dd>ares-studio</dd>");
      expect(html).toContain("acs:work:create, acs:work:read");
      expect(html).not.toContain("<script>alert(1)</script>");
      expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
      for (const forbidden of [
        deviceCode,
        OPERATOR.token,
        "BEGIN PUBLIC KEY",
        "ACS_DEVICE_CLIENT_IDS",
        "device_code",
        "access_token",
        "refresh_token"
      ]) {
        expect(html, forbidden).not.toContain(forbidden);
      }
    } finally {
      await gateway.close();
    }
  });

  it("never shows another pending request's code or device name", async () => {
    const gateway = await app("acs-cli,ares-studio");
    try {
      const mine = (await code(gateway, "ares-studio", "my-device")).json() as { user_code: string };
      const other = (await code(gateway, "acs-cli", "SYNTH-someone-elses-laptop")).json() as { user_code: string };
      const page = await gateway.inject({
        method: "GET",
        url: `/device/verify?user_code=${encodeURIComponent(mine.user_code)}`,
        headers: { authorization: `Bearer ${OPERATOR.token}` }
      });
      expect(page.body).toContain("my-device");
      expect(page.body).not.toContain("SYNTH-someone-elses-laptop");
      expect(page.body).not.toContain(other.user_code);
    } finally {
      await gateway.close();
    }
  });

  it("shows no device information to an unauthenticated visitor", async () => {
    const gateway = await app("acs-cli,ares-studio");
    try {
      const mine = (await code(gateway, "ares-studio", "SYNTH-private-device-name")).json() as { user_code: string };
      const page = await gateway.inject({
        method: "GET",
        url: `/device/verify?user_code=${encodeURIComponent(mine.user_code)}`
      });
      expect(page.statusCode).toBe(401);
      expect(page.body).not.toContain("SYNTH-private-device-name");
      expect(page.body).not.toContain("Requested scopes");
    } finally {
      await gateway.close();
    }
  });

  it("allows exactly the configured client ids: unlisted ids are refused, and ares-studio is refused when the variable is unset", async () => {
    const listed = await app("acs-cli,ares-studio");
    try {
      expect((await code(listed, "ares-studio", "d")).statusCode).toBe(200);
      expect((await code(listed, "acs-cli", "d")).statusCode).toBe(200);
      const refused = await code(listed, "evil-client", "d");
      expect(refused.statusCode).toBe(400);
      expect((await code(listed, "ARES-STUDIO", "d")).statusCode).toBe(400);
    } finally {
      await listed.close();
    }
    const unset = await app(undefined);
    try {
      expect((await code(unset, "acs-cli", "d")).statusCode).toBe(200);
      expect((await code(unset, "ares-studio", "d")).statusCode).toBe(400);
    } finally {
      await unset.close();
    }
  });
});
