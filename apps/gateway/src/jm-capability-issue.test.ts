import { generateKeyPairSync, createPublicKey, verify } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { strictCanonicalJsonV1 } from "@agent-control-stack/shared";
import { jaceMemRuntimeConfigFingerprint, jaceMemVerificationKey } from "@agent-control-stack/jace-mem-issuer";
import { buildGateway, type GatewayCredential } from "./server.js";

const subject = {
  principal: "owner",
  agent: "agent-a",
  project: "project",
  worktree: "/synthetic/tree",
  invocation: "launch-1"
};
const credentials: GatewayCredential[] = [
  {
    id: "bridge",
    token: "synthetic-jm-bridge",
    actor: "agent",
    actorId: "acs-jm-bridge",
    roles: ["service", "worker"],
    scopes: ["acs:read", "acs:write", "acs:worker"]
  },
  {
    id: "other",
    token: "synthetic-dc-bridge",
    actor: "agent",
    actorId: "acs-dc-bridge",
    roles: ["service", "worker"],
    scopes: ["acs:read", "acs:write", "acs:worker"]
  },
  {
    id: "human",
    token: "synthetic-human",
    actor: "user",
    actorId: "human",
    roles: ["operator"],
    scopes: ["acs:read", "acs:write", "acs:approve", "acs:execution-mode:admin"]
  },
  {
    id: "self",
    token: "synthetic-self",
    actor: "user",
    actorId: subject.agent,
    roles: ["operator"],
    scopes: ["acs:read", "acs:write", "acs:approve"]
  }
];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function gateway(configured = true) {
  const root = mkdtempSync(join(tmpdir(), "acs-jm-route-"));
  const dbPath = join(root, "control.db");
  const pair = generateKeyPairSync("ed25519");
  const config = {
    runtimeId: "jm-runtime",
    keyId: "jm-key",
    privateKey: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url")
  };
  const app = buildGateway({
    dbPath,
    logger: false,
    auth: { token: "", actor: "user", credentials },
    jaceMemCapability: configured ? config : false,
    jaceMemLaunches: [{ launchId: "launch-1", runtimeId: config.runtimeId, subject }]
  });
  cleanups.push(async () => {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { app, dbPath, pair, config };
}
function post(
  ctx: { app: ReturnType<typeof buildGateway> },
  url: string,
  payload: unknown,
  token = "synthetic-jm-bridge"
) {
  return ctx.app.inject({
    method: "POST",
    url,
    headers: { authorization: `Bearer ${token}` },
    payload: payload as Record<string, unknown>
  });
}
/** What a correctly configured Jace-Mem process echoes: the bootstrap object, unchanged. */
async function attest(ctx: ReturnType<typeof gateway>, mutate: (identity: Record<string, unknown>) => void = () => {}) {
  const started = await post(ctx, "/jm/runtime/bootstrap", { launchId: "launch-1" });
  expect(started.statusCode).toBe(201);
  const { expiresAt, ...bootstrap } = started.json();
  expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now());
  const identity = structuredClone(bootstrap);
  mutate(identity);
  return {
    bootstrap,
    response: await post(ctx, "/jm/runtime/bootstrap/complete", { launchId: "launch-1", runtimeIdentity: identity })
  };
}
async function attested(configured = true) {
  const ctx = gateway(configured);
  if (configured) expect((await attest(ctx)).response.statusCode).toBe(200);
  return ctx;
}
type Ctx = ReturnType<typeof gateway>;
function issue(
  ctx: Ctx,
  tool = "memory_status",
  args: Record<string, unknown> = {},
  extra = {},
  token = "synthetic-jm-bridge"
) {
  return ctx.app.inject({
    method: "POST",
    url: "/jm/capability/issue",
    headers: { authorization: `Bearer ${token}` },
    payload: { launchId: "launch-1", tool, arguments: args, ...extra }
  });
}
function approve(ctx: Ctx, pending: { workItemId: string; actionHash: string }, token = "synthetic-human") {
  return ctx.app.inject({
    method: "POST",
    url: `/work-items/${pending.workItemId}/approve`,
    headers: { authorization: `Bearer ${token}` },
    payload: { actionHash: pending.actionHash, reason: "Approve synthetic exact memory call" }
  });
}

describe("POST /jm/capability/issue", () => {
  it.each([undefined, "invalid", "synthetic-human", "synthetic-dc-bridge"])(
    "rejects missing/wrong bridge identity %s without creating work",
    async (token) => {
      const ctx = gateway();
      const response = await ctx.app.inject({
        method: "POST",
        url: "/jm/capability/issue",
        headers: token ? { authorization: `Bearer ${token}` } : {},
        payload: { launchId: "launch-1", tool: "memory_status", arguments: {} }
      });
      expect([401, 403]).toContain(response.statusCode);
      const db = new DatabaseSync(ctx.dbPath);
      try {
        expect(db.prepare("SELECT count(*) AS n FROM work_items").get()?.n).toBe(0);
      } finally {
        db.close();
      }
    }
  );
  it("fails closed when signing is disabled", async () => {
    const ctx = gateway(false);
    expect((await issue(ctx)).statusCode).toBe(503);
    expect((await post(ctx, "/jm/runtime/bootstrap", { launchId: "launch-1" })).statusCode).toBe(503);
  });
  it.each([
    { launchId: "unknown" },
    { subject: { ...subject, agent: "other" } },
    { workerId: "acs-jm-bridge" },
    { approvalId: "forged" }
  ])("rejects unknown launch or injected authority %j", async (extra) => {
    expect([400, 403]).toContain((await issue(await attested(), "memory_status", {}, extra)).statusCode);
  });
  it("issues a signed subject-bound capability only after durable issuance and lease evidence", async () => {
    const ctx = await attested();
    const response = await issue(ctx);
    expect(response.statusCode).toBe(200);
    const { capability, workerId } = response.json();
    expect(workerId).toBe("acs-jm-bridge");
    expect(capability.payload.subject).toEqual(subject);
    expect(
      verify(
        null,
        Buffer.from(strictCanonicalJsonV1(capability.payload)),
        createPublicKey(ctx.pair.privateKey),
        Buffer.from(capability.signature, "base64url")
      )
    ).toBe(true);
    const db = new DatabaseSync(ctx.dbPath);
    try {
      expect(
        db
          .prepare("SELECT count(*) AS n FROM jace_mem_capability_issuances WHERE lease_id = ?")
          .get(capability.payload.leaseId)?.n
      ).toBe(1);
      expect(JSON.stringify(db.prepare("SELECT * FROM audit_events").all())).not.toContain(capability.signature);
    } finally {
      db.close();
    }
  });
  it.each([
    ["memory_delete", { id: "synthetic-id" }],
    ["memory_search_shared", { targetAgent: "agent-b", query: "synthetic" }]
  ] as const)("requires independent human approval for %s then consumes it once", async (tool, args) => {
    const ctx = await attested();
    const pending = await issue(ctx, tool, args);
    expect(pending.statusCode).toBe(409);
    const again = await issue(ctx, tool, args);
    expect(again.json().workItemId).toBe(pending.json().workItemId);
    expect((await approve(ctx, pending.json(), "synthetic-self")).statusCode).toBe(403);
    expect((await approve(ctx, pending.json())).statusCode).toBe(200);
    const allowed = await issue(ctx, tool, args);
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().capability.payload.approvalId).toBeTruthy();
    const replay = await issue(ctx, tool, args);
    expect(replay.statusCode).toBe(409);
    expect(replay.json().workItemId).not.toBe(pending.json().workItemId);
  });
  it("does not auto-approve deletion in canonical admin mode", async () => {
    const ctx = await attested();
    const mode = await ctx.app.inject({
      method: "POST",
      url: "/execution-mode",
      headers: { authorization: "Bearer synthetic-human" },
      payload: { mode: "admin", reason: "Synthetic test of human-only JM approval" }
    });
    expect(mode.statusCode).toBe(200);
    expect((await issue(ctx, "memory_delete", { id: "synthetic" })).statusCode).toBe(409);
  });
  it.each([
    ["unknown", {}],
    ["memory_status", { principal: "override" }],
    ["memory_search_shared", { targetAgent: subject.agent, query: "x" }]
  ] as const)("rejects invalid invocation %s", async (tool, args) => {
    expect([400, 403]).toContain((await issue(await attested(), tool, args)).statusCode);
  });
});

