import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strictCanonicalJsonV1 } from "@agent-control-stack/shared";
import { describe, expect, it } from "vitest";
import { buildGateway, type GatewayCredential } from "./server.js";

const testAuth = { token: "op-token", actor: "user", actorId: "user" } as const;
const WORKER_TOKEN = "bridge-worker-token";
const RUNTIME_ID = "dc-test-runtime";
const IDENTITY_FINGERPRINT = "a".repeat(64);
const RUNTIME_SCOPES = ["fs.read", "fs.write", "process.exec", "process.spawn"];

const credentials: GatewayCredential[] = [
  {
    id: "op",
    token: testAuth.token,
    actor: "user",
    actorId: "user",
    roles: ["operator"],
    scopes: ["acs:read", "acs:write", "acs:approve"]
  },
  {
    id: "dc-bridge",
    token: WORKER_TOKEN,
    actor: "agent",
    actorId: "acs-dc-bridge",
    roles: ["service", "worker"],
    scopes: ["acs:read", "acs:write", "acs:worker"]
  }
];

interface TestContext {
  root: string;
  keys: { privateKey: string; publicKeyPem: string };
  app: Awaited<ReturnType<typeof buildGateway>>;
}

function generateKeys() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString()
  };
}

function signingConfig(keys: TestContext["keys"]) {
  return {
    runtimeId: RUNTIME_ID,
    keyId: "test-capability-key",
    privateKey: keys.privateKey,
    ttlMs: 29_000,
    identityConfigFingerprint: IDENTITY_FINGERPRINT,
    runtimeScopes: RUNTIME_SCOPES
  };
}

async function buildTestGateway(dbName = "control.db"): Promise<TestContext> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "acs-dc-capability-")));
  const keys = generateKeys();
  const app = buildGateway({
    dbPath: join(root, dbName),
    logger: false,
    auth: { token: "", actor: "user", actorId: testAuth.actorId, credentials },
    desktopCommanderCapability: signingConfig(keys),
    desktopCommanderContainment: { allowedRoots: [root], deniedRoots: [] }
  });
  return { root, keys, app };
}

const AUTH = { authorization: `Bearer ${testAuth.token}` };

async function attestRuntime(ctx: TestContext): Promise<void> {
  const bootstrap = await ctx.app.inject({
    method: "POST",
    url: "/dc/runtime/bootstrap",
    headers: AUTH,
    payload: {
      runtimeId: RUNTIME_ID,
      identityConfigFingerprint: IDENTITY_FINGERPRINT,
      scopes: RUNTIME_SCOPES
    }
  });
  expect(bootstrap.statusCode).toBe(201);
  const { challenge } = bootstrap.json();
  const completed = await ctx.app.inject({
    method: "POST",
    url: "/dc/runtime/bootstrap/complete",
    headers: AUTH,
    payload: {
      runtimeId: RUNTIME_ID,
      identityConfigFingerprint: IDENTITY_FINGERPRINT,
      scopes: RUNTIME_SCOPES,
      challenge
    }
  });
  expect(completed.statusCode).toBe(204);
}

function issuePayload(app: TestContext["app"], tool: string, args: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/dc/capability/issue",
    headers: { ...AUTH, "x-dc-actor": "chatgpt:jacen" },
    payload: {
      client_id: "chatgpt-desktop",
      tool,
      argsSummary: JSON.stringify(args)
    }
  });
}

function verifyEnvelopeSignature(payload: unknown, signature: string, keys: TestContext["keys"]): boolean {
  const publicKey = createPublicKey(
    createPrivateKey({ key: Buffer.from(keys.privateKey, "base64url"), format: "der", type: "pkcs8" })
  );
  return verify(
    null,
    Buffer.from(strictCanonicalJsonV1(payload), "utf8"),
    publicKey,
    Buffer.from(signature, "base64url")
  );
}

/** The canonical attempt-bound idempotency key the result contract requires. */
function attemptResultIdempotencyKey(attemptId: string): string {
  // stableHash({ domain: "acs.attempt-result.v1", attemptId }): canonical JSON
  // is key-sorted, so attemptId precedes domain.
  return createHash("sha256").update(`{"attemptId":"${attemptId}","domain":"acs.attempt-result.v1"}`).digest("hex");
}

