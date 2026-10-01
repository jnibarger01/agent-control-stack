import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteJaceCommanderIssuanceRegistry } from "@agent-control-stack/desktop-commander-adapter";
import { strictCanonicalJsonV1 } from "@agent-control-stack/shared";
import { describe, expect, it } from "vitest";
import { buildGateway, type GatewayCredential } from "./server.js";

const OP_TOKEN = "op-token";
const JC_BRIDGE_TOKEN = "jc-bridge-token";
const DC_BRIDGE_TOKEN = "dc-bridge-token";
const SELF_TOKEN = "self-token";
const JC_ACTOR = "chatgpt:jacen";
const RUNTIME_ID = "jc-test-runtime";
const KEY_ID = "acs-jc-test-1";

const credentials: GatewayCredential[] = [
  {
    id: "op",
    token: OP_TOKEN,
    actor: "user",
    actorId: "user",
    roles: ["operator"],
    scopes: ["acs:read", "acs:write", "acs:approve"]
  },
  {
    id: "self",
    token: SELF_TOKEN,
    actor: "user",
    actorId: JC_ACTOR,
    roles: ["operator"],
    scopes: ["acs:read", "acs:write", "acs:approve"]
  },
  {
    id: "jc-bridge",
    token: JC_BRIDGE_TOKEN,
    actor: "agent",
    actorId: "acs-jc-bridge",
    roles: ["service", "worker"],
    scopes: ["acs:read", "acs:write", "acs:worker"]
  },
  {
    id: "dc-bridge",
    token: DC_BRIDGE_TOKEN,
    actor: "agent",
    actorId: "acs-dc-bridge",
    roles: ["service", "worker"],
    scopes: ["acs:read", "acs:write", "acs:worker"]
  }
];

const OP = { authorization: `Bearer ${OP_TOKEN}` };
const JC_BRIDGE = { authorization: `Bearer ${JC_BRIDGE_TOKEN}` };

interface Ctx {
  root: string;
  dbPath: string;
  privateKey: string;
  app: ReturnType<typeof buildGateway>;
}

function build(jaceCommanderCapability: boolean = true): Ctx {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "acs-jc-capability-")));
  const { privateKey } = generateKeyPairSync("ed25519");
  const privateKeyB64 = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url");
  const dbPath = join(root, "control.db");
  const app = buildGateway({
    dbPath,
    logger: false,
    auth: { token: "", actor: "user", actorId: "user", credentials },
    jaceCommanderCapability: jaceCommanderCapability
      ? { runtimeId: RUNTIME_ID, keyId: KEY_ID, privateKey: privateKeyB64, ttlMs: 29_000 }
      : false
  });
  return { root, dbPath, privateKey: privateKeyB64, app };
}

async function withCtx(fn: (ctx: Ctx) => Promise<void>, enabled = true): Promise<void> {
  const ctx = build(enabled);
  try {
    await fn(ctx);
  } finally {
    await ctx.app.close();
    rmSync(ctx.root, { recursive: true, force: true });
  }
}

function issue(
  ctx: Ctx,
  tool: string,
  args: Record<string, unknown>,
  headers: Record<string, string> = JC_BRIDGE,
  actor = JC_ACTOR
) {
  return ctx.app.inject({
    method: "POST",
    url: "/jc/capability/issue",
    headers: { ...headers, "x-jc-actor": actor },
    payload: { client_id: "chatgpt", tool, argsSummary: JSON.stringify(args) }
  });
}

function approve(ctx: Ctx, workItemId: string, actionHash: string, headers: Record<string, string> = OP) {
  return ctx.app.inject({
    method: "POST",
    url: `/work-items/${workItemId}/approve`,
    headers,
    payload: { actionHash, reason: "human approved exact argv" }
  });
}

function verifySignature(ctx: Ctx, capability: { payload: unknown; signature: string }): boolean {
  const publicKey = createPublicKey(
    createPrivateKey({ key: Buffer.from(ctx.privateKey, "base64url"), format: "der", type: "pkcs8" })
  );
  return verify(
    null,
    Buffer.from(strictCanonicalJsonV1(capability.payload), "utf8"),
    publicKey,
    Buffer.from(capability.signature, "base64url")
  );
}

function jcInvocationHash(toolName: string, args: Record<string, unknown>): string {
  return createHash("sha256")
    .update(`acs:jace-commander-invocation:v1\n${strictCanonicalJsonV1({ toolName, arguments: args })}`, "utf8")
    .digest("hex");
}

