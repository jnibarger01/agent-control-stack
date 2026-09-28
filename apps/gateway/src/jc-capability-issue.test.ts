import { createPrivateKey, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strictCanonicalJsonV1 } from "@agent-control-stack/shared";
import {
  jaceCommanderInvocationHash,
  jaceCommanderToolNames,
  jaceCommanderToolPolicy
} from "@agent-control-stack/desktop-commander-adapter";
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

function gateway(configured = true, fsRoots?: (root: string) => string[]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "acs-jc-capability-")));
  const signing = keys();
  const app = buildGateway({
    dbPath: join(root, "control.db"),
    logger: false,
    auth: { token: "", actor: "user", actorId: "user", credentials },
    jaceCommanderCapability: configured
      ? { runtimeId: RUNTIME_ID, keyId: "jc-test-key", privateKey: signing.privateKey, ttlMs: 29_000 }
      : false,
    readManagedAuthority: () => healthyAuthority,
    jaceCommanderContainment: fsRoots ? { allowedRoots: fsRoots(root), deniedRoots: [] } : false
  });
  return { root, signing, app, dbPath: join(root, "control.db") };
}
type Ctx = ReturnType<typeof gateway>;

function issue(ctx: Ctx, tool: string, args: Record<string, unknown>, token = JC_BRIDGE_TOKEN) {
  return ctx.app.inject({
    method: "POST",
    url: "/jc/capability/issue",
    headers: { authorization: `Bearer ${token}`, "x-dc-actor": ACTOR },
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

async function withGateway(
  fn: (ctx: Ctx) => Promise<void>,
  configured = true,
  fsRoots?: (root: string) => string[]
): Promise<void> {
  const ctx = gateway(configured, fsRoots);
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

  it("self-approval by the requesting subject is rejected at /approve and nothing is signed", () =>
    withGateway(async (ctx) => {
      const first = (await issue(ctx, "privileged_exec", PRIV_ARGS)).json();
      const approval = await approve(ctx, first.workItemId, first.actionHash, SELF_TOKEN);
      expect(approval.statusCode).toBe(403);
      expect(approval.json().code).toBe("approval_self_denied");
      const response = await issue(ctx, "privileged_exec", PRIV_ARGS);
      expect(response.statusCode).toBe(409);
      expect(response.json().capability).toBeUndefined();
    }));
});

// PR #212 review B2/B3: every approval-gated JC tool (derived from the
// manifest), not only privileged_exec, refuses self-approval and admin
// auto-approval, and its approval challenge shows the approver what runs.
describe("POST /jc/capability/issue: every approval-gated tool (B2 self-approval, B3 approval summary)", () => {
  const GATED = jaceCommanderToolNames().filter((name) => jaceCommanderToolPolicy(name)?.requiresApproval === true);
  const head = "0123456789abcdef0123456789abcdef01234567";
  const argsFor = (
    root: string
  ): Record<string, { args: Record<string, unknown>; fields: Record<string, unknown> }> => {
    const ws = join(root, "workspace");
    return {
      privileged_exec: { args: PRIV_ARGS, fields: { runAs: "root", argv: PRIV_ARGS.argv, timeoutMs: 120000 } },
      write_file: {
        args: { path: join(ws, "new.txt"), content: "hello approver\n", overwrite: false },
        fields: { path: join(ws, "new.txt"), bytes: 15, overwrite: false, preview: "hello approver\n" }
      },
      create_directory: { args: { path: join(ws, "made") }, fields: { path: join(ws, "made") } },
      move_file: {
        args: { from: join(ws, "src", "index.ts"), to: join(ws, "src", "moved.ts") },
        fields: { from: join(ws, "src", "index.ts"), to: join(ws, "src", "moved.ts") }
      },
      edit_block: {
        args: { path: join(ws, "src", "index.ts"), old: "export {};", new: "export const x = 1;" },
        fields: { path: join(ws, "src", "index.ts"), oldPreview: "export {};", newPreview: "export const x = 1;" }
      },
      start_process: {
        args: { argv: ["/usr/bin/node", "--version"], cwd: ws, timeoutMs: 5000 },
        fields: { argv: ["/usr/bin/node", "--version"], cwd: ws, timeoutMs: 5000 }
      },
      kill_process: { args: { sessionId: "proc_1" }, fields: { sessionId: "proc_1" } },
      git_add: { args: { repo: ws, paths: ["src/index.ts"] }, fields: { repo: ws, paths: ["src/index.ts"] } },
      git_commit: {
        args: { repo: ws, message: "chore: approver-visible" },
        fields: { repo: ws, message: "chore: approver-visible" }
      },
      git_fetch: { args: { repo: ws, remote: "origin" }, fields: { repo: ws, remote: "origin" } },
      git_push: {
        args: { repo: ws, remote: "origin", branch: "main", expectedHead: head },
        fields: { repo: ws, remote: "origin", branch: "main", expectedHead: head }
      }
    };
  };
  const workspace = (root: string) => {
    const dir = join(root, "workspace");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "index.ts"), "export {};\n");
    return [dir];
  };

  it("the gated list is the manifest's (11 tools) and every one has fixtures", () => {
    expect(GATED).toHaveLength(11);
    const fixtures = argsFor("/tmp/x");
    for (const tool of GATED) expect(fixtures[tool], tool).toBeDefined();
  });

  it("the requester's own approval is refused for every gated tool; the challenge shows the arguments", () =>
    withGateway(
      async (ctx) => {
        const fixtures = argsFor(ctx.root);
        for (const tool of GATED) {
          const { args, fields } = fixtures[tool]!;
          const held = await issue(ctx, tool, args);
          expect(held.statusCode, `${tool}: ${held.body}`).toBe(409);
          const pending = held.json();
          expect(pending.approvalSummary, tool).toMatchObject({ tool, ...fields });
          expect(pending.approvalSummary.invocationHash).toBe(jaceCommanderInvocationHash(tool, args));
          const detail = await ctx.app.inject({
            method: "GET",
            url: `/work-items/${pending.workItemId}`,
            headers: { authorization: `Bearer ${OP_TOKEN}` }
          });
          const item = detail.json().workItem;
          expect(item.requestedActions[0].params.approvalSummary).toMatchObject({ tool, ...fields });
          if (tool !== "privileged_exec") {
            expect(item.title.startsWith(`Jace Commander ${tool} `), item.title).toBe(true);
            expect(item.intent).toContain("Approve exactly:");
          }

          const self = await approve(ctx, pending.workItemId, pending.actionHash, SELF_TOKEN);
          expect(self.statusCode, `${tool}: ${self.body}`).toBe(403);
          expect(self.json().code).toBe("approval_self_denied");
          const retry = await issue(ctx, tool, args);
          expect(retry.statusCode, tool).toBe(409);
          expect(retry.json().capability).toBeUndefined();
        }
      },
      true,
      workspace
    ));

  it("admin execution mode never auto-approves any gated tool; a different human's approval is signed", () =>
    withGateway(
      async (ctx) => {
        const switched = await ctx.app.inject({
          method: "POST",
          url: "/execution-mode",
          headers: { authorization: `Bearer ${OP_TOKEN}` },
          payload: { mode: "admin", reason: "jc admin-mode negative test (all gated tools)" }
        });
        expect(switched.statusCode).toBe(200);
        const fixtures = argsFor(ctx.root);
        for (const tool of GATED) {
          const { args } = fixtures[tool]!;
          const held = await issue(ctx, tool, args);
          expect(held.statusCode, `${tool}: ${held.body}`).toBe(409);
          expect(held.json().capability).toBeUndefined();
          expect((await approve(ctx, held.json().workItemId, held.json().actionHash)).statusCode, tool).toBe(200);
          const issued = await issue(ctx, tool, args);
          expect(issued.statusCode, `${tool}: ${issued.body}`).toBe(200);
          expect(typeof issued.json().capability.payload.approvalId).toBe("string");
        }
        const db = new DatabaseSync(ctx.dbPath);
        try {
          const approvers = db
            .prepare(
              "SELECT DISTINCT approved_by_actor_id AS actor FROM jace_commander_capability_issuances WHERE approval_id IS NOT NULL"
            )
            .all() as Array<{ actor: string }>;
          expect(approvers.map((row) => row.actor)).toEqual(["user"]);
        } finally {
          db.close();
        }
      },
      true,
      workspace
    ));
});

