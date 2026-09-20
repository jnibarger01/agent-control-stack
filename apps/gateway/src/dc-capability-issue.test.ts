import { createPrivateKey, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strictCanonicalJsonV1 } from "@agent-control-stack/shared";
import { describe, expect, it } from "vitest";
import { buildGateway } from "./server.js";

const testAuth = { token: "dc-test-token", actor: "user", actorId: "user" } as const;

interface SigningKeys {
  privateKey: string;
  publicKeyPem: string;
}

function generateSigningKeys(): SigningKeys {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString()
  };
}

function capabilitySigningConfig(keys: SigningKeys) {
  return {
    runtimeId: "dc-test-runtime",
    keyId: "test-capability-key",
    privateKey: keys.privateKey,
    ttlMs: 29_000
  };
}

function issuePayload(
  app: Awaited<ReturnType<typeof buildGateway>>,
  overrides: Record<string, unknown> = {},
  headers: Record<string, string> = {}
) {
  return app.inject({
    method: "POST",
    url: "/dc/capability/issue",
    headers: { authorization: `Bearer ${testAuth.token}`, "x-dc-actor": "chatgpt:jacen", ...headers },
    payload: {
      client_id: "chatgpt-desktop",
      tool: "read_file",
      argsSummary: JSON.stringify({ path: "/tmp/acs-dc-test/notes.txt" }),
      ...overrides
    }
  });
}

