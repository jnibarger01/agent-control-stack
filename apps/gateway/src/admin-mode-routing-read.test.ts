/**
 * Admin mode vs authoritative (Nimble) routing on /jc/capability/issue.
 *
 * With ACS_NIMBLE_ROUTING_ENABLED=1 a JC capability item is never routed, so the by-id
 * claim used to return nothing and the route replied 409 `require_approval` -- even for
 * policy-allowed reads such as jc_status / jc_doctor, and even though admin mode had
 * authorized the call. Admin mode must authorize every JC capability with no second human
 * approval gate; strict mode and an expired bounded admin TTL must keep normal enforcement.
 */
import { generateKeyPairSync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutionAdmissionScheduler } from "@agent-control-stack/execution-admission";
import type { ManagedAuthorityObservation } from "@agent-control-stack/policy-gate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildGateway, type GatewayCredential } from "./server.js";

const OP_TOKEN = "op-token";
const JC_BRIDGE_TOKEN = "jc-bridge-token";
const ACTOR = "chatgpt:jacen";
const TTL_MS = 60_000;

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

interface GatewayTestOptions {
  adminModeTtlMs?: number;
  authority?: () => ManagedAuthorityObservation;
}

function gateway(options: GatewayTestOptions = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "acs-admin-routing-read-")));
  const pair = generateKeyPairSync("ed25519");
  const privateKey = pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url");
  const workspace = join(root, "workspace");
  mkdirSync(join(workspace, "src"), { recursive: true });
  writeFileSync(join(workspace, "src", "index.ts"), "export {};\n");
  const dbPath = join(root, "control.db");
  const app = buildGateway({
    dbPath,
    logger: false,
    auth: { token: "", actor: "user", actorId: "user", credentials },
    jaceCommanderCapability: { runtimeId: "jc-admin-routing-read", keyId: "jc-key", privateKey, ttlMs: 29_000 },
    readManagedAuthority: options.authority ?? (() => healthyAuthority),
    jaceCommanderContainment: { allowedRoots: [workspace], deniedRoots: [] },
    executionAdmission: new ExecutionAdmissionScheduler({
      config: {
        executionMaxInflight: 1_000,
        executorMaxInflight: 1_000,
        queueMax: 1_000,
        queueTimeoutMs: 30_000,
        waitMaxInflight: 1_000
      }
    }),
    ...(options.adminModeTtlMs === undefined ? {} : { adminModeTtlMs: options.adminModeTtlMs })
  });
  return { root, app, dbPath, workspace };
}
type Ctx = ReturnType<typeof gateway>;

const issue = (ctx: Ctx, tool: string, args: Record<string, unknown>) =>
  ctx.app.inject({
    method: "POST",
    url: "/jc/capability/issue",
    headers: { authorization: `Bearer ${JC_BRIDGE_TOKEN}`, "x-jc-actor": ACTOR },
    payload: { client_id: "chatgpt", tool, argsSummary: JSON.stringify(args) }
  });

const setMode = (ctx: Ctx, mode: "strict" | "admin", reason: string) =>
  ctx.app.inject({
    method: "POST",
    url: "/execution-mode",
    headers: { authorization: `Bearer ${OP_TOKEN}` },
    payload: { mode, reason }
  });

async function withGateway(fn: (ctx: Ctx) => Promise<void>, options: GatewayTestOptions = {}): Promise<void> {
  const ctx = gateway(options);
  try {
    await fn(ctx);
  } finally {
    await ctx.app.close();
    rmSync(ctx.root, { recursive: true, force: true });
  }
}

function query<T>(ctx: Ctx, sql: string, ...params: string[]): T[] {
  const db = new DatabaseSync(ctx.dbPath, { readOnly: true });
  try {
    return db.prepare(sql).all(...params) as T[];
  } finally {
    db.close();
  }
}
const overrideEvents = (ctx: Ctx) =>
  query<{ name: string }>(ctx, "SELECT name FROM audit_events WHERE name = 'execution_mode.routing_override'").length;

