/**
 * Regression coverage for the inverted admin-mode auto-authorization gate.
 *
 * The admin block in the JC/DC capability issuance handlers used to treat
 * "policy returned NO require_approval evaluation" as a failure. That is
 * exactly the success case (policy already allows the action), so a read-only
 * JC tool in canonical admin mode was denied with
 * `reason: "all actions allowed"` -- the literal message rendered as
 * "ACS denied this tool call: all actions allowed".
 *
 * These tests pin the three-way classification of the admin evaluation:
 * deny -> deny, allow -> admin-authorized with no approval record,
 * require_approval -> approve through the normal approval record.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutionAdmissionScheduler } from "@agent-control-stack/execution-admission";
import { strictCanonicalJsonV1 } from "@agent-control-stack/shared";
import type { ManagedAuthorityObservation } from "@agent-control-stack/policy-gate";
import { describe, expect, it } from "vitest";
import { buildGateway, type GatewayCredential } from "./server.js";

const OP_TOKEN = "op-token";
const JC_BRIDGE_TOKEN = "jc-bridge-token";
const ACTOR = "chatgpt:jacen";
const RUNTIME_ID = "jc-admin-allow-runtime";
/** The deny reason summarizePolicy's ALLOW branch produces. It must never be returned on a deny. */
const ALLOW_REASON = "all actions allowed";

const credentials: GatewayCredential[] = [
  {
    id: "op",
    token: OP_TOKEN,
    actor: "user",
    actorId: "user",
    roles: ["operator"],
    scopes: ["acs:read", "acs:write", "acs:approve", "acs:execution-mode:admin"]
  },
  {
    id: "jc-bridge",
    token: JC_BRIDGE_TOKEN,
    actor: "agent",
    actorId: "acs-jc-bridge",
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

function testAdmission(): ExecutionAdmissionScheduler {
  return new ExecutionAdmissionScheduler({
    config: {
      executionMaxInflight: 1_000,
      executorMaxInflight: 1_000,
      queueMax: 1_000,
      queueTimeoutMs: 30_000,
      waitMaxInflight: 1_000
    }
  });
}

function gateway(authority: ManagedAuthorityObservation = healthyAuthority) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "acs-admin-allow-")));
  const pair = generateKeyPairSync("ed25519");
  const privateKey = pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url");
  const workspace = join(root, "workspace");
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "src", "index.ts"), "export {};\n");
  const app = buildGateway({
    dbPath: join(root, "control.db"),
    logger: false,
    auth: { token: "", actor: "user", actorId: "user", credentials },
    jaceCommanderCapability: { runtimeId: RUNTIME_ID, keyId: "jc-admin-key", privateKey, ttlMs: 29_000 },
    readManagedAuthority: () => authority,
    jaceCommanderContainment: { allowedRoots: [workspace], deniedRoots: [] },
    executionAdmission: testAdmission()
  });
  return { root, privateKey, workspace, app, dbPath: join(root, "control.db") };
}
type Ctx = ReturnType<typeof gateway>;

function issue(ctx: Ctx, tool: string, args: Record<string, unknown>, clientId = "chatgpt") {
  return ctx.app.inject({
    method: "POST",
    url: "/jc/capability/issue",
    headers: { authorization: `Bearer ${JC_BRIDGE_TOKEN}`, "x-jc-actor": ACTOR },
    payload: { client_id: clientId, tool, argsSummary: JSON.stringify(args) }
  });
}

function setMode(ctx: Ctx, mode: "strict" | "admin", reason: string) {
  return ctx.app.inject({
    method: "POST",
    url: "/execution-mode",
    headers: { authorization: `Bearer ${OP_TOKEN}` },
    payload: { mode, reason }
  });
}