describe("POST /dc/capability/issue (lease-bound)", () => {
  it("rejects unauthenticated callers with 401", async () => {
    const ctx = await buildTestGateway();
    try {
      const response = await ctx.app.inject({
        method: "POST",
        url: "/dc/capability/issue",
        headers: { "x-dc-actor": "chatgpt:jacen" },
        payload: { client_id: "chatgpt-desktop", tool: "read_file", argsSummary: "{}" }
      });
      expect(response.statusCode).toBe(401);
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it("fails closed with 503 when capability signing is not configured", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "acs-dc-capability-503-")));
    const capabilityEnv = Object.keys(process.env).filter((key) => key.startsWith("ACS_DESKTOP_COMMANDER_"));
    const saved = Object.fromEntries(capabilityEnv.map((key) => [key, process.env[key]]));
    for (const key of capabilityEnv) delete process.env[key];
    const app = buildGateway({
      dbPath: join(root, "control.db"),
      logger: false,
      auth: { token: "", actor: "user", actorId: "user", credentials }
    });
    try {
      const response = await issuePayload(app, "read_file", { path: join(root, "x.txt") });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ error: "capability issuance not configured" });
    } finally {
      await app.close();
      Object.assign(process.env, saved);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("attests a managed runtime, then issues a lease-bound capability for a read-only call", async () => {
    const ctx = await buildTestGateway();
    try {
      await attestRuntime(ctx);
      const response = await issuePayload(ctx.app, "read_file", { path: join(ctx.root, "notes.txt") });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      const payload = body.capability.payload;

      // REAL ACS authority: attempt/lease values minted by the claim machinery.
      expect(payload.attemptId).toMatch(/^attempt_/);
      expect(payload.leaseId).toMatch(/^lease_/);
      expect(payload.leaseEpoch).toBeGreaterThanOrEqual(1);
      expect(payload.workItemId).toBe(body.workItemId);
      expect(payload.version).toBe("acs.dc.v1");
      expect(payload.issuer).toBe("acs");
      expect(payload.audience).toBe("desktop-commander");
      expect(payload.toolName).toBe("read_file");
      expect(payload.scopes).toEqual(["fs.read"]);
      expect(Date.parse(payload.expiresAt) - Date.parse(payload.issuedAt)).toBe(29_000);
      expect(verifyEnvelopeSignature(payload, body.capability.signature, ctx.keys)).toBe(true);

      // The attempt exists and is RUNNING under the claimed lease.
      const detail = await ctx.app.inject({
        method: "GET",
        url: `/work-items/${body.workItemId}`,
        headers: AUTH
      });
      expect(detail.json().workItem.status).toBe("running");
      const leases = detail.json().attemptLeases;
      expect(leases).toHaveLength(1);
      expect(leases[0].leaseId).toBe(payload.leaseId);
      expect(leases[0].attemptId).toBe(payload.attemptId);

      // Canonical execution evidence: lease-authorized capability_issued event.
      const eventNames = detail.json().events.map((event: { name: string }) => event.name);
      expect(eventNames).toContain("desktop_commander.capability_issued");
      const issuedEvent = detail
        .json()
        .events.find((event: { name: string }) => event.name === "desktop_commander.capability_issued");
      expect(issuedEvent.attributes["attempt.id"]).toBe(payload.attemptId);
      expect(issuedEvent.attributes["lease.id"]).toBe(payload.leaseId);
      expect(issuedEvent.attributes["lease.fencing_epoch"]).toBe(payload.leaseEpoch);

      // Durable issuance binding exists exactly once.
      const db = new DatabaseSync(join(ctx.root, "control.db"));
      const issuances = db
        .prepare("SELECT lease_id, attempt_id, work_item_id FROM desktop_commander_capability_issuances")
        .all();
      expect(issuances).toEqual([
        { lease_id: payload.leaseId, attempt_id: payload.attemptId, work_item_id: body.workItemId }
      ]);
      db.close();
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it("re-issues for a repeated invocation under a FRESH attempt+lease (never reuses a capability)", async () => {
    const ctx = await buildTestGateway();
    try {
      await attestRuntime(ctx);
      const first = await issuePayload(ctx.app, "read_file", { path: join(ctx.root, "a.txt") });
      expect(first.statusCode).toBe(200);
      const replay = await issuePayload(ctx.app, "read_file", { path: join(ctx.root, "a.txt") });
      // A client retry is a NEW governed invocation: a new work item, a new
      // real attempt/lease, a fresh single-use capability. The first
      // capability is never reused and its nonce stays single-use at DC.
      expect(replay.statusCode).toBe(200);
      expect(replay.json().workItemId).not.toBe(first.json().workItemId);
      expect(replay.json().attemptId).not.toBe(first.json().attemptId);
      expect(replay.json().capability.payload.nonce).not.toBe(first.json().capability.payload.nonce);
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it("fails closed for an unattested runtime", async () => {
    const ctx = await buildTestGateway();
    try {
      const response = await issuePayload(ctx.app, "read_file", { path: join(ctx.root, "a.txt") });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ decision: "deny", reason: "issuance_rejected" });
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it("returns 409 require_approval for a write call, binds the approval, and issues after the existing approval flow", async () => {
    const ctx = await buildTestGateway();
    try {
      await attestRuntime(ctx);
      const args = { path: join(ctx.root, "out.txt"), content: "hello" };
      const requested = await issuePayload(ctx.app, "write_file", args);
      expect(requested.statusCode).toBe(409);
      const firstBody = requested.json();
      expect(firstBody.decision).toBe("require_approval");
      expect(firstBody.approvalInstructions).toContain(`POST /work-items/${firstBody.workItemId}/approve`);

      const approval = await ctx.app.inject({
        method: "POST",
        url: `/work-items/${firstBody.workItemId}/approve`,
        headers: AUTH,
        payload: { actionHash: firstBody.actionHash, reason: "operator approved" }
      });
      expect(approval.statusCode).toBe(200);

      const issued = await issuePayload(ctx.app, "write_file", args);
      expect(issued.statusCode).toBe(200);
      const body = issued.json();
      const payload = body.capability.payload;
      expect(payload.toolName).toBe("write_file");
      expect(payload.scopes).toEqual(["fs.write"]);
      expect(typeof payload.approvalId).toBe("string");
      expect(payload.attemptId).toMatch(/^attempt_/);
      expect(payload.leaseId).toMatch(/^lease_/);
      expect(verifyEnvelopeSignature(payload, body.capability.signature, ctx.keys)).toBe(true);

      // Result propagation: the bridge worker submits the canonical result
      // bound to the same attempt/lease/fencing authority.
      const now = new Date().toISOString();
      const result = await ctx.app.inject({
        method: "POST",
        url: `/work-items/${body.workItemId}/results`,
        headers: { authorization: `Bearer ${WORKER_TOKEN}` },
        payload: {
          workItemId: body.workItemId,
          attemptId: body.attemptId,
          leaseId: body.leaseId,
          workerId: body.workerId,
          actionHash: body.claimActionHash,
          planHash: body.planHash,
          inputHash: body.inputHash,
          fencingEpoch: body.leaseEpoch,
          idempotencyKey: attemptResultIdempotencyKey(body.attemptId),
          outcome: "succeeded",
          startedAt: now,
          finishedAt: now,
          summary: "write_file completed under ACS capability",
          simulationMetadata: {
            executionMode: "desktop_commander",
            simulated: false,
            backend: "desktop-commander-mcp",
            toolName: "write_file",
            invocationFingerprint: payload.invocationHash,
            requestId: body.attemptId
          }
        }
      });
      expect(result.statusCode).toBe(201);
      const detail = await ctx.app.inject({
        method: "GET",
        url: `/work-items/${body.workItemId}`,
        headers: AUTH
      });
      expect(detail.json().workItem.status).toBe("succeeded");
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it("denies unknown tools with 403 unknown_tool", async () => {
    const ctx = await buildTestGateway();
    try {
      const response = await issuePayload(ctx.app, "execute_python", { code: "1" });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ decision: "deny", reason: "unknown_tool" });
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });
});