describe("POST /jc/capability/issue: filesystem tools (fs.read, ACS containment)", () => {
  const workspace = (root: string) => {
    const dir = join(root, "workspace");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "index.ts"), "export {};\n");
    return [dir];
  };

  it("issues fs.read capabilities without approval for paths inside the ACS roots", () =>
    withGateway(
      async (ctx) => {
        const file = join(ctx.root, "workspace", "src", "index.ts");
        for (const [tool, args] of [
          ["read_file", { path: file, offset: 0, length: 20 }],
          ["get_file_info", { path: file }],
          ["list_directory", { path: join(ctx.root, "workspace"), depth: 2 }],
          ["read_multiple_files", { paths: [file] }]
        ] as const) {
          const response = await issue(ctx, tool, args);
          expect(response.statusCode, `${tool}: ${response.body}`).toBe(200);
          const { payload } = response.json().capability;
          expect(payload).toMatchObject({ toolName: tool, normalizedArguments: args, scopes: ["fs.read"] });
          expect(payload.approvalId).toBeUndefined();
        }
      },
      true,
      workspace
    ));

  it("denies a path outside the ACS roots before any work item or signature", () =>
    withGateway(
      async (ctx) => {
        const response = await issue(ctx, "read_file", { path: "/etc/hostname" });
        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({
          decision: "deny",
          reason: "path_not_allowed",
          code: "jace_commander_path_outside_allow_root"
        });
        const many = await issue(ctx, "read_multiple_files", {
          paths: [join(ctx.root, "workspace", "src", "index.ts"), "/etc/hostname"]
        });
        expect(many.statusCode).toBe(403);
      },
      true,
      workspace
    ));

  it("denies credential paths even inside the ACS roots", () =>
    withGateway(
      async (ctx) => {
        writeFileSync(join(ctx.root, "workspace", ".env"), "SECRET=1\n");
        const response = await issue(ctx, "read_file", { path: join(ctx.root, "workspace", ".env") });
        expect(response.statusCode).toBe(403);
        expect(response.json().code).toBe("jace_commander_path_credential");
      },
      true,
      workspace
    ));

  it("fails closed (503) for every filesystem tool when no JC containment roots are configured", () =>
    withGateway(async (ctx) => {
      const response = await issue(ctx, "read_file", { path: join(ctx.root, "x") });
      expect(response.statusCode).toBe(503);
      expect(response.json().code).toBe("jace_commander_containment_unconfigured");
      // Non-filesystem tools are unaffected.
      expect((await issue(ctx, "acs_read", { view: "health" })).statusCode).toBe(200);
    }));

  it("rejects relative and home-relative paths at schema validation (the caller must resolve them)", () =>
    withGateway(
      async (ctx) => {
        for (const path of ["src/index.ts", "~/x", "./x"]) {
          const response = await issue(ctx, "read_file", { path });
          expect(response.statusCode).toBe(400);
          expect(response.json().code).toBe("jace_commander_argument_invalid");
        }
      },
      true,
      workspace
    ));
});

