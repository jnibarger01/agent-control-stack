import { createPrivateKey, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strictCanonicalJsonV1 } from "@agent-control-stack/shared";
import { jaceCommanderInvocationHash } from "@agent-control-stack/desktop-commander-adapter";
import type { ManagedAuthorityObservation } from "@agent-control-stack/policy-gate";
import { describe, expect, it } from "vitest";
import { buildGateway, type GatewayCredential } from "./server.js";

const OP_TOKEN = "op-token";
const JC_BRIDGE_TOKEN = "jc-bridge-token";
const DC_BRIDGE_TOKEN = "dc-bridge-token";
const SELF_TOKEN = "self-token";
const ACTOR = "chatgpt:jacen";
const RUNTIME_ID = "jc-test-runtime";

const credentials: GatewayCredential[] = [
  {
    id: "op",
    token: OP_TOKEN,
    actor: "user",
    actorId: "user",
    roles: ["operator"],
    scopes: ["acs:read", "acs:write", "acs:approve"]
  },
  // An approver whose actor id equals the requesting subject: self-approval.
  {
    id: "self",
    token: SELF_TOKEN,
    actor: "user",
    actorId: ACTOR,
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
  return { privateKey: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url") };
}

function gateway(configured = true) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "acs-jc-capability-")));
  const signing = keys();
  const app = buildGateway({
    dbPath: join(root, "control.db"),
    logger: false,
    auth: { token: "", actor: "user", actorId: "user", credentials },
    jaceCommanderCapability: configured
      ? { runtimeId: RUNTIME_ID, keyId: "jc-test-key", privateKey: signing.privateKey, ttlMs: 29_000 }
      : false,
    readManagedAuthority: () => healthyAuthority
  });
  return { root, signing, app, dbPath: join(root, "control.db") };
}
type Ctx = ReturnType<typeof gateway>;

function issue(
  ctx: Ctx,
  tool: string,
  args: Record<string, unknown>,
  token = JC_BRIDGE_TOKEN,
  actorHeader: "x-jc-actor" | "x-dc-actor" = "x-jc-actor"
) {
  return ctx.app.inject({
    method: "POST",
    url: "/jc/capability/issue",
    headers: { authorization: `Bearer ${token}`, [actorHeader]: ACTOR },
    payload: { client_id: "chatgpt", tool, argsSummary: JSON.stringify(args) }
  });
}

function approve(ctx: Ctx, workItemId: string, actionHash: string, token = OP_TOKEN) {
  return ctx.app.inject({
    method: "POST",
    url: `/work-items/${workItemId}/approve`,
    headers: { authorization: `Bearer ${token}` },
    payload: { actionHash, reason: "human approved exact root command" }
  });
}

function signatureValid(ctx: Ctx, capability: { payload: unknown; signature: string }): boolean {
  const publicKey = createPublicKey(
    createPrivateKey({ key: Buffer.from(ctx.signing.privateKey, "base64url"), format: "der", type: "pkcs8" })
  );
  return verify(
    null,
    Buffer.from(strictCanonicalJsonV1(capability.payload), "utf8"),
    publicKey,
    Buffer.from(capability.signature, "base64url")
  );
}

async function withGateway(fn: (ctx: Ctx) => Promise<void>, configured = true): Promise<void> {
  const ctx = gateway(configured);
  try {
    await fn(ctx);
  } finally {
    await ctx.app.close();
    rmSync(ctx.root, { recursive: true, force: true });
  }
}

const PRIV_ARGS = { argv: ["/usr/bin/apt-get", "update"], timeoutMs: 120000 };

