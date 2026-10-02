import { createHash, generateKeyPairSync } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ExecutionAdmissionScheduler,
  type ExecutionAdmissionController
} from "@agent-control-stack/execution-admission";
import { describe, expect, it, vi } from "vitest";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { ShutdownController } from "./lifecycle.js";
import { buildGateway, type GatewayCredential } from "./server.js";

const OP_TOKEN = "op-token";
const DC_TOKEN = "dc-token";
const JC_TOKEN = "jc-token";
const DC_RUNTIME = "dc-admission-runtime";
const FINGERPRINT = "a".repeat(64);
const SCOPES = ["fs.read", "fs.write", "process.exec", "process.spawn"];

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
    id: "dc",
    token: DC_TOKEN,
    actor: "agent",
    actorId: "acs-dc-bridge",
    roles: ["service", "worker"],
    scopes: ["acs:read", "acs:write", "acs:worker"]
  },
  {
    id: "jc",
    token: JC_TOKEN,
    actor: "agent",
    actorId: "acs-jc-bridge",
    roles: ["service", "worker"],
    scopes: ["acs:read", "acs:write", "acs:worker"]
  }
];

function privateKey(): string {
  return generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url");
}

function attemptResultIdempotencyKey(attemptId: string): string {
  return createHash("sha256").update(`{"attemptId":"${attemptId}","domain":"acs.attempt-result.v1"}`).digest("hex");
}

function createGateway(
  root: string,
  executionAdmission: ExecutionAdmissionController,
  shutdownController?: ShutdownController
) {
  const dbPath = join(root, "control.db");
  const app = buildGateway({
    dbPath,
    logger: false,
    auth: { token: "", actor: "user", actorId: "user", credentials },
    executionAdmission,
<<<<<<< Updated upstream
    shutdownController,
=======
    ...(shutdownController ? { shutdownController } : {}),
>>>>>>> Stashed changes
    desktopCommanderCapability: {
      runtimeId: DC_RUNTIME,
      keyId: "dc-admission-key",
      privateKey: privateKey(),
      ttlMs: 29_000,
      identityConfigFingerprint: FINGERPRINT,
      runtimeScopes: SCOPES
    },
    desktopCommanderContainment: { allowedRoots: [root], deniedRoots: [] },
    jaceCommanderCapability: {
      runtimeId: "jc-admission-runtime",
      keyId: "jc-admission-key",
      privateKey: privateKey(),
      ttlMs: 29_000
    },
    readManagedAuthority: () => ({
      authorityOwner: "managed:test",
      authoritative: true,
      leaseActive: true,
      leaseAmbiguous: false,
      breakGlassActive: false,
      breakGlassAmbiguous: false,
      multipleAuthoritativeExecutors: false,
      managedRuntime: true,
      detail: "test"
    }),
    jaceCommanderContainment: false
  });
  return { dbPath, app };
}

function buildFixture(input?: { scheduler?: ExecutionAdmissionScheduler; shutdownController?: ShutdownController }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "acs-admission-gateway-")));
  const scheduler =
    input?.scheduler ??
    new ExecutionAdmissionScheduler({
      config: {
        executionMaxInflight: 1,
        executorMaxInflight: 1,
        queueMax: 4,
        queueTimeoutMs: 2_000,
        waitMaxInflight: 1
      }
    });
  const { dbPath, app } = createGateway(root, scheduler, input?.shutdownController);
  return { root, dbPath, scheduler, app };
}

async function attestDc(app: ReturnType<typeof buildGateway>): Promise<void> {
  const headers = { authorization: `Bearer ${DC_TOKEN}` };
  const bootstrap = await app.inject({
    method: "POST",
    url: "/dc/runtime/bootstrap",
    headers,
    payload: {
      runtimeId: DC_RUNTIME,
      identityConfigFingerprint: FINGERPRINT,
      scopes: SCOPES
    }
  });
  expect(bootstrap.statusCode).toBe(201);
  const challenge = bootstrap.json().challenge;
  const complete = await app.inject({
    method: "POST",
    url: "/dc/runtime/bootstrap/complete",
    headers,
    payload: {
      runtimeId: DC_RUNTIME,
      identityConfigFingerprint: FINGERPRINT,
      scopes: SCOPES,
      challenge,
      runtimeIdentity: { schemaVersion: 1, runtimeId: DC_RUNTIME, challenge, scopes: SCOPES }
    }
  });
  expect(complete.statusCode).toBe(204);
}

function issueDc(app: ReturnType<typeof buildGateway>, root: string) {
  return app.inject({
    method: "POST",
    url: "/dc/capability/issue",
    headers: { authorization: `Bearer ${DC_TOKEN}`, "x-dc-actor": "chatgpt:a" },
    payload: {
      client_id: "client-a",
      tool: "read_file",
      argsSummary: JSON.stringify({ path: join(root, "read.txt") })
    }
  });
}

