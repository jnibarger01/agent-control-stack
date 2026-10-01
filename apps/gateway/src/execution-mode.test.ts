import { createPrivateKey, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strictCanonicalJsonV1 } from "@agent-control-stack/shared";
import { ACS_ADMIN_APPROVER, type ManagedAuthorityObservation } from "@agent-control-stack/policy-gate";
import { describe, expect, it } from "vitest";
import { buildGateway, type GatewayCredential } from "./server.js";

const testAuth = { token: "op-token", actor: "user", actorId: "user" } as const;
const LEGACY_TOKEN = "legacy-gateway-token";
const MODE_ADMIN_TOKEN = "mode-admin-token";
const WORKER_TOKEN = "bridge-worker-token";
const AUTH = { authorization: "Bearer " + testAuth.token };
const LEGACY_AUTH = { authorization: `Bearer ${LEGACY_TOKEN}` };
const MODE_ADMIN_AUTH = { authorization: `Bearer ${MODE_ADMIN_TOKEN}` };
const WRITE_ONLY_OPERATOR_AUTH = { authorization: "Bearer write-only-operator-token" };
const WRITE_ONLY_SERVICE_AUTH = { authorization: "Bearer write-only-service-token" };
const AGENT_MODE_ADMIN_AUTH = { authorization: "Bearer agent-mode-admin-token" };
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
    id: "mode-admin",
    token: MODE_ADMIN_TOKEN,
    actor: "operator",
    actorId: "mode-admin",
    roles: ["operator"],
    scopes: ["acs:read", "acs:write", "acs:execution-mode:admin"]
  },
  {
    id: "write-only-operator",
    token: "write-only-operator-token",
    actor: "user",
    actorId: "write-only-operator",
    roles: ["operator"],
    scopes: ["acs:read", "acs:write"]
  },
  {
    id: "write-only-service",
    token: "write-only-service-token",
    actor: "system",
    actorId: "write-only-service",
    roles: ["service"],
    scopes: ["acs:read", "acs:write"]
  },
  {
    id: "agent-mode-admin",
    token: "agent-mode-admin-token",
    actor: "agent",
    actorId: "agent-mode-admin",
    roles: ["operator"],
    scopes: ["acs:read", "acs:write", "acs:execution-mode:admin"]
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

async function gateway(
  authority: ManagedAuthorityObservation = healthyAuthority,
  rateLimit?: { windowMs: number; maxRequests: number },
  root = realpathSync(mkdtempSync(join(tmpdir(), "acs-admin-mode-")))
) {
  const signing = keys();
  const app = buildGateway({
    dbPath: join(root, "control.db"),
    logger: false,
    auth: { token: LEGACY_TOKEN, actor: "user", actorId: testAuth.actorId, credentials },
    desktopCommanderCapability: {
      runtimeId: RUNTIME_ID,
      keyId: "test-capability-key",
      privateKey: signing.privateKey,
      ttlMs: 29_000,
      identityConfigFingerprint: IDENTITY_FINGERPRINT,
      runtimeScopes: RUNTIME_SCOPES
    },
    desktopCommanderContainment: { allowedRoots: [root], deniedRoots: [] },
    readManagedAuthority: () => authority,
    ...(rateLimit ? { rateLimit } : {})
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

  it("requires the dedicated human mode-admin scope to increase authority and preserves strict approval", async () => {
    const ctx = await gateway();
    try {
      for (const [headers, expectedCode] of [
        [WRITE_ONLY_OPERATOR_AUTH, "insufficient_gateway_scope"],
        [AUTH, "insufficient_gateway_scope"],
        [LEGACY_AUTH, "insufficient_gateway_scope"],
        [WRITE_ONLY_SERVICE_AUTH, "execution_mode_admin_required"]
      ] as const) {
        const ordinaryMutation = await ctx.app.inject({
          method: "POST",
          url: "/work-items",
          headers,
          payload: { title: "ordinary mutation", intent: "exercise ordinary write authority", target: {}, risk: "low" }
        });
        expect(ordinaryMutation.statusCode).toBe(201);

        const escalation = await ctx.app.inject({
          method: "POST",
          url: "/execution-mode",
          headers,
          payload: { mode: "admin", reason: "attempted global self-escalation" }
        });
        expect(escalation.statusCode).toBe(403);
        expect(escalation.json().code).toBe(expectedCode);
      }

      const agentEscalation = await ctx.app.inject({
        method: "POST",
        url: "/execution-mode",
        headers: AGENT_MODE_ADMIN_AUTH,
        payload: { mode: "admin", reason: "agent identity cannot administer global mode" }
      });
      expect(agentEscalation.statusCode).toBe(403);
      expect(agentEscalation.json().code).toBe("execution_mode_admin_required");
      const unsupported = await ctx.app.inject({
        method: "POST",
        url: "/execution-mode",
        headers: AUTH,
        payload: { mode: "full_auto", reason: "unsupported future mode" }
      });
      expect(unsupported.statusCode).toBe(400);
      const staleRevision = await ctx.app.inject({
        method: "POST",
        url: "/execution-mode",
        headers: AUTH,
        payload: { mode: "admin", expectedRevision: 999 }
      });
      expect(staleRevision.statusCode).toBe(400);

      const unauthenticated = await ctx.app.inject({
        method: "POST",
        url: "/execution-mode",
        payload: { mode: "admin", reason: "missing principal" }
      });
      expect(unauthenticated.statusCode).toBe(401);

      const mode = await ctx.app.inject({ method: "GET", url: "/execution-mode", headers: AUTH });
      expect(mode.json()).toMatchObject({ executionMode: "strict", approvalPolicy: "policy" });
      const held = await issue(ctx.app, "create_directory", { path: join(ctx.root, "still-needs-approval") });
      expect(held.statusCode).toBe(409);
      expect(held.json().decision).toBe("require_approval");
      expect(held.json().capability).toBeUndefined();

      const detail = await ctx.app.inject({
        method: "GET",
        url: `/work-items/${held.json().workItemId}`,
        headers: AUTH
      });
      const eventNames = detail.json().events.map((event: { name: string }) => event.name);
      expect(eventNames).not.toContain("approval.granted");
      expect(eventNames).not.toContain("execution_mode.auto_authorized");
      expect(JSON.stringify(detail.json().events)).not.toContain(ACS_ADMIN_APPROVER);
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it("allows an explicitly authorized administrator to elevate and ordinary writers to downgrade", async () => {
    const ctx = await gateway();
    try {
      const elevated = await ctx.app.inject({
        method: "POST",
        url: "/execution-mode",
        headers: MODE_ADMIN_AUTH,
        payload: { mode: "admin", reason: "authorized global policy change" }
      });
      expect(elevated.statusCode).toBe(200);
      expect(elevated.json()).toMatchObject({ executionMode: "admin", approvalPolicy: "auto" });

      const downgraded = await ctx.app.inject({
        method: "POST",
        url: "/execution-mode",
        headers: WRITE_ONLY_OPERATOR_AUTH,
        payload: { mode: "strict", reason: "incident response downgrade" }
      });
      expect(downgraded.statusCode).toBe(200);
      expect(downgraded.json()).toMatchObject({ executionMode: "strict", approvalPolicy: "policy" });
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it("does not persist a denied escalation across gateway restart", async () => {
    const ctx = await gateway();
    let activeApp = ctx.app;
    try {
      const before = await activeApp.inject({ method: "GET", url: "/execution-mode", headers: AUTH });
      const denied = await activeApp.inject({
        method: "POST",
        url: "/execution-mode",
        headers: AUTH,
        payload: { mode: "admin", reason: "replay after restart check" }
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().code).toBe("insufficient_gateway_scope");
      const replayed = await activeApp.inject({
        method: "POST",
        url: "/execution-mode",
        headers: AUTH,
        payload: { mode: "admin", reason: "replayed escalation" }
      });
      expect(replayed.statusCode).toBe(403);

      const after = await activeApp.inject({ method: "GET", url: "/execution-mode", headers: AUTH });
      expect(after.json()).toMatchObject({
        executionMode: "strict",
        approvalPolicy: "policy",
        updatedAt: before.json().updatedAt,
        updatedBy: before.json().updatedBy
      });

      await activeApp.close();
      const restarted = await gateway(healthyAuthority, undefined, ctx.root);
      activeApp = restarted.app;
      const restored = await activeApp.inject({ method: "GET", url: "/execution-mode", headers: AUTH });
      expect(restored.json()).toMatchObject({
        executionMode: "strict",
        approvalPolicy: "policy",
        updatedAt: before.json().updatedAt,
        updatedBy: before.json().updatedBy
      });
    } finally {
      await activeApp.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it("rate-limits execution-mode and authority endpoints", async () => {
    const ctx = await gateway(healthyAuthority, { windowMs: 60_000, maxRequests: 1 });
    try {
      const authorityFirst = await ctx.app.inject({ method: "GET", url: "/authority", headers: AUTH });
      expect(authorityFirst.statusCode).toBe(200);
      expect(authorityFirst.headers["x-ratelimit-remaining"]).toBe("0");
      const authoritySecond = await ctx.app.inject({ method: "GET", url: "/authority", headers: AUTH });
      expect(authoritySecond.statusCode).toBe(429);

      const modeFirst = await ctx.app.inject({ method: "GET", url: "/execution-mode", headers: AUTH });
      expect(modeFirst.statusCode).toBe(200);
      const modeSecond = await ctx.app.inject({ method: "GET", url: "/execution-mode", headers: AUTH });
      expect(modeSecond.statusCode).toBe(429);

      const mutationFirst = await ctx.app.inject({
        method: "POST",
        url: "/execution-mode",
        headers: MODE_ADMIN_AUTH,
        payload: { mode: "admin", reason: "rate-limit coverage" }
      });
      expect(mutationFirst.statusCode).toBe(200);
      const mutationSecond = await ctx.app.inject({
        method: "POST",
        url: "/execution-mode",
        headers: MODE_ADMIN_AUTH,
        payload: { mode: "strict", reason: "rate-limit coverage" }
      });
      expect(mutationSecond.statusCode).toBe(429);
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
        headers: MODE_ADMIN_AUTH,
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
        headers: MODE_ADMIN_AUTH,
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
        headers: MODE_ADMIN_AUTH,
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