const READ_TOOLS = [
  { tool: "jc_status", args: {} },
  { tool: "jc_doctor", args: {} },
  // An approval-free JC read that is neither of the two diagnostics.
  { tool: "get_config", args: {} },
  { tool: "acs_read", args: { view: "health" } }
] as const;
const PRIV_TOOL = { tool: "privileged_exec", args: { argv: ["/usr/bin/apt-get", "update"], timeoutMs: 120_000 } };
const writeTool = (ctx: Ctx) => ({
  tool: "write_file",
  args: { path: join(ctx.workspace, "new.txt"), content: "admin routing\n", overwrite: false }
});

describe("JC capability issuance with authoritative routing enabled", () => {
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env.ACS_NIMBLE_ROUTING_ENABLED;
    process.env.ACS_NIMBLE_ROUTING_ENABLED = "1";
  });
  afterEach(() => {
    vi.useRealTimers();
    if (previous === undefined) delete process.env.ACS_NIMBLE_ROUTING_ENABLED;
    else process.env.ACS_NIMBLE_ROUTING_ENABLED = previous;
  });

  for (const { tool, args } of READ_TOOLS) {
    it(`admin mode issues ${tool} with no approval record and no human gate`, () =>
      withGateway(async (ctx) => {
        expect((await setMode(ctx, "admin", "admin read without approval")).statusCode).toBe(200);
        const response = await issue(ctx, tool, args);
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json().decision).toBe("allow");
        expect(response.json().capability.payload.toolName).toBe(tool);
        // Policy allows the read, so nothing is approved: no approval row, no acs:admin approval claimed.
        expect(response.json().capability.payload.approvalId).toBeUndefined();
        expect(query(ctx, "SELECT 1 FROM approval_records")).toHaveLength(0);
        expect(overrideEvents(ctx)).toBe(1);
      }));
  }

  it("admin mode issues an approval-requiring write and records an acs:admin approval", () =>
    withGateway(async (ctx) => {
      expect((await setMode(ctx, "admin", "admin write")).statusCode).toBe(200);
      const { tool, args } = writeTool(ctx);
      const response = await issue(ctx, tool, args);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().decision).toBe("allow");
      expect(typeof response.json().capability.payload.approvalId).toBe("string");
      const approvers = query<{ actor: string }>(
        ctx,
        "SELECT DISTINCT approved_by_actor_id AS actor FROM jace_commander_capability_issuances WHERE tool_name = 'write_file' AND approval_id IS NOT NULL"
      );
      expect(approvers.map((row) => row.actor)).toEqual(["acs:admin"]);
      expect(overrideEvents(ctx)).toBe(1);
    }));

  it("admin mode authorizes privileged_exec without a second human approval", () =>
    withGateway(async (ctx) => {
      expect((await setMode(ctx, "admin", "admin privileged")).statusCode).toBe(200);
      const response = await issue(ctx, PRIV_TOOL.tool, PRIV_TOOL.args);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().decision).toBe("allow");
      const approvers = query<{ actor: string }>(
        ctx,
        "SELECT DISTINCT approved_by_actor_id AS actor FROM jace_commander_capability_issuances WHERE tool_name = 'privileged_exec' AND approval_id IS NOT NULL"
      );
      expect(approvers.map((row) => row.actor)).toEqual(["acs:admin"]);
    }));

  it("strict mode keeps routing enforcement: no capability and no routing override", () =>
    withGateway(async (ctx) => {
      expect((await setMode(ctx, "strict", "strict baseline")).statusCode).toBe(200);
      for (const { tool, args } of [...READ_TOOLS, PRIV_TOOL, writeTool(ctx)]) {
        const response = await issue(ctx, tool, args);
        expect(response.statusCode, `${tool}: ${response.body}`).toBe(409);
        expect(response.json().decision, tool).toBe("require_approval");
        expect(response.json().capability, tool).toBeUndefined();
      }
      expect(overrideEvents(ctx)).toBe(0);
    }));

  it("a bounded admin TTL that has expired restores normal enforcement", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await withGateway(
      async (ctx) => {
        expect((await setMode(ctx, "admin", "bounded admin elevation")).statusCode).toBe(200);
        const inside = await issue(ctx, "jc_status", {});
        expect(inside.statusCode, inside.body).toBe(200);
        expect(overrideEvents(ctx)).toBe(1);

        vi.setSystemTime(new Date(Date.now() + TTL_MS + 5_000));
        const mode = await ctx.app.inject({
          method: "GET",
          url: "/execution-mode",
          headers: { authorization: `Bearer ${OP_TOKEN}` }
        });
        expect(mode.json().executionMode).toBe("strict");

        for (const { tool, args } of [{ tool: "jc_doctor", args: {} }, PRIV_TOOL, writeTool(ctx)]) {
          const after = await issue(ctx, tool, args);
          expect(after.statusCode, `${tool}: ${after.body}`).toBe(409);
          expect(after.json().decision, tool).toBe("require_approval");
        }
        // No override once admin lapsed (still only the one from inside the window).
        expect(overrideEvents(ctx)).toBe(1);
      },
      { adminModeTtlMs: TTL_MS }
    );
  });

  it("the default (no TTL) stays admin far past any bounded window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await withGateway(async (ctx) => {
      expect((await setMode(ctx, "admin", "sticky admin default")).statusCode).toBe(200);
      vi.setSystemTime(new Date(Date.now() + 48 * 60 * 60 * 1000));
      const response = await issue(ctx, "jc_status", {});
      expect(response.statusCode, response.body).toBe(200);
    });
  });

  describe("stale capability items", () => {
    it("an item left over from a blocked strict-mode call does not keep forcing require_approval after admin is enabled", () =>
      withGateway(async (ctx) => {
        expect((await setMode(ctx, "strict", "strict first")).statusCode).toBe(200);
        const blocked = await issue(ctx, "jc_status", {});
        expect(blocked.statusCode).toBe(409);
        const staleId = blocked.json().workItemId as string;
        expect(staleId).toMatch(/^wrk_/u);

        expect((await setMode(ctx, "admin", "admin after stale")).statusCode).toBe(200);
        const response = await issue(ctx, "jc_status", {});
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json().decision).toBe("allow");
        // The identical call reuses the pre-existing item rather than orphaning it.
        expect(response.json().capability.payload.workItemId ?? staleId).toBe(staleId);
        const status = query<{ status: string }>(ctx, "SELECT status FROM work_items WHERE id = ?", staleId);
        expect(status[0]?.status).not.toBe("needs_approval");
      }));

    it("an approved item with no plan, attempt or approval (the live wrk_d6c624b3 shape) is reused and issued once authority recovers", async () => {
      // Authority is healthy for the admin gate, then ambiguous at claim-time re-validation: the claim
      // rolls back after the item was already approved, which strands it `approved` with no attempt.
      let calls = 0;
      let flapping = true;
      const flaky = (): ManagedAuthorityObservation =>
        !flapping || ++calls <= 1
          ? healthyAuthority
          : { ...healthyAuthority, leaseAmbiguous: true, detail: "authority flapped" };
      await withGateway(
        async (ctx) => {
          expect((await setMode(ctx, "admin", "admin stale seed")).statusCode).toBe(200);
          const stranded = await issue(ctx, "jc_status", {});
          expect(stranded.statusCode, stranded.body).not.toBe(200);

          const rows = query<{ id: string; status: string }>(
            ctx,
            "SELECT id, status FROM work_items WHERE title LIKE '%jc_status%'"
          );
          expect(rows).toHaveLength(1);
          const staleId = rows[0].id;
          expect(rows[0].status).toBe("approved");
          expect(query(ctx, "SELECT 1 FROM execution_attempts WHERE work_item_id = ?", staleId)).toHaveLength(0);
          expect(query(ctx, "SELECT 1 FROM approval_records WHERE work_item_id = ?", staleId)).toHaveLength(0);

          flapping = false;
          const recovered = await issue(ctx, "jc_status", {});
          expect(recovered.statusCode, recovered.body).toBe(200);
          expect(recovered.json().decision).toBe("allow");
          const after = query<{ id: string }>(ctx, "SELECT id FROM work_items WHERE title LIKE '%jc_status%'");
          expect(after.map((row) => row.id)).toEqual([staleId]);
          expect(query(ctx, "SELECT 1 FROM execution_attempts WHERE work_item_id = ?", staleId)).toHaveLength(1);
        },
        { authority: flaky }
      );
    });
  });
});
