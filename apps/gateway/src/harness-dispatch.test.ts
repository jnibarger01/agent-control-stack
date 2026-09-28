import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutionScheduler } from "@agent-control-stack/desktop-commander-adapter";
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

async function buildTestGateway(
  dbName = "control.db",
  desktopCommanderScheduler?: ExecutionScheduler,
  existing?: Pick<TestContext, "root" | "keys">
): Promise<TestContext> {
  const root = existing?.root ?? realpathSync(mkdtempSync(join(tmpdir(), "acs-harness-dispatch-")));
  const keys = existing?.keys ?? generateKeys();
  const app = buildGateway({
    dbPath: join(root, dbName),
    logger: false,
    auth: { token: "", actor: "user", actorId: testAuth.actorId, credentials },
    desktopCommanderCapability: signingConfig(keys),
    desktopCommanderContainment: { allowedRoots: [root], deniedRoots: [] },
    ...(desktopCommanderScheduler ? { desktopCommanderScheduler } : {})
  });
  return { root, keys, app };
}

const AUTH = { authorization: `Bearer ${testAuth.token}` };
const BRIDGE_AUTH = { authorization: `Bearer ${WORKER_TOKEN}` };

async function attestRuntime(ctx: TestContext): Promise<void> {
  const bootstrap = await ctx.app.inject({
    method: "POST",
    url: "/dc/runtime/bootstrap",
    headers: BRIDGE_AUTH,
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

/** The canonical attempt-bound idempotency key the result contract requires. */
function attemptResultIdempotencyKey(attemptId: string): string {
  // stableHash({ domain: "acs.attempt-result.v1", attemptId }): canonical JSON
  // is key-sorted, so attemptId precedes domain.
  return createHash("sha256").update(`{"attemptId":"${attemptId}","domain":"acs.attempt-result.v1"}`).digest("hex");
}

const OTHER_OPERATOR = { authorization: "Bearer other-op-token" };
credentials.push({
  id: "other-op",
  token: "other-op-token",
  actor: "user",
  actorId: "other-user",
  roles: ["operator"],
  scopes: ["acs:read", "acs:write", "acs:approve"]
});

const HARNESS_ONLY = { authorization: "Bearer harness-only-token" };
credentials.push({
  id: "strands-harness",
  token: "harness-only-token",
  actor: "agent",
  actorId: "strands-harness",
  roles: ["service"],
  scopes: ["acs:read", "acs:write"]
});

const SESSION = "0f9c2d1e-5b4a-4c3d-8e7f-112233445566";

function harness(
  app: TestContext["app"],
  url: string,
  invocationId: string,
  tool: string,
  args: Record<string, unknown>,
  headers: Record<string, string> = AUTH
) {
  return app.inject({
    method: "POST",
    url,
    headers,
    payload: { sessionId: SESSION, invocationId, tool, arguments: args }
  });
}

function bridgeIssue(
  app: TestContext["app"],
  job: { workItemId?: string; actor: string; tool: string; arguments: unknown }
) {
  return app.inject({
    method: "POST",
    url: "/dc/capability/issue",
    headers: { ...BRIDGE_AUTH, "x-dc-actor": job.actor },
    payload: {
      client_id: "acs-strands-harness",
      tool: job.tool,
      argsSummary: JSON.stringify(job.arguments),
      ...(job.workItemId ? { workItemId: job.workItemId } : {})
    }
  });
}

async function submitResult(app: TestContext["app"], issued: Record<string, any>, stdout: string) {
  const now = new Date().toISOString();
  return app.inject({
    method: "POST",
    url: `/work-items/${issued.workItemId}/results`,
    headers: BRIDGE_AUTH,
    payload: {
      workItemId: issued.workItemId,
      attemptId: issued.attemptId,
      leaseId: issued.leaseId,
      workerId: issued.workerId,
      actionHash: issued.claimActionHash,
      planHash: issued.planHash,
      inputHash: issued.inputHash,
      fencingEpoch: issued.leaseEpoch,
      idempotencyKey: attemptResultIdempotencyKey(issued.attemptId),
      outcome: "succeeded",
      startedAt: now,
      finishedAt: now,
      summary: stdout.slice(0, 2000),
      stdout,
      simulationMetadata: {
        executionMode: "desktop_commander",
        simulated: false,
        backend: "desktop-commander-mcp",
        toolName: issued.capability.payload.toolName,
        invocationFingerprint: issued.capability.payload.invocationHash,
        requestId: issued.attemptId
      }
    }
  });
}

async function withGateway(run: (ctx: TestContext) => Promise<void>) {
  const ctx = await buildTestGateway();
  try {
    await attestRuntime(ctx);
    await run(ctx);
  } finally {
    await ctx.app.close();
    rmSync(ctx.root, { recursive: true, force: true });
  }
}

describe("Strands harness -> managed bridge dispatch", () => {
  it("creates one idempotent DC-shaped item with harness correlation and no persisted raw arguments", async () => {
    await withGateway(async (ctx) => {
      const args = { path: join(ctx.root, "out.txt"), content: "secret-content" };
      const first = await harness(ctx.app, "/harness/dc-invocations", "call-1", "write_file", args);
      expect(first.statusCode).toBe(201);
      expect(first.json()).toMatchObject({ status: "needs_approval", correlationId: `strands:${SESSION}:call-1` });
      const retry = await harness(ctx.app, "/harness/dc-invocations", "call-1", "write_file", args);
      expect(retry.statusCode).toBe(200);
      expect(retry.json().workItemId).toBe(first.json().workItemId);
      const changed = await harness(ctx.app, "/harness/dc-invocations", "call-1", "write_file", {
        ...args,
        content: "x"
      });
      expect(changed.statusCode).toBe(409);
      expect(changed.json().code).toBe("invocation_binding_mismatch");

      const detail = await ctx.app.inject({
        method: "GET",
        url: `/work-items/${first.json().workItemId}`,
        headers: AUTH
      });
      const item = detail.json().workItem;
      expect(item.requesterSubject).toMatch(/^strands:[a-f0-9]{48}$/);
      expect(item.metadata.correlationId).toBe(`strands:${SESSION}:call-1`);
      expect(item.requestedActions[0].params.bindingHash).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(item)).not.toContain("secret-content");
      expect(JSON.stringify(item)).not.toContain('"arguments"');
    });
  });

  it("pauses on approval, then executes the approved item exactly once through bridge issuance", async () => {
    await withGateway(async (ctx) => {
      const args = { path: join(ctx.root, "smoke.txt"), content: "hello" };
      const created = (await harness(ctx.app, "/harness/dc-invocations", "w1", "write_file", args)).json();
      const dispatchUrl = `/harness/dc-invocations/${created.workItemId}/dispatch`;

      const early = await harness(ctx.app, dispatchUrl, "w1", "write_file", args);
      expect(early.statusCode).toBe(409);
      expect(early.json().code).toBe("require_approval");
      expect((await ctx.app.inject({ method: "POST", url: "/dc/harness/next", headers: BRIDGE_AUTH })).statusCode).toBe(
        204
      );

      // The harness cannot approve; an operator does, through ACS's own endpoint.
      const pending = await bridgeIssue(ctx.app, {
        workItemId: created.workItemId,
        actor: (await ctx.app.inject({ method: "GET", url: `/work-items/${created.workItemId}`, headers: AUTH })).json()
          .workItem.requesterSubject,
        tool: "write_file",
        arguments: args
      });
      expect(pending.statusCode).toBe(409);
      expect(pending.json().decision).toBe("require_approval");
      const approval = await ctx.app.inject({
        method: "POST",
        url: `/work-items/${created.workItemId}/approve`,
        headers: AUTH,
        payload: { actionHash: pending.json().actionHash, reason: "operator approved harness write" }
      });
      expect(approval.statusCode).toBe(200);

      expect((await harness(ctx.app, dispatchUrl, "w1", "write_file", args)).statusCode).toBe(202);
      expect((await harness(ctx.app, dispatchUrl, "w1", "write_file", args)).statusCode).toBe(202); // idempotent

      const next = await ctx.app.inject({ method: "POST", url: "/dc/harness/next", headers: BRIDGE_AUTH });
      expect(next.statusCode).toBe(200);
      const job = next.json();
      expect(job).toMatchObject({ workItemId: created.workItemId, tool: "write_file", arguments: args });
      expect((await ctx.app.inject({ method: "POST", url: "/dc/harness/next", headers: BRIDGE_AUTH })).statusCode).toBe(
        204
      );

      const issued = await bridgeIssue(ctx.app, job);
      expect(issued.statusCode).toBe(200);
      expect(issued.json().workItemId).toBe(created.workItemId);
      expect(issued.json().capability.payload.workItemId).toBe(created.workItemId);

      // A replayed dispatch/issue for the running item can never mint a second capability.
      const again = await harness(ctx.app, dispatchUrl, "w1", "write_file", args);
      expect(again.statusCode).toBe(409);
      expect((await bridgeIssue(ctx.app, job)).statusCode).toBe(409);

      expect((await submitResult(ctx.app, issued.json(), "wrote 5 bytes")).statusCode).toBe(201);
      const result = await ctx.app.inject({
        method: "GET",
        url: `/work-items/${created.workItemId}/execution-result`,
        headers: AUTH
      });
      expect(result.json().code ?? "ok").toBe("ok");
      expect(result.statusCode).toBe(200);
      expect(result.json()).toMatchObject({
        workItemId: created.workItemId,
        toolName: "write_file",
        output: "wrote 5 bytes",
        executionMode: "desktop_commander"
      });
      expect(result.json().audit.capabilityEventId).toBeTruthy();
    });
  });

  it("dispatches an auto-approved read without human approval", async () => {
    await withGateway(async (ctx) => {
      writeFileSync(join(ctx.root, "a.txt"), "x");
      const args = { path: ctx.root };
      const created = await harness(ctx.app, "/harness/dc-invocations", "r1", "list_directory", args);
      expect(created.statusCode).toBe(201);
      const workItemId = created.json().workItemId;
      const dispatched = await harness(
        ctx.app,
        `/harness/dc-invocations/${workItemId}/dispatch`,
        "r1",
        "list_directory",
        args
      );
      expect(dispatched.statusCode).toBe(202);
      const job = (await ctx.app.inject({ method: "POST", url: "/dc/harness/next", headers: BRIDGE_AUTH })).json();
      const issued = await bridgeIssue(ctx.app, job);
      expect(issued.statusCode).toBe(200);
      expect(issued.json().workItemId).toBe(workItemId);
    });
  });

  it("fails closed on identity, binding and routing mismatches", async () => {
    await withGateway(async (ctx) => {
      const args = { path: ctx.root };
      const created = (await harness(ctx.app, "/harness/dc-invocations", "r2", "list_directory", args)).json();
      const dispatchUrl = `/harness/dc-invocations/${created.workItemId}/dispatch`;
      const actor = (
        await ctx.app.inject({ method: "GET", url: `/work-items/${created.workItemId}`, headers: AUTH })
      ).json().workItem.requesterSubject;

      // Another operator cannot dispatch someone else's invocation.
      expect((await harness(ctx.app, dispatchUrl, "r2", "list_directory", args, OTHER_OPERATOR)).statusCode).toBe(404);
      // Changed arguments do not match the recorded binding.
      const changed = await harness(ctx.app, dispatchUrl, "r2", "list_directory", { path: join(ctx.root, "sub") });
      expect(changed.statusCode).toBe(409);
      // Least privilege: tools outside the harness surface are refused before policy.
      const shell = await harness(ctx.app, "/harness/dc-invocations", "p1", "start_process", { command: "id" });
      expect(shell.statusCode).toBe(403);
      expect(shell.json().code).toBe("harness_tool_not_allowed");
      // A write-only credential cannot switch ACS into auto-approval.
      const escalate = await ctx.app.inject({
        method: "POST",
        url: "/execution-mode",
        headers: HARNESS_ONLY,
        payload: { mode: "admin", reason: "self-approve" }
      });
      expect(escalate.statusCode).toBe(403);
      const mode = await ctx.app.inject({ method: "GET", url: "/execution-mode", headers: AUTH });
      expect(mode.json().executionMode).toBe("strict");
      // Only the managed bridge may pull work.
      expect((await ctx.app.inject({ method: "POST", url: "/dc/harness/next", headers: AUTH })).statusCode).toBe(403);
      // A harness subject can never create a new DC item via issuance...
      const unbound = await bridgeIssue(ctx.app, { actor, tool: "list_directory", arguments: args });
      expect(unbound.statusCode).toBe(409);
      expect(unbound.json().code).toBe("harness_binding_mismatch");
      // ...and a normal client can never target an item by id.
      const hijack = await bridgeIssue(ctx.app, {
        workItemId: created.workItemId,
        actor: "chatgpt:jacen",
        tool: "list_directory",
        arguments: args
      });
      expect(hijack.statusCode).toBe(409);
      // Different arguments under the right subject do not bind.
      const wrongArgs = await bridgeIssue(ctx.app, {
        workItemId: created.workItemId,
        actor,
        tool: "list_directory",
        arguments: { path: join(ctx.root, "other") }
      });
      expect(wrongArgs.statusCode).toBe(409);
      const detail = await ctx.app.inject({ method: "GET", url: `/work-items/${created.workItemId}`, headers: AUTH });
      expect(detail.json().workItem.status).not.toBe("running");
    });
  });
});