function issueJcTool(
  app: ReturnType<typeof buildGateway>,
  tool: string,
  args: Record<string, unknown>,
  actor = "chatgpt:b",
  clientId = "client-b"
) {
  return app.inject({
    method: "POST",
    url: "/jc/capability/issue",
    headers: { authorization: `Bearer ${JC_TOKEN}`, "x-jc-actor": actor },
    payload: {
      client_id: clientId,
      tool,
      argsSummary: JSON.stringify(args)
    }
  });
}

function issueJc(app: ReturnType<typeof buildGateway>, actor = "chatgpt:b", clientId = "client-b") {
  return issueJcTool(app, "acs_read", { view: "health" }, actor, clientId);
}

function authorityCounts(dbPath: string): { attempts: number; activeLeases: number } {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const attempts = Number((db.prepare("SELECT COUNT(*) AS n FROM execution_attempts").get() as { n: number }).n);
    const activeLeases = Number(
      (db.prepare("SELECT COUNT(*) AS n FROM attempt_leases WHERE status = 'active'").get() as { n: number }).n
    );
    return { attempts, activeLeases };
  } finally {
    db.close();
  }
}

async function holdPermit(scheduler: ExecutionAdmissionScheduler, executorId: string) {
  return scheduler.acquire({
    requestId: `hold-${executorId}`,
    lane: executorId.startsWith("acs-jc") ? "jc" : "dc",
    executorId,
    actorId: "hold",
    toolName: "read_file",
    executionClass: "execution",
    enqueuedAt: Date.now(),
    deadlineAt: Date.now() + 10_000,
    signal: new AbortController().signal
  });
}

async function submitDcResult(app: ReturnType<typeof buildGateway>, body: Record<string, any>) {
  const now = new Date().toISOString();
  return app.inject({
    method: "POST",
    url: `/work-items/${body.workItemId}/results`,
    headers: { authorization: `Bearer ${DC_TOKEN}` },
    payload: {
      workItemId: body.workItemId,
      attemptId: body.attemptId,
      leaseId: body.leaseId,
      workerId: body.workerId,
      actionHash: body.claimActionHash,
      planHash: body.planHash,
      inputHash: body.inputHash,
      fencingEpoch: body.leaseEpoch,
      idempotencyKey: attemptResultIdempotencyKey(body.attemptId),
      outcome: "succeeded",
      startedAt: now,
      finishedAt: now,
      summary: "done",
      structuredOutput: {},
      artifacts: [],
      simulationMetadata: {
        executionMode: "desktop_commander",
        simulated: false,
        backend: "desktop-commander-mcp",
        toolName: body.capability.payload.toolName,
        invocationFingerprint: body.invocationHash,
        requestId: body.attemptId
      }
    }
  });
}

async function submitJcResult(app: ReturnType<typeof buildGateway>, body: Record<string, any>, summary = "done") {
  const now = new Date().toISOString();
  return app.inject({
    method: "POST",
    url: `/work-items/${body.workItemId}/results`,
    headers: { authorization: `Bearer ${JC_TOKEN}` },
    payload: {
      workItemId: body.workItemId,
      attemptId: body.attemptId,
      leaseId: body.leaseId,
      workerId: body.workerId,
      actionHash: body.claimActionHash,
      planHash: body.planHash,
      inputHash: body.inputHash,
      fencingEpoch: body.leaseEpoch,
      idempotencyKey: attemptResultIdempotencyKey(body.attemptId),
      outcome: "succeeded",
      startedAt: now,
      finishedAt: now,
      summary,
      structuredOutput: {},
      artifacts: [],
      simulationMetadata: {
        executionMode: "jace_commander",
        simulated: false,
        backend: "jace-commander-mcp",
        toolName: body.capability.payload.toolName,
        invocationFingerprint: body.invocationHash,
        requestId: body.attemptId
      }
    }
  });
}

