import { createPrivateKey, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strictCanonicalJsonV1 } from "@agent-control-stack/shared";
import { ACS_ADMIN_APPROVER, type ManagedAuthorityObservation } from "@agent-control-stack/policy-gate";
import { describe, expect, it } from "vitest";
import { buildGateway, type GatewayCredential } from "./server.js";

const testAuth = { token: "op-token", actor: "user", actorId: "user" } as const;
const WORKER_TOKEN = "bridge-worker-token";
const AUTH = { authorization: "Bearer " + testAuth.token };
const BRIDGE_AUTH = { authorization: "Bearer " + WORKER_TOKEN };
const RUNTIME_ID = "dc-test-runtime";
const IDENTITY_FINGERPRINT = "b".repeat(64);
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

const healthyAuthority: ManagedAuthorityObservation = {
  authorityOwner: "managed:pid:42",
  authoritative: true,
  leaseActive: true,
  leaseAmbiguous: false,
  breakGlassActive: false,
  breakGlassAmbiguous: false,
  multipleAuthoritativeExecutors: false,
  managedRuntime: true,
  detail: "executor lease held by pid 42"
};

function keys() {
  const pair = generateKeyPairSync("ed25519");
  return {
    privateKey: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"),
    publicKeyPem: pair.publicKey.export({ type: "spki", format: "pem" }).toString()
  };
}

async function gateway(authority: ManagedAuthorityObservation = healthyAuthority) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "acs-admin-mode-")));
  const signing = keys();
  const app = buildGateway({
    dbPath: join(root, "control.db"),
    logger: false,
    auth: { token: "", actor: "user", actorId: testAuth.actorId, credentials },
    desktopCommanderCapability: {
      runtimeId: RUNTIME_ID,
      keyId: "test-capability-key",
      privateKey: signing.privateKey,
      ttlMs: 29_000,
      identityConfigFingerprint: IDENTITY_FINGERPRINT,
      runtimeScopes: RUNTIME_SCOPES
    },
    desktopCommanderContainment: { allowedRoots: [root], deniedRoots: [] },
    readManagedAuthority: () => authority
  });
  return { root, signing, app };
}

async function attest(app: Awaited<ReturnType<typeof gateway>>["app"]) {
  const bootstrap = await app.inject({
    method: "POST",
    url: "/dc/runtime/bootstrap",
    headers: BRIDGE_AUTH,
    payload: { runtimeId: RUNTIME_ID, identityConfigFingerprint: IDENTITY_FINGERPRINT, scopes: RUNTIME_SCOPES }
  });
  expect(bootstrap.statusCode).toBe(201);
  const { challenge } = bootstrap.json();
  const completed = await app.inject({
    method: "POST",
    url: "/dc/runtime/bootstrap/complete",
    headers: BRIDGE_AUTH,
    payload: {
      runtimeId: RUNTIME_ID,
      identityConfigFingerprint: IDENTITY_FINGERPRINT,
      scopes: RUNTIME_SCOPES,
      challenge,
      runtimeIdentity: {
        schemaVersion: 1,
        runtimeId: RUNTIME_ID,
        challenge,
        scopes: RUNTIME_SCOPES
      }
    }
  });
  expect(completed.statusCode).toBe(204);
}

function issue(
  app: Awaited<ReturnType<typeof gateway>>["app"],
  tool: string,
  args: Record<string, unknown>,
  correlationId?: string
) {
  return app.inject({
    method: "POST",
    url: "/dc/capability/issue",
    headers: { ...BRIDGE_AUTH, "x-dc-actor": "chatgpt:jacen" },
    payload: {
      client_id: "chatgpt-desktop",
      tool,
      argsSummary: JSON.stringify(args),
      ...(correlationId ? { correlationId } : {})
    }
  });
}