describe("JM-ACS-02 runtime identity exchange", () => {
  it("refuses issuance until the launch's Jace-Mem process has attested", async () => {
    const ctx = gateway();
    const refused = await issue(ctx);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().code).toBe("jace_mem_launch_unattested");
    expect((await attest(ctx)).response.statusCode).toBe(200);
    expect((await issue(ctx)).statusCode).toBe(200);
  });

  it("sends the trusted subject and ACS's own config fingerprint, never caller-chosen values", async () => {
    const ctx = gateway();
    const { bootstrap } = await attest(ctx);
    expect(bootstrap).toEqual({
      schemaVersion: 1,
      runtimeId: ctx.config.runtimeId,
      launchId: "launch-1",
      challenge: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
      subject,
      configFingerprint: jaceMemRuntimeConfigFingerprint({
        keyId: ctx.config.keyId,
        publicKey: jaceMemVerificationKey(ctx.config),
        runtimeId: ctx.config.runtimeId
      })
    });
    for (const extra of [{ subject }, { runtimeId: "other" }]) {
      expect((await post(ctx, "/jm/runtime/bootstrap", { launchId: "launch-1", ...extra })).statusCode).toBe(400);
    }
    expect((await post(ctx, "/jm/runtime/bootstrap", { launchId: "unknown" })).statusCode).toBe(403);
  });

  it.each([undefined, "synthetic-dc-bridge", "synthetic-human"])(
    "only the dedicated bridge can run the exchange (%s)",
    async (token) => {
      const ctx = gateway();
      const response = await ctx.app.inject({
        method: "POST",
        url: "/jm/runtime/bootstrap",
        headers: token ? { authorization: `Bearer ${token}` } : {},
        payload: { launchId: "launch-1" }
      });
      expect([401, 403]).toContain(response.statusCode);
    }
  );

  it.each([
    [
      "another agent",
      (identity: Record<string, unknown>) => {
        (identity.subject as Record<string, string>).agent = "agent-b";
      },
      "jace_mem_runtime_attestation_rejected"
    ],
    [
      "another worktree",
      (identity: Record<string, unknown>) => {
        (identity.subject as Record<string, string>).worktree = "/synthetic/other";
      },
      "jace_mem_runtime_attestation_rejected"
    ],
    [
      "another runtime",
      (identity: Record<string, unknown>) => {
        identity.runtimeId = "other-runtime";
      },
      "jace_mem_runtime_attestation_rejected"
    ],
    [
      "another verification key",
      (identity: Record<string, unknown>) => {
        identity.configFingerprint = "0".repeat(64);
      },
      "jace_mem_runtime_attestation_rejected"
    ],
    [
      "another launch",
      (identity: Record<string, unknown>) => {
        identity.launchId = "launch-2";
      },
      "jace_mem_runtime_attestation_rejected"
    ],
    [
      "an unknown challenge",
      (identity: Record<string, unknown>) => {
        identity.challenge = "A".repeat(43);
      },
      "jace_mem_runtime_attestation_rejected"
    ],
    [
      "an extra field",
      (identity: Record<string, unknown>) => {
        identity.role = "admin";
      },
      "jace_mem_runtime_identity_invalid"
    ],
    [
      "a missing field",
      (identity: Record<string, unknown>) => {
        delete identity.configFingerprint;
      },
      "jace_mem_runtime_identity_invalid"
    ],
    [
      "schema version 2",
      (identity: Record<string, unknown>) => {
        identity.schemaVersion = 2;
      },
      "jace_mem_runtime_identity_invalid"
    ]
  ])("rejects an echoed identity with %s and leaves the launch unattested", async (_label, mutate, code) => {
    const ctx = gateway();
    const { response } = await attest(ctx, mutate);
    expect([400, 403]).toContain(response.statusCode);
    expect(response.json().code).toBe(code);
    expect((await issue(ctx)).json().code).toBe("jace_mem_launch_unattested");
  });

  it("a challenge attests at most once", async () => {
    const ctx = gateway();
    const { bootstrap, response } = await attest(ctx);
    expect(response.statusCode).toBe(200);
    const replay = await post(ctx, "/jm/runtime/bootstrap/complete", {
      launchId: "launch-1",
      runtimeIdentity: bootstrap
    });
    expect(replay.statusCode).toBe(403);
    expect(replay.json().code).toBe("jace_mem_runtime_attestation_rejected");
    const db = new DatabaseSync(ctx.dbPath);
    try {
      expect(db.prepare("SELECT count(*) AS n FROM jace_mem_launch_attestations").get()?.n).toBe(1);
      expect(JSON.stringify(db.prepare("SELECT * FROM jace_mem_launch_challenges").all())).not.toContain(
        bootstrap.challenge
      );
      expect(() => db.prepare("UPDATE jace_mem_launch_challenges SET consumed_at = NULL").run()).toThrow(
        /at most once/u
      );
      expect(() => db.prepare("DELETE FROM jace_mem_launch_attestations").run()).toThrow(/append-only/u);
    } finally {
      db.close();
    }
  });

  it("a gateway restarted with another signing key does not inherit the old attestation", async () => {
    const root = mkdtempSync(join(tmpdir(), "acs-jm-rekey-"));
    const dbPath = join(root, "control.db");
    const build = () => {
      const pair = generateKeyPairSync("ed25519");
      return buildGateway({
        dbPath,
        logger: false,
        auth: { token: "", actor: "user", credentials },
        jaceMemCapability: {
          runtimeId: "jm-runtime",
          keyId: "jm-key",
          privateKey: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url")
        },
        jaceMemLaunches: [{ launchId: "launch-1", runtimeId: "jm-runtime", subject }]
      });
    };
    try {
      const first = build();
      const started = (await post({ app: first }, "/jm/runtime/bootstrap", { launchId: "launch-1" })).json();
      const { expiresAt: _expiresAt, ...identity } = started;
      expect(
        (
          await post({ app: first }, "/jm/runtime/bootstrap/complete", {
            launchId: "launch-1",
            runtimeIdentity: identity
          })
        ).statusCode
      ).toBe(200);
      await first.close();
      const second = build();
      const refused = await post({ app: second }, "/jm/capability/issue", {
        launchId: "launch-1",
        tool: "memory_status",
        arguments: {}
      });
      expect(refused.json().code).toBe("jace_mem_launch_unattested");
      await second.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