describe("gateway execution admission integration", () => {
<<<<<<< Updated upstream
  it("fences an orphaned active bridge lease and recovers readiness without operator action", async () => {
    const ctx = buildFixture();
    try {
      await attestDc(ctx.app);
      const issued = await issueDc(ctx.app, ctx.root);
      expect(issued.statusCode, issued.body).toBe(200);
      const body = issued.json();
      // Capacity is consumed by a live lease whose durable reservation vanished.
      // This is uncountable and unreleasable: reconciliation must converge, not latch.
      const db = new DatabaseSync(ctx.dbPath);
      try {
        db.prepare("DELETE FROM admission_permits").run();
      } finally {
        db.close();
      }
      expect(authorityCounts(ctx.dbPath)).toEqual({ attempts: 1, activeLeases: 1 });

      const before = await ctx.app.inject({ method: "GET", url: "/readyz" });
      expect(before.statusCode).toBe(200);
      expect(before.json().checks.executionAdmission).toBeUndefined();

      // The lease is fenced closed and no longer holds capacity.
      expect(authorityCounts(ctx.dbPath)).toEqual({ attempts: 1, activeLeases: 0 });
      expect(ctx.scheduler.snapshot().global.active).toBe(0);

      const reader = new SqliteWorkItemStore(ctx.dbPath);
      try {
        expect(reader.readEvents({ name: "attempt_lease.fenced_without_admission" })).toHaveLength(1);
        expect(reader.get(body.workItemId)?.status).toBe("blocked");
        expect(reader.get(body.workItemId)?.result?.outcome).toBe("blocked");
        expect(reader.verifyAuditChain().ok).toBe(true);
      } finally {
        reader.close();
      }

      // New admission is available again rather than permanently recovery-blocked.
      const again = await issueDc(ctx.app, ctx.root);
      expect(again.statusCode, again.body).toBe(200);
      const after = await ctx.app.inject({ method: "GET", url: "/readyz" });
      expect(after.statusCode).toBe(200);
    } finally {
=======
  it("fails closed after restart if a managed active lease has no durable admission binding", async () => {
    const ctx = buildFixture();
    let reopened: ReturnType<typeof buildGateway> | undefined;
    try {
      const issued = await issueJc(ctx.app);
      expect(issued.statusCode, issued.body).toBe(200);
      await ctx.app.close();
      const db = new DatabaseSync(ctx.dbPath);
      try {
        db.prepare("DELETE FROM admission_permits WHERE attempt_id = ?").run(issued.json().attemptId);
      } finally {
        db.close();
      }
      const scheduler = new ExecutionAdmissionScheduler();
      reopened = createGateway(ctx.root, scheduler).app;
      const next = await issueJc(reopened, "chatgpt:next", "client-next");
      expect(next.statusCode, next.body).toBe(503);
      expect(next.json()).toMatchObject({ code: "admission_recovery_required" });
      expect(next.json().capability).toBeUndefined();
      expect(authorityCounts(ctx.dbPath)).toEqual({ attempts: 1, activeLeases: 1 });
    } finally {
      await reopened?.close();
>>>>>>> Stashed changes
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

<<<<<<< Updated upstream
  it("never fences a permit-backed lease as an orphan", async () => {
    const ctx = buildFixture();
    try {
      await attestDc(ctx.app);
      expect((await issueDc(ctx.app, ctx.root)).statusCode).toBe(200);
      // Repeated reconciliation must leave a correctly reserved lease untouched.
      for (let probe = 0; probe < 3; probe++)
        expect((await ctx.app.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
      expect(authorityCounts(ctx.dbPath)).toEqual({ attempts: 1, activeLeases: 1 });
      expect(ctx.scheduler.snapshot().global.active).toBe(1);
      const reader = new SqliteWorkItemStore(ctx.dbPath);
      try {
        expect(reader.readEvents({ name: "attempt_lease.fenced_without_admission" })).toHaveLength(0);
      } finally {
        reader.close();
      }
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it("fences an orphan lease at startup so an upgrade cannot brick readiness", async () => {
    const ctx = buildFixture();
    let resumed: ReturnType<typeof buildGateway> | undefined;
    try {
      await attestDc(ctx.app);
      expect((await issueDc(ctx.app, ctx.root)).statusCode).toBe(200);
      await ctx.app.close();
      const db = new DatabaseSync(ctx.dbPath);
      try {
        db.prepare("DELETE FROM admission_permits").run();
      } finally {
        db.close();
      }
      const scheduler = new ExecutionAdmissionScheduler({
        config: {
          executionMaxInflight: 1,
          executorMaxInflight: 1,
          queueMax: 4,
          queueTimeoutMs: 2_000,
          waitMaxInflight: 1
        }
      });
      resumed = createGateway(ctx.root, scheduler).app;
      expect(authorityCounts(ctx.dbPath)).toEqual({ attempts: 1, activeLeases: 0 });
      expect(scheduler.snapshot().global.active).toBe(0);
      const ready = await resumed.inject({ method: "GET", url: "/readyz" });
      expect(ready.statusCode, ready.body).toBe(200);
    } finally {
      await (resumed ?? ctx.app).close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it("releases an orphan permit whose lease already disappeared", async () => {
    const ctx = buildFixture();
    let resumed: ReturnType<typeof buildGateway> | undefined;
    try {
      await attestDc(ctx.app);
      expect((await issueDc(ctx.app, ctx.root)).statusCode).toBe(200);
      await ctx.app.close();
      // Expire the lease through the canonical path; the reservation is then pure
      // garbage and must be released rather than pinning scheduler capacity.
      const expirer = new SqliteWorkItemStore(ctx.dbPath);
      try {
        expect(expirer.failExpiredLeases(new Date(Date.now() + 3_600_000)).length).toBeGreaterThan(0);
      } finally {
        expirer.close();
      }
      const scheduler = new ExecutionAdmissionScheduler({
        config: {
          executionMaxInflight: 1,
          executorMaxInflight: 1,
          queueMax: 4,
          queueTimeoutMs: 2_000,
          waitMaxInflight: 1
        }
      });
      resumed = createGateway(ctx.root, scheduler).app;
      const db2 = new DatabaseSync(ctx.dbPath, { readOnly: true });
      try {
        expect(db2.prepare("SELECT COUNT(*) AS count FROM admission_permits").get()).toEqual({ count: 0 });
      } finally {
        db2.close();
      }
      expect((await resumed.inject({ method: "GET", url: "/readyz" })).statusCode).toBe(200);
    } finally {
      await (resumed ?? ctx.app).close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it("restores execution and wait capacity across a gateway restart", async () => {
    const ctx = buildFixture();
    let resumed: ReturnType<typeof buildGateway> | undefined;
    try {
      await attestDc(ctx.app);
      const execution = await issueDc(ctx.app, ctx.root);
      expect(execution.statusCode).toBe(200);
      const wait = await issueJcTool(
        ctx.app,
        "read_process_output",
        { sessionId: "session-1" },
        "chatgpt:wait",
        "client-wait"
      );
      expect(wait.statusCode).toBe(200);
      await ctx.app.close();
      const scheduler = new ExecutionAdmissionScheduler({
        config: {
          executionMaxInflight: 1,
          executorMaxInflight: 1,
          queueMax: 4,
          queueTimeoutMs: 2_000,
          waitMaxInflight: 1
        }
      });
      resumed = createGateway(ctx.root, scheduler).app;
      expect(scheduler.snapshot().global.active).toBe(1);
      expect(scheduler.snapshot().wait.active).toBe(1);
      expect(authorityCounts(ctx.dbPath)).toEqual({ attempts: 2, activeLeases: 2 });
      expect((await submitDcResult(resumed, execution.json())).statusCode).toBe(201);
      expect((await submitJcResult(resumed, wait.json())).statusCode).toBe(201);
      expect(scheduler.snapshot().global.active).toBe(0);
      expect(scheduler.snapshot().wait.active).toBe(0);
    } finally {
      await (resumed ?? ctx.app).close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it("never treats a live lease that lost its reservation as accounted capacity", async () => {
    const ctx = buildFixture();
    let resumed: ReturnType<typeof buildGateway> | undefined;
    try {
      await attestDc(ctx.app);
      expect((await issueDc(ctx.app, ctx.root)).statusCode).toBe(200);
      await ctx.app.close();
      const db = new DatabaseSync(ctx.dbPath);
      try {
        db.exec("DELETE FROM admission_permits");
      } finally {
        db.close();
      }
      const scheduler = new ExecutionAdmissionScheduler({
        config: {
          executionMaxInflight: 1,
          executorMaxInflight: 1,
          queueMax: 4,
          queueTimeoutMs: 2_000,
          waitMaxInflight: 1
        }
      });
      resumed = createGateway(ctx.root, scheduler).app;
      // The lost reservation is never restored: capacity is not silently reclaimed.
      expect(scheduler.snapshot().global.active).toBe(0);
      expect(authorityCounts(ctx.dbPath)).toEqual({ attempts: 1, activeLeases: 0 });
      // Reconciliation fences the unaccountable lease rather than latching unhealthy.
      const reader = new SqliteWorkItemStore(ctx.dbPath);
      try {
        expect(reader.readEvents({ name: "attempt_lease.fenced_without_admission" })).toHaveLength(1);
      } finally {
        reader.close();
      }
      const ready = await resumed.inject({ method: "GET", url: "/readyz" });
      expect(ready.statusCode, ready.body).toBe(200);
      // And a fresh lease is admitted normally.
      const accepted = await issueJc(resumed);
      expect(accepted.statusCode, accepted.body).toBe(200);
    } finally {
      await (resumed ?? ctx.app).close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it("rolls back the attempt and lease when durable reservation insertion fails", async () => {
    const ctx = buildFixture();
    try {
      await attestDc(ctx.app);
      const db = new DatabaseSync(ctx.dbPath);
      try {
        db.exec(
          "CREATE TRIGGER reject_admission BEFORE INSERT ON admission_permits BEGIN SELECT RAISE(ABORT, 'fixture reservation failure'); END"
        );
      } finally {
        db.close();
      }
      const rejected = await issueDc(ctx.app, ctx.root);
      expect(rejected.statusCode).toBe(500);
=======
  it("rolls back the claim and lease if durable admission binding cannot commit", async () => {
    const ctx = buildFixture();
    try {
      const db = new DatabaseSync(ctx.dbPath);
      try {
        db.exec(`CREATE TRIGGER reject_admission_binding BEFORE INSERT ON admission_permits
          BEGIN SELECT RAISE(ABORT, 'test admission persistence failure'); END`);
      } finally {
        db.close();
      }
      const issued = await issueJc(ctx.app);
      expect(issued.statusCode).toBe(500);
      expect(issued.json().capability).toBeUndefined();
>>>>>>> Stashed changes
      expect(authorityCounts(ctx.dbPath)).toEqual({ attempts: 0, activeLeases: 0 });
      expect(ctx.scheduler.snapshot().global.active).toBe(0);
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

<<<<<<< Updated upstream
  it.each(["execution_class", "worker_id", "action_hash"])(
    "fails closed after restart with a corrupted reservation %s",
    async (column) => {
      const ctx = buildFixture();
      let resumed: ReturnType<typeof buildGateway> | undefined;
      try {
        await attestDc(ctx.app);
        expect((await issueDc(ctx.app, ctx.root)).statusCode).toBe(200);
        await ctx.app.close();
        const db = new DatabaseSync(ctx.dbPath);
        try {
          // Column names come only from this fixed test case list.
          db.prepare(`UPDATE admission_permits SET ${column} = ?`).run(
            column === "execution_class" ? "wait" : "corrupt"
          );
=======
  it.each(["execution", "wait"] as const)(
    "recovers %s capacity after shutdown and releases it only on a canonical result",
    async (executionClass) => {
      const ctx = buildFixture();
      let reopened: ReturnType<typeof buildGateway> | undefined;
      try {
        const issued =
          executionClass === "wait"
            ? await issueJcTool(ctx.app, "read_process_output", { sessionId: "session-recovery" })
            : await issueJc(ctx.app);
        expect(issued.statusCode, issued.body).toBe(200);
        const claim = issued.json();
        await ctx.app.close();

        const db = new DatabaseSync(ctx.dbPath, { readOnly: true });
        try {
          expect(
            db.prepare("SELECT execution_class FROM admission_permits WHERE attempt_id = ?").get(claim.attemptId)
          ).toEqual({ execution_class: executionClass });
>>>>>>> Stashed changes
        } finally {
          db.close();
        }
        const scheduler = new ExecutionAdmissionScheduler({
          config: {
            executionMaxInflight: 1,
            executorMaxInflight: 1,
            queueMax: 4,
            queueTimeoutMs: 2_000,
            waitMaxInflight: 1
          }
        });
<<<<<<< Updated upstream
        resumed = createGateway(ctx.root, scheduler).app;
        const rejected = await issueJc(resumed);
        expect(rejected.statusCode).toBe(503);
        expect(rejected.json()).toMatchObject({ code: "admission_recovery_required" });
        expect(scheduler.snapshot().global.active).toBe(0);
        expect(authorityCounts(ctx.dbPath)).toEqual({ attempts: 1, activeLeases: 1 });
      } finally {
        await (resumed ?? ctx.app).close();
=======
        reopened = createGateway(ctx.root, scheduler).app;
        expect(scheduler.snapshot()).toMatchObject({
          global: { active: executionClass === "execution" ? 1 : 0 },
          wait: { active: executionClass === "wait" ? 1 : 0 }
        });
        const result = await submitJcResult(reopened, claim);
        expect(result.statusCode, result.body).toBe(201);
        expect(scheduler.snapshot()).toMatchObject({ global: { active: 0 }, wait: { active: 0 } });
        const replay = await submitJcResult(reopened, claim, "conflicting result");
        expect(replay.statusCode).toBe(409);
        expect(authorityCounts(ctx.dbPath)).toEqual({ attempts: 1, activeLeases: 0 });
      } finally {
        await reopened?.close();
        await ctx.app.close();
>>>>>>> Stashed changes
        rmSync(ctx.root, { recursive: true, force: true });
      }
    }
  );

<<<<<<< Updated upstream
  it("does not release capacity when a result has the wrong fencing epoch", async () => {
    const ctx = buildFixture();
    try {
      await attestDc(ctx.app);
      const issued = await issueDc(ctx.app, ctx.root);
      expect(issued.statusCode).toBe(200);
      const body = issued.json();
      const rejected = await submitDcResult(ctx.app, { ...body, leaseEpoch: body.leaseEpoch + 1 });
      expect(rejected.statusCode).toBeGreaterThanOrEqual(400);
      expect(ctx.scheduler.snapshot().global.active).toBe(1);
      expect(authorityCounts(ctx.dbPath)).toEqual({ attempts: 1, activeLeases: 1 });
      expect((await submitDcResult(ctx.app, body)).statusCode).toBe(201);
      expect(ctx.scheduler.snapshot().global.active).toBe(0);
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

=======
>>>>>>> Stashed changes
  it("does not claim or create a lease before DC admission, then releases on canonical result", async () => {
    const ctx = buildFixture();
    try {
      await attestDc(ctx.app);
      const hold = await holdPermit(ctx.scheduler, "acs-dc-bridge");
      const pending = issueDc(ctx.app, ctx.root);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(authorityCounts(ctx.dbPath)).toEqual({ attempts: 0, activeLeases: 0 });
      expect(ctx.scheduler.snapshot().global).toMatchObject({ active: 1, queued: 1 });

      hold.release();
      const issued = await pending;
      expect(issued.statusCode).toBe(200);
      expect(authorityCounts(ctx.dbPath)).toEqual({ attempts: 1, activeLeases: 1 });
      expect(ctx.scheduler.snapshot().global.active).toBe(1);

      const result = await submitDcResult(ctx.app, issued.json());
      expect(result.statusCode, result.body).toBe(201);
      expect(ctx.scheduler.snapshot().global.active).toBe(0);
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it("does not claim before JC admission and accepts JC terminal result reporting", async () => {
    const ctx = buildFixture();
    try {
      const hold = await holdPermit(ctx.scheduler, "acs-jc-bridge");
      const pending = issueJc(ctx.app);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(authorityCounts(ctx.dbPath)).toEqual({ attempts: 0, activeLeases: 0 });

      hold.release();
      const issued = await pending;
      expect(issued.statusCode).toBe(200);
      expect(ctx.scheduler.snapshot().global.active).toBe(1);

      const result = await submitJcResult(ctx.app, issued.json());
      expect(result.statusCode, result.body).toBe(201);
      expect(ctx.scheduler.snapshot().global.active).toBe(0);
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it("keeps readyz and healthz responsive while execution is saturated", async () => {
    const ctx = buildFixture();
    try {
      const hold = await holdPermit(ctx.scheduler, "acs-dc-bridge");
      const started = performance.now();
      const [ready, health] = await Promise.all([
        ctx.app.inject({ method: "GET", url: "/readyz" }),
        ctx.app.inject({ method: "GET", url: "/healthz" })
      ]);
      const latencyMs = performance.now() - started;
      expect(ready.statusCode).toBe(200);
      expect(ready.json().execution).toMatchObject({ saturated: true, active: 1, capacity: 1 });
      expect(health.statusCode).toBe(200);
      expect(latencyMs).toBeLessThan(200);
      console.log("EXECUTION_ADMISSION_READYZ_RESULT", JSON.stringify({ latencyMs }));
      hold.release();
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it("returns structured queue_full backpressure without creating execution authority", async () => {
    const scheduler = new ExecutionAdmissionScheduler({
      config: {
        executionMaxInflight: 1,
        executorMaxInflight: 1,
        queueMax: 1,
        queueTimeoutMs: 2_000,
        waitMaxInflight: 1
      }
    });
    const ctx = buildFixture({ scheduler });
    try {
      await attestDc(ctx.app);
      const hold = await holdPermit(scheduler, "acs-dc-bridge");
      const first = issueDc(ctx.app, ctx.root);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const overflow = await ctx.app.inject({
        method: "POST",
        url: "/dc/capability/issue",
        headers: { authorization: `Bearer ${DC_TOKEN}`, "x-dc-actor": "chatgpt:c" },
        payload: {
          client_id: "client-c",
          tool: "read_file",
          argsSummary: JSON.stringify({ path: join(ctx.root, "other.txt") })
        }
      });
      expect(overflow.statusCode).toBe(429);
      expect(overflow.json()).toMatchObject({ code: "queue_full" });
      expect(overflow.json().retry_after_ms).toBeGreaterThan(0);
      expect(authorityCounts(ctx.dbPath)).toEqual({ attempts: 0, activeLeases: 0 });
      hold.release();
      const admitted = await first;
      expect(admitted.statusCode).toBe(200);
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

<<<<<<< Updated upstream
  it("retains admission while a lease remains active after DC capability issuance fails", async () => {
=======
  it("retains admission for an active lease when post-claim DC capability issuance fails", async () => {
>>>>>>> Stashed changes
    const ctx = buildFixture();
    try {
      const failed = await issueDc(ctx.app, ctx.root);
      expect(failed.statusCode).toBe(403);
      expect(ctx.scheduler.snapshot().global.active).toBe(1);
      expect(authorityCounts(ctx.dbPath)).toEqual({ attempts: 1, activeLeases: 1 });
<<<<<<< Updated upstream
      const db = new DatabaseSync(ctx.dbPath, { readOnly: true });
      try {
        expect(db.prepare("SELECT COUNT(*) AS count FROM admission_permits").get()).toEqual({ count: 1 });
      } finally {
        db.close();
      }
=======
>>>>>>> Stashed changes
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it("shutdown rejects queued admission before any attempt or lease exists", async () => {
    const controller = new ShutdownController();
    const scheduler = new ExecutionAdmissionScheduler({
      config: {
        executionMaxInflight: 1,
        executorMaxInflight: 1,
        queueMax: 4,
        queueTimeoutMs: 2_000,
        waitMaxInflight: 1
      }
    });
    const ctx = buildFixture({ scheduler, shutdownController: controller });
    try {
      await attestDc(ctx.app);
      const hold = await holdPermit(scheduler, "acs-dc-bridge");
      const acquire = scheduler.acquire.bind(scheduler);
      const queued = vi.spyOn(scheduler, "acquire").mockImplementation((request) => {
        const pending = acquire(request);
        // Trigger shutdown at the actual queue boundary, rather than race a
        // wall-clock sleep against the independent queue-expiration timer.
        expect(scheduler.snapshot().global.queued).toBe(1);
        controller.beginShutdown();
        return pending;
      });
      const rejected = await issueDc(ctx.app, ctx.root);
      expect(queued).toHaveBeenCalledTimes(1);
      queued.mockRestore();
      expect(rejected.statusCode).toBe(503);
      expect(rejected.json().code).toBe("gateway_shutting_down");
      expect(authorityCounts(ctx.dbPath)).toEqual({ attempts: 0, activeLeases: 0 });
      hold.release();
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it("exposes cheap admission state and reconciliation remains diagnostic only", async () => {
    const ctx = buildFixture();
    try {
      const hold = await holdPermit(ctx.scheduler, "acs-dc-bridge");
      const status = await ctx.app.inject({
        method: "GET",
        url: "/internal/execution-admission",
        headers: { authorization: `Bearer ${OP_TOKEN}` }
      });
      expect(status.statusCode).toBe(200);
      expect(status.json()).toMatchObject({
        global: { capacity: 1, active: 1, queued: 0 },
        lanes: { dc: { active: 1 } }
      });
      expect(authorityCounts(ctx.dbPath)).toEqual({ attempts: 0, activeLeases: 0 });
      hold.release();
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it("bounds 20 simultaneous inbound JC requests at the real gateway admission boundary", async () => {
    const scheduler = new ExecutionAdmissionScheduler({
      config: {
        executionMaxInflight: 4,
        executorMaxInflight: 1,
        queueMax: 32,
        queueTimeoutMs: 30_000,
        waitMaxInflight: 1
      }
    });
    const ctx = buildFixture({ scheduler });
    let peakAdmissionConcurrency = 0;
    let peakQueueDepth = 0;
    let monitor: ReturnType<typeof setInterval> | undefined;
    try {
      monitor = setInterval(() => {
        const snapshot = ctx.scheduler.snapshot();
        peakAdmissionConcurrency = Math.max(peakAdmissionConcurrency, snapshot.global.active);
        peakQueueDepth = Math.max(peakQueueDepth, snapshot.global.queued);
      }, 1);

      const calls = Array.from({ length: 20 }, (_, index) =>
        issueJc(ctx.app, `chatgpt:load-${index}`, `client-${index}`).then(async (issued) => {
          expect(issued.statusCode, issued.body).toBe(200);
          const snapshot = ctx.scheduler.snapshot();
          peakAdmissionConcurrency = Math.max(peakAdmissionConcurrency, snapshot.global.active);
          peakQueueDepth = Math.max(peakQueueDepth, snapshot.global.queued);
          const result = await submitJcResult(ctx.app, issued.json());
          expect(result.statusCode, result.body).toBe(201);
        })
      );
      await Promise.all(calls);
      const final = ctx.scheduler.snapshot();
      expect(peakAdmissionConcurrency).toBeLessThanOrEqual(1);
      expect(peakQueueDepth).toBeLessThanOrEqual(32);
      expect(peakQueueDepth).toBeGreaterThan(0);
      expect(final.global).toMatchObject({ active: 0, queued: 0 });
      console.log(
        "EXECUTION_ADMISSION_GATEWAY_LOAD_RESULT",
        JSON.stringify({
          inboundCalls: 20,
          peakAdmissionConcurrency,
          peakExecutorConcurrency: peakAdmissionConcurrency,
          maxQueueDepth: peakQueueDepth,
          rejectedRequests: 0,
          admissionP95Ms: final.admissionP95Ms,
          serviceP95Ms: final.serviceP95Ms,
          permitLeaks: final.global.active
        })
      );
    } finally {
      if (monitor) clearInterval(monitor);
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });
});

describe("gateway execution admission required coverage", () => {
  it("allows JC and DC to hold independent executor permits concurrently", async () => {
    const scheduler = new ExecutionAdmissionScheduler({
      config: {
        executionMaxInflight: 2,
        executorMaxInflight: 1,
        queueMax: 8,
        queueTimeoutMs: 2_000,
        waitMaxInflight: 1
      }
    });
    const ctx = buildFixture({ scheduler });
    try {
      await attestDc(ctx.app);
      const [dc, jc] = await Promise.all([issueDc(ctx.app, ctx.root), issueJc(ctx.app)]);
      expect(dc.statusCode, dc.body).toBe(200);
      expect(jc.statusCode, jc.body).toBe(200);
      expect(ctx.scheduler.snapshot().global.active).toBe(2);
      expect(ctx.scheduler.snapshot().lanes).toMatchObject({
        dc: { active: 1 },
        jc: { active: 1 }
      });
      expect((await submitDcResult(ctx.app, dc.json())).statusCode).toBe(201);
      expect((await submitJcResult(ctx.app, jc.json())).statusCode).toBe(201);
      expect(ctx.scheduler.snapshot().global.active).toBe(0);
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it("keeps normal JC execution available while canonical read_process_output holds WAIT capacity", async () => {
    const ctx = buildFixture();
    try {
      const waiting = await issueJcTool(
        ctx.app,
        "read_process_output",
        { sessionId: "session-1" },
        "chatgpt:wait",
        "client-wait"
      );
      expect(waiting.statusCode, waiting.body).toBe(200);
      expect(ctx.scheduler.snapshot()).toMatchObject({
        global: { active: 0 },
        wait: { active: 1 }
      });

      const normal = await issueJc(ctx.app, "chatgpt:normal", "client-normal");
      expect(normal.statusCode, normal.body).toBe(200);
      expect(ctx.scheduler.snapshot()).toMatchObject({
        global: { active: 1 },
        wait: { active: 1 },
        lanes: { jc: { active: 2 } }
      });
      expect((await submitJcResult(ctx.app, normal.json())).statusCode).toBe(201);
      expect(ctx.scheduler.snapshot()).toMatchObject({
        global: { active: 0 },
        wait: { active: 1 }
      });
      expect((await submitJcResult(ctx.app, waiting.json())).statusCode).toBe(201);
      expect(ctx.scheduler.snapshot().wait.active).toBe(0);
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it("times out queued gateway work without creating an attempt or lease", async () => {
    const scheduler = new ExecutionAdmissionScheduler({
      config: {
        executionMaxInflight: 1,
        executorMaxInflight: 1,
        queueMax: 4,
        queueTimeoutMs: 30,
        waitMaxInflight: 1
      }
    });
    const ctx = buildFixture({ scheduler });
    try {
      await attestDc(ctx.app);
      const hold = await holdPermit(scheduler, "acs-dc-bridge");
      const timedOut = await issueDc(ctx.app, ctx.root);
      expect(timedOut.statusCode).toBe(503);
      expect(timedOut.json()).toMatchObject({ code: "executor_busy" });
      expect(authorityCounts(ctx.dbPath)).toEqual({ attempts: 0, activeLeases: 0 });
      expect(ctx.scheduler.snapshot().global).toMatchObject({ active: 1, queued: 0 });
      hold.release();
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });

  it("releases a newly granted permit when claim fails after waiting", async () => {
    const ctx = buildFixture();
    try {
      const hold = await holdPermit(ctx.scheduler, "acs-jc-bridge");
      const firstPromise = issueJc(ctx.app, "chatgpt:same", "client-same");
      await new Promise((resolve) => setTimeout(resolve, 20));
      const secondPromise = issueJc(ctx.app, "chatgpt:same", "client-same");
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(ctx.scheduler.snapshot().global.queued).toBe(2);

      hold.release();
      const first = await firstPromise;
      expect(first.statusCode, first.body).toBe(200);
      expect((await submitJcResult(ctx.app, first.json())).statusCode).toBe(201);
      const second = await secondPromise;
      expect(second.statusCode).toBe(409);
      expect(ctx.scheduler.snapshot().global.active).toBe(0);
      expect(authorityCounts(ctx.dbPath).attempts).toBe(1);
    } finally {
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });
});

describe("gateway admission disconnect cancellation", () => {
  it("removes a disconnected queued request before it can claim execution authority", async () => {
    const ctx = buildFixture();
    let hold: Awaited<ReturnType<typeof holdPermit>> | undefined;
    try {
      await ctx.app.listen({ host: "127.0.0.1", port: 0 });
      await attestDc(ctx.app);
      hold = await holdPermit(ctx.scheduler, "acs-dc-bridge");
      const address = ctx.app.server.address();
      if (!address || typeof address === "string") throw new Error("gateway listener address unavailable");
      const abort = new AbortController();
      const pending = fetch(`http://127.0.0.1:${address.port}/dc/capability/issue`, {
        method: "POST",
        signal: abort.signal,
        headers: {
          authorization: `Bearer ${DC_TOKEN}`,
          "x-dc-actor": "chatgpt:disconnect",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          client_id: "client-disconnect",
          tool: "read_file",
          argsSummary: JSON.stringify({ path: join(ctx.root, "disconnect.txt") })
        })
      }).catch((error: unknown) => error);
      const queuedDeadline = Date.now() + 1_000;
      while (ctx.scheduler.snapshot().global.queued !== 1 && Date.now() < queuedDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(ctx.scheduler.snapshot().global.queued).toBe(1);
      abort.abort();
      await pending;

      const cancelledDeadline = Date.now() + 1_000;
      while (ctx.scheduler.snapshot().global.queued !== 0 && Date.now() < cancelledDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(ctx.scheduler.snapshot().global).toMatchObject({ active: 1, queued: 0 });
      expect(authorityCounts(ctx.dbPath)).toEqual({ attempts: 0, activeLeases: 0 });

      hold.release();
      hold = undefined;
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(authorityCounts(ctx.dbPath)).toEqual({ attempts: 0, activeLeases: 0 });
    } finally {
      hold?.release();
      await ctx.app.close();
      rmSync(ctx.root, { recursive: true, force: true });
    }
  });
});