describe("canonical execution mode", () => {
  it("defaults to strict and reports the same mode on the authority endpoint", async () => {
    const ctx = await gateway();
    try {
      const authority = await ctx.app.inject({ method: "GET", url: "/authority", headers: AUTH });
      expect(authority.statusCode).toBe(200);
      expect(authority.json()).toMatchObject({
        executionMode: "strict",
        approvalPolicy: "policy",
        authoritative: true,
        executor: { lease: { active: true, ambiguous: false } },
        breakGlass: { active: false }
      });
      const page = await ctx.app.inject({ method: "GET", url: "/", headers: AUTH });
      expect(page.body).toContain("Execution Mode");
      expect(page.body).toContain("Admin / YOLO");
      // Strict: the admin banner is rendered hidden and empty (the live
      // dashboard toggles it in place instead of hard-reloading).
      expect(page.body).toMatch(/<div id="admin-mode-banner" class="admin-mode-banner" role="alert" hidden><\/div>/u);
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it("keeps approval-required execution behind require_approval in strict mode", async () => {
    const ctx = await gateway();
    try {
      await attest(ctx.app);
      const response = await issue(ctx.app, "create_directory", { path: join(ctx.root, "strict-hold") });
      expect(response.statusCode).toBe(409);
      expect(response.json().decision).toBe("require_approval");
      expect(response.json().capability).toBeUndefined();
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it("auto-authorizes, still issues a capability, then restores strict approval", async () => {
    const ctx = await gateway();
    try {
      await attest(ctx.app);
      const switched = await ctx.app.inject({
        method: "POST",
        url: "/execution-mode",
        headers: AUTH,
        payload: { mode: "admin", reason: "test admin" }
      });
      expect(switched.statusCode).toBe(200);
      expect(switched.json()).toMatchObject({ executionMode: "admin", approvalPolicy: "auto" });

      const correlationId = "corr-admin-start";
      const response = await issue(ctx.app, "create_directory", { path: join(ctx.root, "admin-made") }, correlationId);
      expect(response.statusCode).toBe(200);
      expect(response.json().decision).toBe("allow");
      expect(response.json().decision).not.toBe("require_approval");
      expect(response.json().capability.payload.toolName).toBe("create_directory");
      expect(response.json().capability.signature.length).toBeGreaterThan(10);
      const publicKey = createPublicKey(
        createPrivateKey({ key: Buffer.from(ctx.signing.privateKey, "base64url"), format: "der", type: "pkcs8" })
      );
      expect(
        verify(
          null,
          Buffer.from(strictCanonicalJsonV1(response.json().capability.payload), "utf8"),
          publicKey,
          Buffer.from(response.json().capability.signature, "base64url")
        )
      ).toBe(true);

      const detail = await ctx.app.inject({
        method: "GET",
        url: `/work-items/${response.json().workItemId}`,
        headers: AUTH
      });
      expect(detail.json().workItem.metadata.correlationId).toBe(correlationId);
      expect(detail.json().events.map((event: { name: string }) => event.name)).toEqual(
        expect.arrayContaining([
          "approval.granted",
          "execution_mode.auto_authorized",
          "desktop_commander.capability_issued"
        ])
      );
      expect(JSON.stringify(detail.json().events)).toContain(ACS_ADMIN_APPROVER);

      const restored = await ctx.app.inject({
        method: "POST",
        url: "/execution-mode",
        headers: AUTH,
        payload: { mode: "strict", reason: "test restore" }
      });
      expect(restored.json().executionMode).toBe("strict");
      const again = await issue(ctx.app, "create_directory", { path: join(ctx.root, "admin-made") });
      expect(again.statusCode).toBe(409);
      expect(again.json().decision).toBe("require_approval");
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it("auto-authorizes an approval-required move in admin, denies invalid leases, and rejects unauthenticated issue", async () => {
    const ctx = await gateway();
    try {
      await attest(ctx.app);
      await ctx.app.inject({
        method: "POST",
        url: "/execution-mode",
        headers: AUTH,
        payload: { mode: "admin", reason: "negative" }
      });
      // main classifies move_file as requires_approval (not destructive): in
      // admin mode ACS auto-authorizes exactly this human-approval class.
      const moved = await issue(ctx.app, "move_file", {
        source: join(ctx.root, "a.txt"),
        destination: join(ctx.root, "b.txt")
      });
      expect(moved.statusCode).toBe(200);
      expect(moved.json().decision).toBe("allow");
      expect(moved.json().capability).toBeDefined();

      const unauthenticated = await ctx.app.inject({
        method: "POST",
        url: "/dc/capability/issue",
        headers: { "x-dc-actor": "chatgpt:jacen" },
        payload: {
          client_id: "chatgpt-desktop",
          tool: "read_file",
          argsSummary: JSON.stringify({ path: join(ctx.root, "n.txt") })
        }
      });
      expect(unauthenticated.statusCode).toBe(401);
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }

    const bad = await gateway({
      ...healthyAuthority,
      authoritative: false,
      leaseActive: false,
      managedRuntime: false,
      detail: "executor lease is absent"
    });
    try {
      await attest(bad.app);
      await bad.app.inject({
        method: "POST",
        url: "/execution-mode",
        headers: AUTH,
        payload: { mode: "admin", reason: "bad lease" }
      });
      const response = await issue(bad.app, "read_file", { path: join(bad.root, "n.txt") });
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe("executor_lease_invalid");
      expect(response.json().capability).toBeUndefined();
    } finally {
      await bad.app.close();
      rmSync(bad.root, { recursive: true, force: true });
    }
  });
});