describe("POST /dc/capability/issue", () => {
  it("rejects unauthenticated callers with 401", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-dc-capability-401-"));
    const keys = generateSigningKeys();
    const app = buildGateway({
      dbPath: join(dir, "control.db"),
      logger: false,
      auth: testAuth,
      desktopCommanderCapability: capabilitySigningConfig(keys)
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/dc/capability/issue",
        headers: { "x-dc-actor": "chatgpt:jacen" },
        payload: { client_id: "chatgpt-desktop", tool: "read_file", argsSummary: "{}" }
      });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed with 503 when capability signing is not configured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-dc-capability-503-"));
    const capabilityEnv = Object.keys(process.env).filter((key) => key.startsWith("ACS_DESKTOP_COMMANDER_"));
    const saved = Object.fromEntries(capabilityEnv.map((key) => [key, process.env[key]]));
    for (const key of capabilityEnv) delete process.env[key];
    const app = buildGateway({
      dbPath: join(dir, "control.db"),
      logger: false,
      auth: testAuth
    });
    try {
      const response = await issuePayload(app);
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ error: "capability issuance not configured" });
    } finally {
      await app.close();
      Object.assign(process.env, saved);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns 400 when the x-dc-actor header is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-dc-capability-400-"));
    const keys = generateSigningKeys();
    const app = buildGateway({
      dbPath: join(dir, "control.db"),
      logger: false,
      auth: testAuth,
      desktopCommanderCapability: capabilitySigningConfig(keys)
    });
    try {
      const response = await issuePayload(app, {}, { "x-dc-actor": "" });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ code: "dc_actor_invalid" });
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("denies unknown tools with 403 unknown_tool", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-dc-capability-unknown-"));
    const keys = generateSigningKeys();
    const app = buildGateway({
      dbPath: join(dir, "control.db"),
      logger: false,
      auth: testAuth,
      desktopCommanderCapability: capabilitySigningConfig(keys)
    });
    try {
      const response = await issuePayload(app, { tool: "execute_python" });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ decision: "deny", reason: "unknown_tool" });
      const events = await app.inject({
        method: "GET",
        url: "/api/events",
        headers: { authorization: `Bearer ${testAuth.token}` }
      });
      expect(events.json().events.map((event: { name: string }) => event.name)).toContain("connector.requested");
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("auto-approves a read-only call and returns a validly signed acs.dc.v1 envelope", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-dc-capability-allow-"));
    const keys = generateSigningKeys();
    const app = buildGateway({
      dbPath: join(dir, "control.db"),
      logger: false,
      auth: testAuth,
      desktopCommanderCapability: capabilitySigningConfig(keys)
    });
    try {
      const response = await issuePayload(app, {
        argsSummary: JSON.stringify({ path: join(dir, "notes.txt") })
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.decision).toBe("allow");
      expect(typeof body.workItemId).toBe("string");

      const capability = body.capability;
      expect(capability.keyId).toBe("test-capability-key");
      const payload = capability.payload;
      expect(payload.version).toBe("acs.dc.v1");
      expect(payload.issuer).toBe("acs");
      expect(payload.audience).toBe("desktop-commander");
      expect(payload.toolName).toBe("read_file");
      expect(payload.scopes).toEqual(["fs.read"]);
      expect(payload.workItemId).toBe(body.workItemId);
      expect(payload.leaseId).toBe(`dc-issue:${body.workItemId}`);
      expect(payload.leaseEpoch).toBe(1);
      expect(Date.parse(payload.expiresAt) - Date.parse(payload.issuedAt)).toBe(29_000);

      // Verify the Ed25519 signature over the exact strict canonical bytes
      // with the public key derived from the configured private key.
      const publicKey = createPublicKey(
        createPrivateKey({ key: Buffer.from(keys.privateKey, "base64url"), format: "der", type: "pkcs8" })
      );
      const valid = verify(
        null,
        Buffer.from(strictCanonicalJsonV1(payload), "utf8"),
        publicKey,
        Buffer.from(capability.signature, "base64url")
      );
      expect(valid).toBe(true);

      const detail = await app.inject({
        method: "GET",
        url: `/work-items/${body.workItemId}`,
        headers: { authorization: `Bearer ${testAuth.token}` }
      });
      const eventNames = detail.json().events.map((event: { name: string }) => event.name);
      expect(eventNames).toContain("connector.requested");
      expect(eventNames).toContain("policy.decided");
      expect(detail.json().workItem.status).toBe("approved");
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns 409 require_approval for a write call, then issues after the existing approval flow", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-dc-capability-approval-"));
    const keys = generateSigningKeys();
    const app = buildGateway({
      dbPath: join(dir, "control.db"),
      logger: false,
      auth: testAuth,
      desktopCommanderCapability: capabilitySigningConfig(keys)
    });
    try {
      const requested = await issuePayload(app, {
        tool: "write_file",
        argsSummary: JSON.stringify({ path: join(dir, "out.txt"), content: "hello" })
      });
      expect(requested.statusCode).toBe(409);
      const firstBody = requested.json();
      expect(firstBody.decision).toBe("require_approval");
      expect(firstBody.approvalInstructions).toContain(`POST /work-items/${firstBody.workItemId}/approve`);
      expect(firstBody.actionHash).toMatch(/^[a-f0-9]{64}$/u);

      // A second issuance before approval still does not mint a capability.
      const stillBlocked = await issuePayload(app, {
        tool: "write_file",
        argsSummary: JSON.stringify({ path: join(dir, "out.txt"), content: "hello" })
      });
      expect(stillBlocked.statusCode).toBe(409);

      // Existing approval flow: POST /work-items/:id/approve with actionHash.
      const approval = await app.inject({
        method: "POST",
        url: `/work-items/${firstBody.workItemId}/approve`,
        headers: { authorization: `Bearer ${testAuth.token}` },
        payload: { actionHash: firstBody.actionHash, reason: "operator approved" }
      });
      expect(approval.statusCode).toBe(200);

      const issued = await issuePayload(app, {
        tool: "write_file",
        argsSummary: JSON.stringify({ path: join(dir, "out.txt"), content: "hello" })
      });
      expect(issued.statusCode).toBe(200);
      const body = issued.json();
      expect(body.decision).toBe("allow");
      expect(body.workItemId).toBe(firstBody.workItemId);
      const payload = body.capability.payload;
      expect(payload.version).toBe("acs.dc.v1");
      expect(payload.toolName).toBe("write_file");
      expect(payload.scopes).toEqual(["fs.write"]);
      expect(typeof payload.approvalId).toBe("string");
      expect(payload.requiresApproval === undefined).toBe(true);

      const publicKey = createPublicKey(
        createPrivateKey({ key: Buffer.from(keys.privateKey, "base64url"), format: "der", type: "pkcs8" })
      );
      expect(
        verify(
          null,
          Buffer.from(strictCanonicalJsonV1(payload), "utf8"),
          publicKey,
          Buffer.from(body.capability.signature, "base64url")
        )
      ).toBe(true);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
