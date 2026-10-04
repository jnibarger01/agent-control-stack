import { createPrivateKey, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { strictCanonicalJsonV1 } from "@agent-control-stack/shared";
import { ACS_ADMIN_APPROVER, type ManagedAuthorityObservation } from "@agent-control-stack/policy-gate";
import { describe, expect, it, vi } from "vitest";
import { buildGateway, findIncompatibleHumanApprovalCredentials, type GatewayCredential } from "./server.js";

const testAuth = { token: "op-token", actor: "user", actorId: "user" } as const;
const WORKER_TOKEN = "bridge-worker-token";
const APPROVE_ONLY_TOKEN = ["approve", "only", "human", "token"].join("-");
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
    scopes: ["acs:read", "acs:write", "acs:approve", "acs:execution-mode:admin"]
  },
  {
    id: "approve-only-human",
    token: APPROVE_ONLY_TOKEN,
    actor: "user",
    actorId: "approve-only-human",
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

const deniedModeCredentials: GatewayCredential[] = [
  {
    id: "write-only",
    token: "write-only-mode-token",
    actor: "user",
    actorId: "write-only",
    roles: ["operator"],
    scopes: ["acs:read", "acs:write"]
  },
  {
    id: "service-approve",
    token: "service-approve-mode-token",
    actor: "system",
    actorId: "service",
    roles: ["service"],
    scopes: ["acs:read", "acs:write", "acs:approve"]
  },
  {
    id: "agent-operator",
    token: "agent-operator-mode-token",
    actor: "agent",
    actorId: "agent",
    roles: ["operator"],
    scopes: ["acs:read", "acs:write", "acs:approve"]
  },
  {
    id: "mixed-worker",
    token: "mixed-worker-mode-token",
    actor: "user",
    actorId: "mixed-worker",
    roles: ["operator", "worker"],
    scopes: ["acs:read", "acs:write", "acs:approve"]
  },
  {
    id: "mixed-service",
    token: "mixed-service-mode-token",
    actor: "user",
    actorId: "mixed-service",
    roles: ["operator", "service"],
    scopes: ["acs:read", "acs:write", "acs:approve"]
  }
];
credentials.push(...deniedModeCredentials);

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
  authority: ManagedAuthorityObservation | (() => ManagedAuthorityObservation) = healthyAuthority,
  rateLimit?: { windowMs: number; maxRequests: number }
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "acs-admin-mode-")));
  const signing = keys();
  const dbPath = join(root, "control.db");
  const app = buildGateway({
    dbPath,
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
    readManagedAuthority: typeof authority === "function" ? authority : () => authority,
    ...(rateLimit ? { rateLimit } : {})
  });
  return { root, dbPath, signing, app };
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
  it("keeps admin behind its own scope and a stated reason, while strict stays available", async () => {
    const ctx = await gateway();
    try {
      const approveOnly = { authorization: `Bearer ${APPROVE_ONLY_TOKEN}` };
      const noScope = await ctx.app.inject({
        method: "POST",
        url: "/execution-mode",
        headers: approveOnly,
        payload: { mode: "admin", reason: "approve scope alone must not suffice" }
      });
      expect(noScope.statusCode).toBe(403);
      expect(noScope.json()).toMatchObject({ code: "insufficient_gateway_scope" });

      const noReason = await ctx.app.inject({
        method: "POST",
        url: "/execution-mode",
        headers: AUTH,
        payload: { mode: "admin", reason: "short" }
      });
      expect(noReason.statusCode).toBe(400);
      expect(noReason.json()).toMatchObject({ code: "admin_mode_reason_required" });
      const stillStrict = await ctx.app.inject({ method: "GET", url: "/execution-mode", headers: AUTH });
      expect(stillStrict.json()).toMatchObject({ executionMode: "strict" });

      const enabled = await ctx.app.inject({
        method: "POST",
        url: "/execution-mode",
        headers: AUTH,
        payload: { mode: "admin", reason: "scoped maintenance window" }
      });
      expect(enabled.statusCode).toBe(200);
      // Admin mode is sticky by default: there is no implicit expiry timestamp, so it
      // cannot silently revert to strict and reintroduce human approval. The entry
      // safeguards (dedicated scope, stated reason, audit, visible state) still apply.
      expect(enabled.json().expiresAt).toBeNull();
      expect(enabled.json()).toMatchObject({ executionMode: "admin", updatedBy: "user" });

      const back = await ctx.app.inject({
        method: "POST",
        url: "/execution-mode",
        headers: approveOnly,
        payload: { mode: "strict", reason: "done" }
      });
      expect(back.statusCode).toBe(200);
      expect(back.json()).toMatchObject({ executionMode: "strict", expiresAt: null });
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it("requires authentication and attributes mode changes to configured human identity", async () => {
    const ctx = await gateway();
    try {
      const denied = await ctx.app.inject({ method: "POST", url: "/execution-mode", payload: { mode: "admin" } });
      expect(denied.statusCode).toBe(401);
      const spoofed = await ctx.app.inject({
        method: "POST",
        url: "/execution-mode",
        headers: AUTH,
        payload: { mode: "admin", actorId: "forged-actor", reason: "human activation" }
      });
      expect(spoofed.statusCode).toBe(400);
      const approved = await ctx.app.inject({
        method: "POST",
        url: "/execution-mode",
        headers: AUTH,
        payload: { mode: "admin", reason: "human activation" }
      });
      expect(approved.statusCode).toBe(200);
      expect(approved.json()).toMatchObject({ executionMode: "admin", updatedBy: "user" });
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it("diagnoses mixed-role operator credentials at startup instead of failing silently", async () => {
    // Every configured credential that claims operator authority but also carries a
    // service or worker role is named, so operators can migrate before production.
    expect(findIncompatibleHumanApprovalCredentials(credentials).map((credential) => credential.id)).toEqual([
      "mixed-worker",
      "mixed-service"
    ]);
    // A pure human operator and non-operator credentials are never flagged.
    expect(findIncompatibleHumanApprovalCredentials(credentials).map((credential) => credential.id)).not.toContain(
      "human-operator"
    );
    expect(findIncompatibleHumanApprovalCredentials([credentials[0]!])).toEqual([]);
    expect(findIncompatibleHumanApprovalCredentials([])).toEqual([]);
    // Service and worker actors with the operator role are not human at all, so they
    // are governed by request-time checks rather than this human-authority diagnostic.
    expect(findIncompatibleHumanApprovalCredentials([deniedModeCredentials[1]!, deniedModeCredentials[2]!])).toEqual(
      []
    );
  });

  it("still boots and serves requests when incompatible operator credentials are configured", async () => {
    const ctx = await gateway();
    try {
      const ready = await ctx.app.inject({ method: "GET", url: "/readyz" });
      expect(ready.statusCode).toBe(200);
      // And the mixed-role credential remains refused with the documented code.
      const refused = await ctx.app.inject({
        method: "POST",
        url: "/execution-mode",
        headers: { authorization: "Bearer mixed-worker-mode-token" },
        payload: { mode: "admin", reason: "spoofed" }
      });
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toMatchObject({ code: "human_authority_required" });
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it.each([...deniedModeCredentials, credentials.find((credential) => credential.id === "dc-bridge")!])(
    "rejects authority escalation by $id without changing mode",
    async (credential) => {
      const ctx = await gateway();
      try {
        const response = await ctx.app.inject({
          method: "POST",
          url: "/execution-mode",
          headers: { authorization: `Bearer ${credential.token}` },
          payload: { mode: "admin", actor: "user", actorId: "user", reason: "spoofed human authority" }
        });
        expect(response.statusCode).toBe(403);
        const state = await ctx.app.inject({ method: "GET", url: "/execution-mode", headers: AUTH });
        expect(state.json().executionMode).toBe("strict");
      } finally {
        await ctx.app.close();
        rmSync(ctx.root, { recursive: true, force: true });
      }
    }
  );

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
        headers: AUTH,
        payload: { mode: "admin", reason: "rate-limit coverage" }
      });
      expect(mutationFirst.statusCode).toBe(200);
      const mutationSecond = await ctx.app.inject({
        method: "POST",
        url: "/execution-mode",
        headers: AUTH,
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
        headers: AUTH,
        payload: { mode: "admin", reason: "test admin" }
      });
      expect(switched.statusCode).toBe(200);
      expect(switched.json()).toMatchObject({ executionMode: "admin", approvalPolicy: "auto" });

      const correlationId = "corr-admin-start";
      const response = await issue(ctx.app, "create_directory", { path: join(ctx.root, "admin-made") }, correlationId);
      expect(response.statusCode, response.body).toBe(200);
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

  // Authoritative Nimble routing demands persisted routing evidence before any claim, and DC capability items are never
  // routed. Admin mode is the temporary authority override; strict mode keeps routing enforced.
  describe("with authoritative Nimble routing enforced", () => {
    async function withRouting(run: () => Promise<void>): Promise<void> {
      const prior = process.env.ACS_NIMBLE_ROUTING_ENABLED;
      process.env.ACS_NIMBLE_ROUTING_ENABLED = "1";
      try {
        await run();
      } finally {
        if (prior === undefined) delete process.env.ACS_NIMBLE_ROUTING_ENABLED;
        else process.env.ACS_NIMBLE_ROUTING_ENABLED = prior;
      }
    }

    it("admin mode still issues a DC capability and audits the routing override", () =>
      withRouting(async () => {
        const ctx = await gateway();
        try {
          await attest(ctx.app);
          const switched = await ctx.app.inject({
            method: "POST",
            url: "/execution-mode",
            headers: AUTH,
            payload: { mode: "admin", reason: "dc admin routing override test" }
          });
          expect(switched.statusCode).toBe(200);

          const response = await issue(ctx.app, "create_directory", { path: join(ctx.root, "routed-admin") });
          expect(response.statusCode, response.body).toBe(200);
          expect(response.json().decision).toBe("allow");
          expect(response.json().capability.payload.toolName).toBe("create_directory");

          const detail = await ctx.app.inject({
            method: "GET",
            url: `/work-items/${response.json().workItemId}`,
            headers: AUTH
          });
          expect(detail.json().events.map((event: { name: string }) => event.name)).toEqual(
            expect.arrayContaining(["execution_mode.auto_authorized", "execution_mode.routing_override"])
          );
        } finally {
          await ctx.app.close();
          rmSync(ctx.root, { recursive: true, force: true });
        }
      }));

    it("admin issues an approval-free DC read with a routing override and no fabricated approval", () =>
      withRouting(async () => {
        const ctx = await gateway();
        try {
          await attest(ctx.app);
          expect(
            (
              await ctx.app.inject({
                method: "POST",
                url: "/execution-mode",
                headers: AUTH,
                payload: { mode: "admin", reason: "approval-free DC read" }
              })
            ).statusCode
          ).toBe(200);
          const response = await issue(ctx.app, "get_config", {});
          expect(response.statusCode, response.body).toBe(200);
          expect(response.json().capability.payload.toolName).toBe("get_config");
          expect(response.json().capability.payload.approvalId).toBeUndefined();
          const detail = await ctx.app.inject({
            method: "GET",
            url: `/work-items/${response.json().workItemId}`,
            headers: AUTH
          });
          const events = detail.json().events.map((event: { name: string }) => event.name);
          expect(events.filter((name: string) => name === "execution_mode.routing_override")).toHaveLength(1);
          expect(events).not.toContain("approval.granted");
        } finally {
          await ctx.app.close();
          rmSync(ctx.root, { recursive: true, force: true });
        }
      }));

    it("strict mode refuses an unrouted approval-free DC read", () =>
      withRouting(async () => {
        const ctx = await gateway();
        try {
          await attest(ctx.app);
          const response = await issue(ctx.app, "get_config", {});
          expect(response.statusCode).toBe(409);
          expect(response.json().capability).toBeUndefined();
        } finally {
          await ctx.app.close();
          rmSync(ctx.root, { recursive: true, force: true });
        }
      }));

    it("rechecks managed authority inside the approval-free DC claim transaction", () =>
      withRouting(async () => {
        let calls = 0;
        const ctx = await gateway(() =>
          ++calls < 3
            ? healthyAuthority
            : {
                ...healthyAuthority,
                leaseAmbiguous: true,
                detail: "authority changed at claim"
              }
        );
        try {
          await attest(ctx.app);
          expect(
            (
              await ctx.app.inject({
                method: "POST",
                url: "/execution-mode",
                headers: AUTH,
                payload: { mode: "admin", reason: "DC claim authority race" }
              })
            ).statusCode
          ).toBe(200);
          calls = 0;
          const response = await issue(ctx.app, "get_config", {});
          expect(calls).toBe(3);
          expect(response.statusCode, response.body).toBe(409);
          expect(response.json().code).toBe("executor_ambiguous");
          expect(response.json().capability).toBeUndefined();
        } finally {
          await ctx.app.close();
          rmSync(ctx.root, { recursive: true, force: true });
        }
      }));

    it("retries expired admin approvals with durable claim-denial audit", () =>
      withRouting(async () => {
        let failClaimAuthority = false;
        let authorityReads = 0;
        const ctx = await gateway(() => {
          if (failClaimAuthority && ++authorityReads === 3)
            return { ...healthyAuthority, leaseAmbiguous: true, detail: "authority expired at claim" };
          return healthyAuthority;
        });
        try {
          await attest(ctx.app);
          const mode = await ctx.app.inject({
            method: "POST",
            url: "/execution-mode",
            headers: AUTH,
            payload: { mode: "admin", reason: "admin approval expiry regression" }
          });
          expect(mode.statusCode).toBe(200);
          const args = { path: join(ctx.root, "expired-admin-approval") };
          failClaimAuthority = true;
          authorityReads = 0;
          const interrupted = await issue(ctx.app, "create_directory", args);
          expect(authorityReads).toBe(3);
          expect(interrupted.statusCode, interrupted.body).toBe(409);
          expect(interrupted.json().code).toBe("executor_ambiguous");
          const lookup = new DatabaseSync(ctx.dbPath, { readOnly: true });
          let staleId: string;
          try {
            const rows = lookup
              .prepare("SELECT id FROM work_items WHERE title = ? ORDER BY created_at DESC LIMIT 1")
              .all("Desktop Commander capability: create_directory") as Array<{ id: string }>;
            expect(rows).toHaveLength(1);
            staleId = rows[0]!.id;
          } finally {
            lookup.close();
          }
          const detail = await ctx.app.inject({ method: "GET", url: `/work-items/${staleId}`, headers: AUTH });
          expect(detail.json().events.map((event: { name: string }) => event.name)).toContain(
            "execution_mode.admin_approval_claim_denied"
          );
          const approvals = new DatabaseSync(ctx.dbPath, { readOnly: true });
          let expiresAt: string;
          try {
            const rows = approvals
              .prepare("SELECT expires_at FROM execution_plan_approvals WHERE work_item_id = ? AND status = 'granted'")
              .all(staleId) as Array<{ expires_at: string }>;
            expect(rows.length).toBeGreaterThan(0);
            expiresAt = rows[0]!.expires_at;
          } finally {
            approvals.close();
          }
          vi.useFakeTimers({ toFake: ["Date"] });
          vi.setSystemTime(new Date(Date.parse(expiresAt) + 1));
          failClaimAuthority = false;
          const recovered = await issue(ctx.app, "create_directory", args);
          expect(recovered.statusCode, recovered.body).toBe(200);
          expect(recovered.json().workItemId).not.toBe(staleId);
          expect(recovered.json().capability.payload.workItemId).not.toBe(staleId);
        } finally {
          vi.useRealTimers();
          await ctx.app.close();
          rmSync(ctx.root, { recursive: true, force: true });
        }
      }));

    it("preserves a human-approved DC item and authorizes a new admin item", () =>
      withRouting(async () => {
        const ctx = await gateway();
        try {
          await attest(ctx.app);
          const args = { path: join(ctx.root, "human-then-admin") };
          const blocked = await issue(ctx.app, "create_directory", args);
          expect(blocked.statusCode).toBe(409);
          const id = blocked.json().workItemId;
          const approved = await ctx.app.inject({
            method: "POST",
            url: `/work-items/${id}/approve`,
            headers: AUTH,
            payload: { actionHash: blocked.json().actionHash, reason: "human approved first" }
          });
          expect(approved.statusCode, approved.body).toBe(200);
          const mode = await ctx.app.inject({
            method: "POST",
            url: "/execution-mode",
            headers: AUTH,
            payload: { mode: "admin", reason: "admin after human approval" }
          });
          expect(mode.statusCode).toBe(200);
          const response = await issue(ctx.app, "create_directory", args);
          expect(response.statusCode, response.body).toBe(200);
          expect(response.json().capability.payload.workItemId).not.toBe(id);
          const detail = await ctx.app.inject({
            method: "GET",
            url: `/work-items/${response.json().capability.payload.workItemId}`,
            headers: AUTH
          });
          expect(detail.json().events.map((event: { name: string }) => event.name)).toContain(
            "execution_mode.routing_override"
          );
        } finally {
          await ctx.app.close();
          rmSync(ctx.root, { recursive: true, force: true });
        }
      }));

    it("strict mode keeps routing enforced: a human-approved DC item is not claimed and nothing is signed", () =>
      withRouting(async () => {
        const ctx = await gateway();
        try {
          await attest(ctx.app);
          const args = { path: join(ctx.root, "routed-strict") };
          const first = await issue(ctx.app, "create_directory", args);
          expect(first.statusCode).toBe(409);
          const approval = await ctx.app.inject({
            method: "POST",
            url: `/work-items/${first.json().workItemId}/approve`,
            headers: AUTH,
            payload: { actionHash: first.json().actionHash, reason: "operator approved" }
          });
          expect(approval.statusCode).toBe(200);
          const retry = await issue(ctx.app, "create_directory", args);
          expect(retry.statusCode).toBe(409);
          expect(retry.json().capability).toBeUndefined();
          const detail = await ctx.app.inject({
            method: "GET",
            url: `/work-items/${first.json().workItemId}`,
            headers: AUTH
          });
          expect(detail.json().events.map((event: { name: string }) => event.name)).not.toContain(
            "execution_mode.routing_override"
          );
        } finally {
          await ctx.app.close();
          rmSync(ctx.root, { recursive: true, force: true });
        }
      }));
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
      expect(moved.statusCode, moved.body).toBe(200);
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