const PRIV_ARGS = { argv: ["/usr/bin/apt-get", "update"], timeoutMs: 120_000 };

async function approvedPrivilegedCapability(ctx: Ctx, args: Record<string, unknown> = PRIV_ARGS) {
  const first = await issue(ctx, "privileged_exec", args);
  expect(first.statusCode).toBe(409);
  const pending = first.json();
  expect(pending.decision).toBe("require_approval");
  const approved = await approve(ctx, pending.workItemId, pending.actionHash);
  expect(approved.statusCode).toBe(200);
  const second = await issue(ctx, "privileged_exec", args);
  expect(second.statusCode).toBe(200);
  return { pending, body: second.json() };
}

describe("POST /jc/capability/issue", () => {
  it("rejects unauthenticated callers and non-JC bridge identities", async () => {
    await withCtx(async (ctx) => {
      const anonymous = await ctx.app.inject({
        method: "POST",
        url: "/jc/capability/issue",
        headers: { "x-jc-actor": JC_ACTOR },
        payload: { client_id: "c", tool: "jc_status", argsSummary: "{}" }
      });
      expect(anonymous.statusCode).toBe(401);
      const dcBridge = await issue(ctx, "jc_status", {}, { authorization: `Bearer ${DC_BRIDGE_TOKEN}` });
      expect(dcBridge.statusCode).toBe(403);
      expect(dcBridge.json()).toMatchObject({ code: "jc_bridge_identity_required" });
      const operator = await issue(ctx, "jc_status", {}, OP);
      expect(operator.statusCode).toBe(403);
    });
  });

  it("fails closed with 503 when acs.jc.v1 signing is not configured", async () => {
    await withCtx(async (ctx) => {
      const response = await issue(ctx, "jc_status", {});
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ code: "capability_issuance_unconfigured" });
    }, false);
  });

  it("issues a lease-bound read capability without approval", async () => {
    await withCtx(async (ctx) => {
      const args = { view: "health" };
      const response = await issue(ctx, "acs_read", args);
      expect(response.statusCode).toBe(200);
      const { capability, workItemId } = response.json();
      const payload = capability.payload;
      expect(Object.keys(payload).sort()).toEqual(
        [
          "actionHash",
          "attemptId",
          "audience",
          "expiresAt",
          "invocationHash",
          "issuedAt",
          "issuer",
          "leaseEpoch",
          "leaseId",
          "nonce",
          "normalizedArguments",
          "planHash",
          "requestHash",
          "runtimeId",
          "scopes",
          "toolName",
          "version",
          "workItemId"
        ].sort()
      );
      expect(payload).toMatchObject({
        version: "acs.jc.v1",
        issuer: "acs",
        audience: "jace-commander",
        runtimeId: RUNTIME_ID,
        toolName: "acs_read",
        normalizedArguments: args,
        scopes: ["integration.read"],
        workItemId
      });
      expect(payload.invocationHash).toBe(jcInvocationHash("acs_read", args));
      expect(payload.attemptId).toMatch(/^attempt_/u);
      expect(payload.leaseId).toMatch(/^lease_/u);
      expect(payload.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(Date.parse(payload.expiresAt) - Date.parse(payload.issuedAt)).toBe(29_000);
      expect(capability.keyId).toBe(KEY_ID);
      expect(verifySignature(ctx, capability)).toBe(true);
    });
  });

  it("maps every acs.jc.v1 tool to its contract scope", async () => {
    await withCtx(async (ctx) => {
      const cases: Array<[string, Record<string, unknown>, string]> = [
        ["jc_status", {}, "integration.read"],
        ["swarm_read", { view: "runs" }, "integration.read"],
        ["visualizer_read", { view: "agents" }, "integration.read"],
        ["mission_router_list", {}, "fs.read"],
        ["looptrace_verify", { path: "/home/jacen/.looptrace/a.jsonl" }, "fs.read"],
        ["acs_submit_mission", { title: "t", intent: "i", target: {} }, "integration.write"]
      ];
      for (const [tool, args, scope] of cases) {
        const response = await issue(ctx, tool, args);
        expect(response.statusCode, tool).toBe(200);
        expect(response.json().capability.payload.scopes).toEqual([scope]);
        expect(response.json().capability.payload).not.toHaveProperty("approvalId");
      }
    });
  });

  it("rejects unknown tools and invalid arguments before creating any work item", async () => {
    await withCtx(async (ctx) => {
      expect((await issue(ctx, "run_command", { command: "id" })).statusCode).toBe(403);
      for (const args of [
        { argv: ["apt-get", "update"] },
        { argv: ["/usr/bin/../bin/apt-get"] },
        { argv: [] },
        { argv: ["/usr/bin/id"], env: { LD_PRELOAD: "x" } },
        { argv: ["/usr/bin/id"], cwd: "relative" },
        { argv: ["/usr/bin/id"], timeoutMs: 600_001 },
        { argv: ["/usr/bin/id"], stdin: "x".repeat(64 * 1024 + 1) }
      ]) {
        const response = await issue(ctx, "privileged_exec", args);
        expect(response.statusCode, JSON.stringify(args).slice(0, 80)).toBe(400);
        expect(response.json()).toMatchObject({ code: "jace_commander_argument_invalid" });
      }
      expect((await issue(ctx, "acs_read", { view: "secrets" })).statusCode).toBe(400);
      const list = await ctx.app.inject({ method: "GET", url: "/work-items", headers: OP });
      expect(list.json().workItems ?? list.json()).toHaveLength(0);
    });
  });

  it("requires approval for privileged_exec, then issues with the consumed approvalId bound to the exact argv", async () => {
    await withCtx(async (ctx) => {
      const { pending, body } = await approvedPrivilegedCapability(ctx);
      expect(pending.approvalDetail).toEqual({ tool: "privileged_exec", argv: PRIV_ARGS.argv, timeoutMs: 120_000 });
      const payload = body.capability.payload;
      expect(body.workItemId).toBe(pending.workItemId);
      expect(payload.toolName).toBe("privileged_exec");
      expect(payload.scopes).toEqual(["process.privileged"]);
      expect(payload.normalizedArguments).toEqual(PRIV_ARGS);
      expect(payload.invocationHash).toBe(jcInvocationHash("privileged_exec", PRIV_ARGS));
      expect(payload.approvalId).toMatch(/^plan_approval_/u);
      expect(payload.actionHash).toBe(pending.actionHash);
      expect(verifySignature(ctx, body.capability)).toBe(true);

      const db = new DatabaseSync(ctx.dbPath);
      try {
        const approval = db
          .prepare("SELECT status, approved_by_actor_id FROM execution_plan_approvals WHERE approval_id = ?")
          .get(payload.approvalId) as { status: string; approved_by_actor_id: string };
        expect(approval).toEqual({ status: "consumed", approved_by_actor_id: "user" });
        const issuance = db
          .prepare("SELECT scope_name, approval_id, invocation_hash FROM jace_commander_capability_issuances")
          .all();
        expect(issuance).toEqual([
          { scope_name: "process.privileged", approval_id: payload.approvalId, invocation_hash: payload.invocationHash }
        ]);
        const events = db.prepare("SELECT name FROM audit_events WHERE name LIKE 'jace_commander.%'").all() as Array<{
          name: string;
        }>;
        expect(events.map((event) => event.name)).toEqual(["jace_commander.capability_issued"]);
      } finally {
        db.close();
      }
    });
  });

  it("never lets an approval be reused: the next identical call needs a fresh approval", async () => {
    await withCtx(async (ctx) => {
      const { body } = await approvedPrivilegedCapability(ctx);
      const again = await issue(ctx, "privileged_exec", PRIV_ARGS);
      expect(again.statusCode).toBe(409);
      expect(again.json().decision).toBe("require_approval");
      expect(again.json().workItemId).not.toBe(body.workItemId);

      // Database authority: replaying the consumed approval into a second
      // issuance row trips the one-capability-per-approval unique index.
      const registry = new SqliteJaceCommanderIssuanceRegistry(ctx.dbPath);
      try {
        expect(() =>
          registry.recordIssuance({
            payload: { ...body.capability.payload, nonce: "A".repeat(43) },
            workerId: "acs-jc-bridge",
            keyId: KEY_ID
          })
        ).toThrow(/already|reused/u);
      } finally {
        registry.close();
      }
    });
  });

  it("does not transfer an approval to a different argv", async () => {
    await withCtx(async (ctx) => {
      const first = await issue(ctx, "privileged_exec", PRIV_ARGS);
      const pending = first.json();
      expect((await approve(ctx, pending.workItemId, pending.actionHash)).statusCode).toBe(200);

      const tampered = { ...PRIV_ARGS, argv: ["/usr/bin/apt-get", "dist-upgrade"] };
      const mismatch = await issue(ctx, "privileged_exec", tampered);
      expect(mismatch.statusCode).toBe(409);
      expect(mismatch.json().workItemId).not.toBe(pending.workItemId);
      // Same argv, different timeout/stdin is also a different invocation.
      const stdin = await issue(ctx, "privileged_exec", { ...PRIV_ARGS, stdin: "y\n" });
      expect(stdin.statusCode).toBe(409);
      // A different requester cannot ride the approval either.
      const otherActor = await issue(ctx, "privileged_exec", PRIV_ARGS, JC_BRIDGE, "claude:other");
      expect(otherActor.statusCode).toBe(409);

      // The original approval still mints only for the exact approved argv.
      const exact = await issue(ctx, "privileged_exec", PRIV_ARGS);
      expect(exact.statusCode).toBe(200);
      expect(exact.json().workItemId).toBe(pending.workItemId);
    });
  });

  it("denies issuance when the approval has expired", async () => {
    await withCtx(async (ctx) => {
      const first = await issue(ctx, "privileged_exec", PRIV_ARGS);
      const pending = first.json();
      expect((await approve(ctx, pending.workItemId, pending.actionHash)).statusCode).toBe(200);
      const db = new DatabaseSync(ctx.dbPath);
      try {
        db.prepare("UPDATE execution_plan_approvals SET status = 'expired' WHERE work_item_id = ?").run(
          pending.workItemId
        );
      } finally {
        db.close();
      }
      const response = await issue(ctx, "privileged_exec", PRIV_ARGS);
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: "jace_commander_claim_rejected" });
      expect(response.json()).not.toHaveProperty("capability");
    });
  });

  it("denies self-approval by the requesting subject", async () => {
    await withCtx(async (ctx) => {
      const first = await issue(ctx, "privileged_exec", PRIV_ARGS);
      const pending = first.json();
      const self = await approve(ctx, pending.workItemId, pending.actionHash, {
        authorization: `Bearer ${SELF_TOKEN}`
      });
      expect(self.statusCode).toBe(403);
      expect(self.json()).toMatchObject({ code: "approval_self_denied" });
      const still = await issue(ctx, "privileged_exec", PRIV_ARGS);
      expect(still.statusCode).toBe(409);
    });
  });

  it("never auto-approves privileged_exec in admin execution mode", async () => {
    await withCtx(async (ctx) => {
      const db = new DatabaseSync(ctx.dbPath);
      try {
        db.prepare("UPDATE execution_mode_state SET mode = 'admin' WHERE id = 1").run();
      } finally {
        db.close();
      }
      const response = await issue(ctx, "privileged_exec", PRIV_ARGS);
      expect(response.statusCode).toBe(409);
      expect(response.json().decision).toBe("require_approval");
    });
  });

  it("rejects a durable issuance whose scope does not match the tool", async () => {
    await withCtx(async (ctx) => {
      const { body } = await approvedPrivilegedCapability(ctx);
      const registry = new SqliteJaceCommanderIssuanceRegistry(ctx.dbPath);
      try {
        expect(() =>
          registry.recordIssuance({
            payload: { ...body.capability.payload, scopes: ["integration.read"], nonce: "B".repeat(43) },
            workerId: "acs-jc-bridge",
            keyId: KEY_ID
          })
        ).toThrow(/scope binding/u);
      } finally {
        registry.close();
      }
    });
  });

  it("keeps acs.jc.v1 separate from acs.dc.v1 (audience, version, invocation domain)", async () => {
    await withCtx(async (ctx) => {
      const response = await issue(ctx, "jc_status", {});
      const payload = response.json().capability.payload;
      expect(payload.audience).toBe("jace-commander");
      expect(payload.version).toBe("acs.jc.v1");
      expect(payload.audience).not.toBe("desktop-commander");
      // A JC tool is not a Desktop Commander tool: the DC route refuses it.
      const dc = await ctx.app.inject({
        method: "POST",
        url: "/dc/capability/issue",
        headers: { authorization: `Bearer ${DC_BRIDGE_TOKEN}`, "x-dc-actor": JC_ACTOR },
        payload: { client_id: "c", tool: "privileged_exec", argsSummary: JSON.stringify(PRIV_ARGS) }
      });
      expect(dc.statusCode).not.toBe(200);
    });
  });
});