describe("POST /jc/capability/issue: requester attribution header", () => {
  const post = (ctx: Ctx, headers: Record<string, string>) =>
    ctx.app.inject({
      method: "POST",
      url: "/jc/capability/issue",
      headers: { authorization: `Bearer ${JC_BRIDGE_TOKEN}`, ...headers },
      payload: { client_id: "chatgpt", tool: "acs_read", argsSummary: JSON.stringify({ view: "health" }) }
    });

  it("accepts x-jc-actor, the header the /jc/mcp edge actually sends (regression: it was ignored)", () =>
    withGateway(async (ctx) => {
      const response = await post(ctx, { "x-jc-actor": ACTOR });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().capability.payload.toolName).toBe("acs_read");
    }));

  it("still accepts the legacy x-dc-actor, and rejects conflicting or missing attribution", () =>
    withGateway(async (ctx) => {
      expect((await post(ctx, { "x-dc-actor": ACTOR })).statusCode).toBe(200);
      const conflicting = await post(ctx, { "x-jc-actor": ACTOR, "x-dc-actor": "chatgpt:someone-else" });
      expect(conflicting.statusCode).toBe(400);
      expect(conflicting.json().code).toBe("jc_actor_invalid");
      const missing = await post(ctx, {});
      expect(missing.statusCode).toBe(400);
      expect(missing.json().code).toBe("jc_actor_invalid");
    }));
});

// PR #213 review round 1, item 1: a secret on the command line of an
// approval-gated exec tool never reaches the approval challenge, the work-item
// title, intent or stored approval summary. Fake values assembled at runtime.
describe("POST /jc/capability/issue: argv secrets are redacted on every approver surface", () => {
  const fake = (...parts: string[]) => parts.join("");
  const secrets = [
    fake("fakeTok", "EqValue", "11"),
    fake("fakePw", "Spaced", "12"),
    fake("fakeBearer", "Header", "13"),
    fake("AbC9", "dEf8", "GhI7", "jKl6", "MnO5", "pQr4", "StU3", "vWx2")
  ];
  const argvWithSecrets = (executable: string) => [
    executable,
    `--token=${secrets[0]}`,
    "--password",
    secrets[1]!,
    "-H",
    `Authorization: Bearer ${secrets[2]}`,
    secrets[3]!
  ];

  it("privileged_exec and start_process: challenge, title, intent and params never contain the secret", () =>
    withGateway(
      async (ctx) => {
        const ws = join(ctx.root, "workspace");
        const cases: Array<[string, Record<string, unknown>]> = [
          ["privileged_exec", { argv: argvWithSecrets("/usr/bin/curl"), timeoutMs: 1000 }],
          ["start_process", { argv: argvWithSecrets("/usr/bin/curl"), cwd: ws, timeoutMs: 1000 }]
        ];
        for (const [tool, args] of cases) {
          const held = await issue(ctx, tool, args);
          expect(held.statusCode, `${tool}: ${held.body}`).toBe(409);
          const detail = await ctx.app.inject({
            method: "GET",
            url: `/work-items/${held.json().workItemId}`,
            headers: { authorization: `Bearer ${OP_TOKEN}` }
          });
          const item = detail.json().workItem;
          for (const [surface, text] of Object.entries({
            challenge: held.body,
            title: item.title,
            intent: item.intent,
            params: JSON.stringify(item.requestedActions)
          })) {
            for (const secret of secrets) expect(text, `${tool} ${surface}`).not.toContain(secret);
          }
          expect(held.json().approvalSummary.argv[0]).toBe("/usr/bin/curl");
          expect(held.json().approvalSummary.invocationHash).toBe(jaceCommanderInvocationHash(tool, args));
          if (tool === "privileged_exec") expect(item.title.startsWith("ROOT: /usr/bin/curl ")).toBe(true);
        }
      },
      true,
      (root) => {
        const dir = join(root, "workspace");
        mkdirSync(dir, { recursive: true });
        return [dir];
      }
    ));
});