function signatureValid(ctx: Ctx, capability: { payload: unknown; signature: string }): boolean {
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

/** No response may ever carry the ALLOW-branch reason on a deny path. */
function assertNotContradictoryDenial(response: { statusCode: number; body: string }): void {
  expect(response.body, `denied with the allow reason: ${response.body}`).not.toContain(ALLOW_REASON);
  if (response.statusCode >= 400) {
    expect(response.body).not.toMatch(/"reason"\s*:\s*"all actions allowed"/u);
  }
}

async function withGateway(
  fn: (ctx: Ctx) => Promise<void>,
  authority?: ManagedAuthorityObservation
): Promise<void> {
  const ctx = gateway(authority);
  try {
    await fn(ctx);
  } finally {
    await ctx.app.close();
    rmSync(ctx.root, { recursive: true, force: true });
  }
}

type JcInvocation = { tool: string; args: Record<string, unknown> };

const READ_TOOL: JcInvocation = { tool: "get_config", args: {} };

// Path-bearing factories: JC filesystem/process tools need a real workspace path.
const writeTool = (root: string): JcInvocation => ({
  tool: "write_file",
  args: { path: join(root, "workspace", "new.txt"), content: "admin allow\n", overwrite: false }
});
const processTool = (root: string): JcInvocation => ({
  tool: "start_process",
  args: { argv: ["/usr/bin/node", "--version"], cwd: join(root, "workspace"), timeoutMs: 5_000 }
});
const WRITE_TOOL = (root: string): JcInvocation => writeTool(root);
const PROCESS_TOOL = (root: string): JcInvocation => processTool(root);
const PRIV_TOOL: JcInvocation = {
  tool: "privileged_exec",
  args: { argv: ["/usr/bin/apt-get", "update"], timeoutMs: 120_000 }
};

describe("admin mode: policy allow is admin-authorized, never a denial", () => {
  it("strict mode still enforces normal policy for a JC write tool", () =>
    withGateway(async (ctx) => {
      expect((await setMode(ctx, "strict", "strict mode baseline")).statusCode).toBe(200);
      const response = await issue(ctx, writeTool(ctx.root).tool, writeTool(ctx.root).args);
      expect(response.statusCode).toBe(409);
      expect(response.json().decision).toBe("require_approval");
      expect(response.json().capability).toBeUndefined();
      assertNotContradictoryDenial(response);
    }));

  it("strict mode still gates privileged_exec behind a human approval", () =>
    withGateway(async (ctx) => {
      expect((await setMode(ctx, "strict", "strict privileged baseline")).statusCode).toBe(200);
      const response = await issue(ctx, PRIV_TOOL.tool, PRIV_TOOL.args);
      expect(response.statusCode).toBe(409);
      expect(response.json().decision).toBe("require_approval");
      assertNotContradictoryDenial(response);
    }));

  it("admin mode issues a read-only JC capability (policy returns no approval to create)", () =>
    withGateway(async (ctx) => {
      expect((await setMode(ctx, "admin", "admin allow read")).statusCode).toBe(200);
      const response = await issue(ctx, READ_TOOL.tool, READ_TOOL.args);
      assertNotContradictoryDenial(response);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().decision).toBe("allow");
      const { capability } = response.json();
      expect(capability.payload).toMatchObject({
        version: "acs.jc.v1",
        audience: "jace-commander",
        toolName: READ_TOOL.tool,
        scopes: ["integration.read"]
      });
      // A policy "allow" leaves no approval record to bind.
      expect(capability.payload.approvalId).toBeUndefined();
      expect(signatureValid(ctx, capability)).toBe(true);
    }));

  it("admin mode issues a write capability", () =>
    withGateway(async (ctx) => {
      expect((await setMode(ctx, "admin", "admin allow write")).statusCode).toBe(200);
      const response = await issue(ctx, writeTool(ctx.root).tool, writeTool(ctx.root).args);
      assertNotContradictoryDenial(response);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().decision).toBe("allow");
      expect(response.json().capability.payload.toolName).toBe("write_file");
    }));

  it("admin mode issues a process-exec capability", () =>
    withGateway(async (ctx) => {
      expect((await setMode(ctx, "admin", "admin allow process")).statusCode).toBe(200);
      const response = await issue(ctx, processTool(ctx.root).tool, processTool(ctx.root).args);
      assertNotContradictoryDenial(response);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().decision).toBe("allow");
      expect(response.json().capability.payload.toolName).toBe("start_process");
    }));

  it("admin mode satisfies the privileged.exec approval record with the admin approver", () =>
    withGateway(async (ctx) => {
      expect((await setMode(ctx, "admin", "admin allow privileged")).statusCode).toBe(200);
      const response = await issue(ctx, PRIV_TOOL.tool, PRIV_TOOL.args);
      assertNotContradictoryDenial(response);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().decision).toBe("allow");
      // privileged.exec is require_approval for the admin approver, so an
      // approval record (approved by acs:admin) must exist and be bound.
      expect(typeof response.json().capability.payload.approvalId).toBe("string");

      const db = new DatabaseSync(ctx.dbPath);
      try {
        const approvers = db
          .prepare(
            "SELECT DISTINCT approved_by_actor_id AS actor FROM jace_commander_capability_issuances WHERE tool_name = 'privileged_exec' AND approval_id IS NOT NULL"
          )
          .all() as Array<{ actor: string }>;
        expect(approvers.map((row) => row.actor)).toEqual(["acs:admin"]);
      } finally {
        db.close();
      }
    }));

  it("no admin-mode request is ever denied with reason 'all actions allowed'", () =>
    withGateway(async (ctx) => {
      expect((await setMode(ctx, "admin", "admin allow sweep")).statusCode).toBe(200);
      const cases = [
        READ_TOOL,
        WRITE_TOOL(ctx.root),
        PROCESS_TOOL(ctx.root),
        PRIV_TOOL,
        { tool: "acs_read", args: { view: "health" } },
        { tool: "jc_status", args: {} }
      ] as const;
      for (const { tool, args } of cases) {
        const response = await issue(ctx, tool, args);
        assertNotContradictoryDenial(response);
        expect(response.statusCode, `${tool}: ${response.body}`).toBe(200);
        expect(response.json().decision, tool).toBe("allow");
      }
    }));

  it("a labelled ChatGPT connector identity still gets admin authority", () =>
    withGateway(async (ctx) => {
      expect((await setMode(ctx, "admin", "admin allow labelled client")).statusCode).toBe(200);
      for (const clientId of ["chatgpt", "client-chatgpt-1"]) {
        const response = await issue(ctx, READ_TOOL.tool, READ_TOOL.args, clientId);
        assertNotContradictoryDenial(response);
        expect(response.statusCode, `${clientId}: ${response.body}`).toBe(200);
        expect(response.json().decision, clientId).toBe("allow");
      }
    }));

  it("the admin allow case still audits the issuance as issued, not denied", () =>
    withGateway(async (ctx) => {
      expect((await setMode(ctx, "admin", "admin allow audit")).statusCode).toBe(200);
      const response = await issue(ctx, READ_TOOL.tool, READ_TOOL.args);
      expect(response.statusCode).toBe(200);

      const db = new DatabaseSync(ctx.dbPath);
      try {
        const issued = db
          .prepare(
            "SELECT COUNT(*) AS count FROM jace_commander_capability_issuances WHERE tool_name = ?"
          )
          .get(READ_TOOL.tool) as { count: number };
        expect(issued.count).toBe(1);
      } finally {
        db.close();
      }
    }));
  it("JC records execution_mode.auto_authorized on the approval-free path", async () => {
    await withGateway(async (ctx) => {
      expect((await setMode(ctx, "admin", "admin allow audit attribution")).statusCode).toBe(200);
      const response = await issue(ctx, READ_TOOL.tool, READ_TOOL.args);
      expect(response.statusCode, response.body).toBe(200);

      const db = new DatabaseSync(ctx.dbPath);
      try {
        const rows = db
          .prepare(
            "SELECT body FROM audit_events WHERE name = 'execution_mode.auto_authorized' ORDER BY sequence DESC"
          )
          .all() as { body: string }[];
        expect(rows.length).toBeGreaterThan(0);
        const body = JSON.parse(rows[0].body) as {
          tool?: string;
          approvalPolicy?: string;
          approvalRecord?: string | null;
          approvedBy?: string | null;
        };
        expect(body.tool).toBe(READ_TOOL.tool);
        // The approval-free case must be distinguishable from an approval-backed one,
        // and must not claim an acs:admin approval that has no backing record.
        expect(body.approvalPolicy).toBe("auto_policy_allowed");
        expect(body.approvalRecord).toBeNull();
        expect(body.approvedBy).toBeNull();
      } finally {
        db.close();
      }
    });
  });

  it("privileged.exec under admin mode records an approval-backed authorization", async () => {
    await withGateway(async (ctx) => {
      expect((await setMode(ctx, "admin", "admin privileged audit")).statusCode).toBe(200);
      const response = await issue(ctx, PRIV_TOOL.tool, PRIV_TOOL.args);
      expect(response.statusCode, response.body).toBe(200);

      const db = new DatabaseSync(ctx.dbPath);
      try {
        const rows = db
          .prepare(
            "SELECT body FROM audit_events WHERE name = 'execution_mode.auto_authorized' ORDER BY sequence DESC"
          )
          .all() as { body: string }[];
        expect(rows.length).toBeGreaterThan(0);
        const body = JSON.parse(rows[0].body) as { approvalPolicy?: string; approvedBy?: string | null };
        // privileged.exec DOES require an approval record, so this one is backed.
        expect(body.approvalPolicy).toBe("auto");
        expect(body.approvedBy).toBe("acs:admin");
      } finally {
        db.close();
      }
    });
  });

  it("admin mode still fails closed when the authority gate reports executor ambiguity", () =>
    withGateway(
      async (ctx) => {
        expect((await setMode(ctx, "admin", "ambiguous authority")).statusCode).toBe(200);
        const response = await issue(ctx, READ_TOOL.tool, READ_TOOL.args);
        assertNotContradictoryDenial(response);
        // Fail closed: no capability is issued when executor authority is ambiguous.
        expect(response.statusCode).toBe(403);
        expect(response.json().code).toBe("executor_ambiguous");
      },
      {
        ...healthyAuthority,
        leaseAmbiguous: true,
        multipleAuthoritativeExecutors: true,
        detail: "multiple managed executors"
      }
    ));
});