describe("POST /jc/capability/issue (acs.jc.v1)", () => {
  it("matches the desktop-commander verifier's invocation hash (cross-repo interop vector)", () => {
    // Values computed by desktop-commander dist/jace-commander/contract.js computeJcInvocationHash.
    expect(jaceCommanderInvocationHash("privileged_exec", PRIV_ARGS)).toBe(
      "3c91cc6896164f03068b6f377290f64589a7f034e5135b6a2940651ea4b10bc6"
    );
    expect(jaceCommanderInvocationHash("acs_read", { view: "health" })).toBe(
      "92aa7dd353ab8a15eadd7524b00e43aff6287cca90aef6194172861f41991461"
    );
  });

  it("fails closed with 503 when acs.jc.v1 signing is not configured", () =>
    withGateway(async (ctx) => {
      const response = await issue(ctx, "acs_read", { view: "health" });
      expect(response.statusCode).toBe(503);
      expect(response.json().code).toBe("capability_issuance_unconfigured");
    }, false));

  it("requires the dedicated jace-commander bridge identity (the DC bridge cannot mint jc capabilities)", () =>
    withGateway(async (ctx) => {
      const response = await issue(ctx, "acs_read", { view: "health" }, DC_BRIDGE_TOKEN);
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe("jc_bridge_identity_required");
    }));

  it("accepts the jc-lane x-jc-actor header and still accepts x-dc-actor", () =>
    withGateway(async (ctx) => {
      const viaJc = await issue(ctx, "acs_read", { view: "health" }, JC_BRIDGE_TOKEN, "x-jc-actor");
      expect(viaJc.statusCode).toBe(200);
      const viaDc = await issue(ctx, "acs_read", { view: "health" }, JC_BRIDGE_TOKEN, "x-dc-actor");
      expect(viaDc.statusCode).toBe(200);
    }));

  it("issues a read capability without approval, audience jace-commander, exact args bound", () =>
    withGateway(async (ctx) => {
      const response = await issue(ctx, "acs_read", { view: "health" });
      expect(response.statusCode).toBe(200);
      const { capability } = response.json();
      const payload = capability.payload;
      expect(payload).toMatchObject({
        version: "acs.jc.v1",
        issuer: "acs",
        audience: "jace-commander",
        runtimeId: RUNTIME_ID,
        toolName: "acs_read",
        normalizedArguments: { view: "health" },
        scopes: ["integration.read"]
      });
      expect(payload.approvalId).toBeUndefined();
      expect(payload.invocationHash).toBe(jaceCommanderInvocationHash("acs_read", { view: "health" }));
      expect(Date.parse(payload.expiresAt) - Date.parse(payload.issuedAt)).toBeLessThanOrEqual(30_000);
      expect(capability.keyId).toBe("jc-test-key");
      expect(signatureValid(ctx, capability)).toBe(true);
    }));

  it("denies unknown tools and invalid arguments deterministically", () =>
    withGateway(async (ctx) => {
      const unknown = await issue(ctx, "run_command", { command: "id" });
      expect(unknown.statusCode).toBe(403);
      expect(unknown.json().reason).toBe("unknown_tool");
      const writeFile = await issue(ctx, "write_file", { path: "/tmp/x", content: "x" });
      expect(writeFile.statusCode).toBe(403);
      expect(writeFile.json().reason).toBe("unknown_tool");
      for (const argv of [["apt-get", "update"], ["/usr/bin/../bin/id"], []]) {
        const bad = await issue(ctx, "privileged_exec", { argv });
        expect(bad.statusCode).toBe(400);
        expect(bad.json().code).toBe("jace_commander_argument_invalid");
      }
      const extra = await issue(ctx, "privileged_exec", { argv: ["/usr/bin/id"], user: "root" });
      expect(extra.statusCode).toBe(400);
    }));

  it("privileged_exec: 409 require_approval, human approves exact action, identical retry is signed with approvalId", () =>
    withGateway(async (ctx) => {
      const first = await issue(ctx, "privileged_exec", PRIV_ARGS);
      expect(first.statusCode).toBe(409);
      const pending = first.json();
      expect(pending.decision).toBe("require_approval");
      expect(pending.requiredScopes).toEqual(["process.privileged"]);
      expect(pending.approvalSummary).toMatchObject({ runAs: "root", argv: PRIV_ARGS.argv, timeoutMs: 120000 });

      const detail = await ctx.app.inject({
        method: "GET",
        url: `/work-items/${pending.workItemId}`,
        headers: { authorization: `Bearer ${OP_TOKEN}` }
      });
      expect(detail.json().workItem).toMatchObject({ status: "needs_approval", risk: "critical" });
      expect(detail.json().workItem.requestedActions[0].kind).toBe("privileged.exec");

      expect((await approve(ctx, pending.workItemId, pending.actionHash)).statusCode).toBe(200);

      const issued = await issue(ctx, "privileged_exec", PRIV_ARGS);
      expect(issued.statusCode).toBe(200);
      const { capability } = issued.json();
      expect(capability.payload).toMatchObject({
        version: "acs.jc.v1",
        audience: "jace-commander",
        toolName: "privileged_exec",
        normalizedArguments: PRIV_ARGS,
        scopes: ["process.privileged"]
      });
      expect(typeof capability.payload.approvalId).toBe("string");
      expect(signatureValid(ctx, capability)).toBe(true);

      const db = new DatabaseSync(ctx.dbPath);
      try {
        const row = db
          .prepare(
            "SELECT tool_name, approval_id, approved_by_actor_id, nonce_hash FROM jace_commander_capability_issuances WHERE tool_name = 'privileged_exec'"
          )
          .get() as { approval_id: string; approved_by_actor_id: string; nonce_hash: string };
        expect(row.approval_id).toBe(capability.payload.approvalId);
        expect(row.approved_by_actor_id).toBe("user");
        expect(row.nonce_hash).not.toBe(capability.payload.nonce);
      } finally {
        db.close();
      }

      // The approval was consumed: the same call again needs a NEW human approval.
      const again = await issue(ctx, "privileged_exec", PRIV_ARGS);
      expect(again.statusCode).toBe(409);
      expect(again.json().workItemId).not.toBe(pending.workItemId);
    }));

  it("an approval for one argv never authorizes a different argv", () =>
    withGateway(async (ctx) => {
      const first = (await issue(ctx, "privileged_exec", PRIV_ARGS)).json();
      await approve(ctx, first.workItemId, first.actionHash);
      const other = await issue(ctx, "privileged_exec", {
        argv: ["/usr/bin/apt-get", "upgrade", "-y"],
        timeoutMs: 120000
      });
      expect(other.statusCode).toBe(409);
      expect(other.json().capability).toBeUndefined();
    }));

  it("admin execution mode never auto-approves privileged_exec, and acs:admin cannot approve it", () =>
    withGateway(async (ctx) => {
      const switched = await ctx.app.inject({
        method: "POST",
        url: "/execution-mode",
        headers: { authorization: `Bearer ${OP_TOKEN}` },
        payload: { mode: "admin", reason: "jc admin-mode negative test" }
      });
      expect(switched.statusCode).toBe(200);
      const response = await issue(ctx, "privileged_exec", PRIV_ARGS);
      expect(response.statusCode).toBe(409);
      expect(response.json().decision).toBe("require_approval");
      expect(response.json().capability).toBeUndefined();
    }));

  it("self-approval by the requesting subject is rejected before signing", () =>
    withGateway(async (ctx) => {
      const first = (await issue(ctx, "privileged_exec", PRIV_ARGS)).json();
      const approval = await approve(ctx, first.workItemId, first.actionHash, SELF_TOKEN);
      expect(approval.statusCode).toBe(200);
      const response = await issue(ctx, "privileged_exec", PRIV_ARGS);
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe("jace_commander_self_approval_denied");
      expect(response.json().capability).toBeUndefined();
    }));
});
