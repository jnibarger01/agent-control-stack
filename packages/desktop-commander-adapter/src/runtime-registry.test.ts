import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import {
  SqliteWorkItemStore,
  defaultExecutionPlanForWorkItem,
  executionPlanApprovalRequestHash
} from "@agent-control-stack/work-items";
import {
  classifyCapabilityIssuanceConstraintError,
  SqliteDesktopCommanderRuntimeRegistry
} from "./runtime-registry.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function registry(): SqliteDesktopCommanderRuntimeRegistry {
  const directory = mkdtempSync(join(tmpdir(), "dc-runtime-registry-"));
  directories.push(directory);
  return new SqliteDesktopCommanderRuntimeRegistry(join(directory, "control.db"));
}

const identity = "a".repeat(64);
const hex = (seed: string) => seed.repeat(64).slice(0, 64);

function requiredApprovalId(fixture: ReturnType<typeof issuanceFixture>): string {
  if (!fixture.approval) throw new Error("approval fixture is required");
  return fixture.approval.approvalId;
}

function issuanceFixture(approvalRequired = false) {
  const directory = mkdtempSync(join(tmpdir(), "dc-runtime-issuance-"));
  directories.push(directory);
  const dbPath = join(directory, "control.db");
  const store = new SqliteWorkItemStore(dbPath);
  const workItem = store.create({
    title: "Capability issuance fixture",
    requester: "user",
    requesterSubject: "actor-operator",
    intent: "exercise durable issuance bindings",
    target: { cwd: "/repo", files: ["src/a.ts"] },
    requestedActions: [{ kind: "fs.read", description: "read", params: { paths: ["src/a.ts"], write: false } }],
    risk: "low"
  });
  const plan = store.createExecutionPlan({
    workItemId: workItem.id,
    definition: defaultExecutionPlanForWorkItem(workItem),
    createdByActorId: "actor-operator"
  });
  const admission = store.admitExecutionPlan(
    {
      workItemId: workItem.id,
      planHash: plan.planHash,
      policyVersion: "acs.policy.v1",
      policyDecisionHash: hex("1"),
      requiresApproval: approvalRequired,
      admittedByActorId: "policy-gate"
    },
    { via: "policy_gate" }
  );
  const actionHash = hex("3");
  const approval = approvalRequired
    ? store.grantExecutionPlanApproval(
        {
          workItemId: workItem.id,
          planHash: plan.planHash,
          actionHash,
          approvedByActorId: "human-approver"
        },
        { via: "domain_service" }
      )
    : undefined;
  const attempt = store.createAttempt(
    { workItemId: workItem.id, planHash: plan.planHash, inputHash: hex("2") },
    { via: "domain_service" }
  );
  const lease = store.leaseAttempt(
    {
      attemptId: attempt.attemptId,
      workItemId: workItem.id,
      admissionId: admission.admissionId,
      approvalId: approval?.approvalId,
      workerId: "worker_1",
      leaseToken: "a".repeat(32),
      policyVersion: admission.policyVersion,
      policyDecisionHash: admission.policyDecisionHash,
      ttlMs: 60_000
    },
    { via: "domain_service" }
  );
  const registry = new SqliteDesktopCommanderRuntimeRegistry(dbPath);
  const bootstrap = registry.issueBootstrap({
    runtimeId: "runtime_1",
    identityConfigFingerprint: identity,
    scopes: ["fs.read"]
  });
  registry.completeBootstrap(bootstrap);
  const now = new Date();
  const binding = {
    runtimeId: "runtime_1",
    identityConfigFingerprint: identity,
    leaseId: lease.leaseId,
    attemptId: attempt.attemptId,
    workItemId: workItem.id,
    workerId: "worker_1",
    fencingEpoch: lease.fencingEpoch,
    planHash: plan.planHash,
    actionHash,
    invocationHash: hex("4"),
    requiredScopes: ["fs.read"],
    approvalRequired,
    ...(approval ? { approvalId: approval.approvalId } : {}),
    keyId: "test-key-1",
    nonce: "A".repeat(43),
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 29_000).toISOString()
  };
  return { dbPath, store, registry, binding, approval };
}

describe("SqliteDesktopCommanderRuntimeRegistry", () => {
  it("persists only a hashed challenge and registers an exactly-attested runtime", () => {
    const store = registry();
    const bootstrap = store.issueBootstrap({
      runtimeId: "runtime_1",
      identityConfigFingerprint: identity,
      scopes: ["fs.read", "fs.write"]
    });
    store.completeBootstrap({ ...bootstrap });

    const dbPath = directories[0] ? join(directories[0], "control.db") : "";
    const db = new DatabaseSync(dbPath);
    const runtime = db
      .prepare("SELECT status, identity_config_fingerprint FROM desktop_commander_runtimes WHERE runtime_id = ?")
      .get("runtime_1") as { status: string; identity_config_fingerprint: string };
    expect(runtime).toEqual({ status: "active", identity_config_fingerprint: identity });
    const rawChallenge = readFileSync(dbPath).includes(Buffer.from(bootstrap.challenge));
    expect(rawChallenge).toBe(false);
    db.close();
    store.close();
  });

  it("supersedes an unconsumed bootstrap challenge so immediate startup retry is safe", () => {
    const store = registry();
    const first = store.issueBootstrap({
      runtimeId: "runtime_1",
      identityConfigFingerprint: identity,
      scopes: ["fs.read"]
    });
    const second = store.issueBootstrap({
      runtimeId: "runtime_1",
      identityConfigFingerprint: identity,
      scopes: ["fs.read"]
    });
    expect(second.challenge).not.toBe(first.challenge);
    expect(() => store.completeBootstrap(first)).toThrow(/challenge or identity/);
    store.completeBootstrap(second);
    store.close();
  });

  it("fails closed on changed identity, scope drift, replay, and revocation", () => {
    const store = registry();
    const bootstrap = store.issueBootstrap({
      runtimeId: "runtime_1",
      identityConfigFingerprint: identity,
      scopes: ["fs.read"]
    });
    expect(() => store.completeBootstrap({ ...bootstrap, identityConfigFingerprint: "b".repeat(64) })).toThrow(
      /challenge or identity/
    );
    expect(() => store.completeBootstrap({ ...bootstrap, scopes: ["fs.read", "fs.write"] })).toThrow(/scopes/);
    store.completeBootstrap(bootstrap);
    expect(() => store.completeBootstrap(bootstrap)).toThrow(/challenge or identity/);
    store.revoke("runtime_1", "operator revoked runtime");
    expect(() => store.revoke("runtime_1", "again")).toThrow(/already revoked/);
    store.close();
  });

  it("rejects malformed and unsorted runtime registrations before persistence", () => {
    const store = registry();
    expect(() =>
      store.issueBootstrap({
        runtimeId: "runtime_1",
        identityConfigFingerprint: identity,
        scopes: ["fs.write", "fs.read"]
      })
    ).toThrow(/sorted/);
    expect(() =>
      store.issueBootstrap({ runtimeId: "runtime_1", identityConfigFingerprint: identity, scopes: ["not.a.scope"] })
    ).toThrow(/invalid/);
    store.close();
  });

  it("durably records a fully bound issuance and rejects runtime, scope, lease, plan, and nonce replays atomically", () => {
    const fixture = issuanceFixture();
    try {
      const recorded = fixture.registry.recordIssuance(fixture.binding);
      expect(recorded.requestHash).toMatch(/^[a-f0-9]{64}$/);
      const db = new DatabaseSync(fixture.dbPath);
      expect(
        db.prepare("SELECT runtime_id, lease_id, nonce_hash FROM desktop_commander_capability_issuances").all()
      ).toHaveLength(1);
      expect(db.prepare("SELECT scope_name FROM desktop_commander_capability_issuance_scopes").all()).toEqual([
        { scope_name: "fs.read" }
      ]);
      db.close();

      for (const changed of [
        { ...fixture.binding, runtimeId: "runtime_missing" },
        { ...fixture.binding, identityConfigFingerprint: "b".repeat(64) },
        { ...fixture.binding, requiredScopes: ["fs.write"] },
        { ...fixture.binding, leaseId: "lease_missing" },
        { ...fixture.binding, fencingEpoch: fixture.binding.fencingEpoch + 1 },
        { ...fixture.binding, planHash: hex("5") },
        fixture.binding
      ]) {
        expect(() => fixture.registry.recordIssuance(changed)).toThrow();
      }
      const check = new DatabaseSync(fixture.dbPath);
      expect(check.prepare("SELECT COUNT(*) AS count FROM desktop_commander_capability_issuances").get()).toEqual({
        count: 1
      });
      check.close();
    } finally {
      fixture.registry.close();
      fixture.store.close();
    }
  });

  it("rejects invalid capability TTLs before an issuance is stored", () => {
    const fixture = issuanceFixture();
    try {
      expect(() =>
        fixture.registry.recordIssuance({ ...fixture.binding, expiresAt: fixture.binding.issuedAt })
      ).toThrow(/expiration/);
      expect(() =>
        fixture.registry.recordIssuance({
          ...fixture.binding,
          expiresAt: new Date(Date.parse(fixture.binding.issuedAt) + 30_001).toISOString()
        })
      ).toThrow(/expiration/);
      const db = new DatabaseSync(fixture.dbPath);
      expect(db.prepare("SELECT COUNT(*) AS count FROM desktop_commander_capability_issuances").get()).toEqual({
        count: 0
      });
      db.close();
    } finally {
      fixture.registry.close();
      fixture.store.close();
    }
  });

  it("requires the lease-bound, consumed, unexpired approval with its exact plan, action, and request binding", () => {
    const fixture = issuanceFixture(true);
    try {
      expect(fixture.registry.recordIssuance(fixture.binding).approvalId).toBe(fixture.approval?.approvalId);
      const db = new DatabaseSync(fixture.dbPath);
      expect(() =>
        fixture.registry.recordIssuance({ ...fixture.binding, approvalId: "approval_wrong", nonce: "B".repeat(43) })
      ).toThrow(/approval/);
      expect(() =>
        fixture.registry.recordIssuance({ ...fixture.binding, actionHash: hex("5"), nonce: "C".repeat(43) })
      ).toThrow(/approval/);
      expect(db.prepare("SELECT COUNT(*) AS count FROM desktop_commander_capability_issuances").get()).toEqual({
        count: 1
      });
      db.close();
    } finally {
      fixture.registry.close();
      fixture.store.close();
    }
  });

  it("rejects missing, pending, expired, and request-mismatched approvals without recording an issuance", () => {
    const variants: Array<{
      name: string;
      mutate: (fixture: ReturnType<typeof issuanceFixture>) => void;
      binding: (fixture: ReturnType<typeof issuanceFixture>) => object;
    }> = [
      {
        name: "missing capability approval id",
        mutate: () => undefined,
        binding: () => ({ approvalId: undefined })
      },
      {
        name: "unconsumed approval",
        mutate: (fixture) => {
          const db = new DatabaseSync(fixture.dbPath);
          db.exec("DROP TRIGGER execution_plan_approvals_transition_guard");
          db.prepare(
            "UPDATE execution_plan_approvals SET status = 'granted', consumed_at = NULL WHERE approval_id = ?"
          ).run(requiredApprovalId(fixture));
          db.close();
        },
        binding: () => ({})
      },
      {
        name: "expired approval",
        mutate: (fixture) => {
          const db = new DatabaseSync(fixture.dbPath);
          db.exec("DROP TRIGGER execution_plan_approvals_transition_guard");
          db.prepare("UPDATE execution_plan_approvals SET expires_at = ? WHERE approval_id = ?").run(
            new Date(Date.now() + 1).toISOString(),
            requiredApprovalId(fixture)
          );
          db.close();
        },
        binding: () => ({})
      },
      {
        name: "request binding mismatch",
        mutate: (fixture) => {
          const db = new DatabaseSync(fixture.dbPath);
          db.exec("DROP TRIGGER execution_plan_approvals_transition_guard");
          db.prepare("UPDATE execution_plan_approvals SET request_hash = ? WHERE approval_id = ?").run(
            hex("9"),
            requiredApprovalId(fixture)
          );
          db.close();
        },
        binding: () => ({})
      }
    ];

    for (const variant of variants) {
      const fixture = issuanceFixture(true);
      try {
        variant.mutate(fixture);
        expect(
          () =>
            fixture.registry.recordIssuance({
              ...fixture.binding,
              ...variant.binding(fixture),
              nonce: `${fixture.binding.nonce.slice(0, -1)}${variant.name.length}`.slice(0, 43)
            }),
          variant.name
        ).toThrow(/approval/);
        const db = new DatabaseSync(fixture.dbPath);
        expect(
          db.prepare("SELECT COUNT(*) AS count FROM desktop_commander_capability_issuances").get(),
          variant.name
        ).toEqual({ count: 0 });
        db.close();
      } finally {
        fixture.registry.close();
        fixture.store.close();
      }
    }
  });

  it("rejects a repeated nonce on an approval-bound lease without a second issuance row", () => {
    const fixture = issuanceFixture(true);
    try {
      fixture.registry.recordIssuance(fixture.binding);
      expect(() => fixture.registry.recordIssuance(fixture.binding)).toThrow();
      const db = new DatabaseSync(fixture.dbPath);
      expect(db.prepare("SELECT COUNT(*) AS count FROM desktop_commander_capability_issuances").get()).toEqual({
        count: 1
      });
      db.close();
    } finally {
      fixture.registry.close();
      fixture.store.close();
    }
  });
});

describe("capability issuance uniqueness (migration 026 database authority)", () => {
  it("rejects a second mint for the same lease/attempt/invocation with a deterministic error", () => {
    const fixture = issuanceFixture();
    try {
      fixture.registry.recordIssuance(fixture.binding);
      // Different nonce (so nonce_hash uniqueness is not what fires) but the
      // same invocation: the lease/invocation unique index must be the
      // authority, surfaced as a canonical ControlStackError.
      expect(() => fixture.registry.recordIssuance({ ...fixture.binding, nonce: "B".repeat(43) })).toThrowError(
        /already issued/
      );
      const db = new DatabaseSync(fixture.dbPath);
      expect(db.prepare("SELECT COUNT(*) AS count FROM desktop_commander_capability_issuances").get()).toEqual({
        count: 1
      });
      db.close();
    } finally {
      fixture.registry.close();
      fixture.store.close();
    }
  });

  it("permits distinct invocations on the same lease", () => {
    const fixture = issuanceFixture();
    try {
      fixture.registry.recordIssuance(fixture.binding);
      fixture.registry.recordIssuance({
        ...fixture.binding,
        invocationHash: hex("5"),
        nonce: "C".repeat(43)
      });
      const db = new DatabaseSync(fixture.dbPath);
      expect(db.prepare("SELECT COUNT(*) AS count FROM desktop_commander_capability_issuances").get()).toEqual({
        count: 2
      });
      db.close();
    } finally {
      fixture.registry.close();
      fixture.store.close();
    }
  });

  it("allows only one valid capability under concurrent mint attempts", async () => {
    const fixture = issuanceFixture();
    const secondConnection = new SqliteDesktopCommanderRuntimeRegistry(fixture.dbPath);
    try {
      const results = await Promise.allSettled([
        Promise.resolve().then(() => fixture.registry.recordIssuance(fixture.binding)),
        Promise.resolve().then(() => secondConnection.recordIssuance({ ...fixture.binding, nonce: "D".repeat(43) }))
      ]);
      const fulfilled = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter((result) => result.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      if (rejected[0]?.status === "rejected") {
        expect(String((rejected[0] as PromiseRejectedResult).reason)).toMatch(/already issued/);
      }
      const db = new DatabaseSync(fixture.dbPath);
      expect(db.prepare("SELECT COUNT(*) AS count FROM desktop_commander_capability_issuances").get()).toEqual({
        count: 1
      });
      db.close();
    } finally {
      secondConnection.close();
      fixture.registry.close();
      fixture.store.close();
    }
  });

  it("maps both migration-026 uniqueness paths to already_issued and never misclassifies other integrity failures", () => {
    // Same lease/attempt/work-item/invocation (distinct nonce) => already_issued.
    const invocationFixture = issuanceFixture();
    try {
      invocationFixture.registry.recordIssuance(invocationFixture.binding);
      expect(() =>
        invocationFixture.registry.recordIssuance({ ...invocationFixture.binding, nonce: "B".repeat(43) })
      ).toThrowError(expect.objectContaining({ code: "desktop_commander_capability_already_issued" }));
    } finally {
      invocationFixture.registry.close();
      invocationFixture.store.close();
    }

    // Duplicate nonce on the same lease => already_issued (nonce_hash UNIQUE).
    const nonceFixture = issuanceFixture();
    try {
      nonceFixture.registry.recordIssuance(nonceFixture.binding);
      expect(() => nonceFixture.registry.recordIssuance(nonceFixture.binding)).toThrowError(
        expect.objectContaining({ code: "desktop_commander_capability_already_issued" })
      );
    } finally {
      nonceFixture.registry.close();
      nonceFixture.store.close();
    }

    // Any other integrity failure keeps a truthful, distinct failure path.
    expect(
      classifyCapabilityIssuanceConstraintError(
        Object.assign(new Error("FOREIGN KEY constraint failed"), { code: "SQLITE_CONSTRAINT_FOREIGNKEY" })
      )
    ).toBeUndefined();
    expect(
      classifyCapabilityIssuanceConstraintError(
        Object.assign(new Error("CHECK constraint failed: expires_at > issued_at"), { code: "SQLITE_CONSTRAINT_CHECK" })
      )
    ).toBeUndefined();
    expect(
      classifyCapabilityIssuanceConstraintError(
        Object.assign(new Error("NOT NULL constraint failed: desktop_commander_runtimes.runtime_id"), {
          code: "SQLITE_CONSTRAINT_NOTNULL"
        })
      )
    ).toBeUndefined();
    // A UNIQUE violation on a DIFFERENT table is not a duplicate issuance.
    expect(
      classifyCapabilityIssuanceConstraintError(
        Object.assign(new Error("UNIQUE constraint failed: execution_attempts.attempt_id"), {
          code: "SQLITE_CONSTRAINT_UNIQUE"
        })
      )
    ).toBeUndefined();
    expect(
      classifyCapabilityIssuanceConstraintError(
        new Error("UNIQUE constraint failed: desktop_commander_capability_issuances.nonce_hash")
      )?.code
    ).toBe("desktop_commander_capability_already_issued");
  });

  // Genuine competing-writer concurrency: two independent worker threads, each
  // with its own SQLite connection on the same database file, released through
  // a shared barrier so the writers actually contend. Exactly one issuance for
  // the migration-026 uniqueness key may commit; the other must fail
  // deterministically and the final table must contain exactly one row.
  it("admits exactly one issuance when two independent database writers race on the same uniqueness key", async () => {
    const fixture = issuanceFixture();
    const requestHash = executionPlanApprovalRequestHash({
      workItemId: fixture.binding.workItemId,
      planHash: fixture.binding.planHash,
      actionHash: fixture.binding.actionHash
    });
    const barrier = new SharedArrayBuffer(4);
    new Int32Array(barrier)[0] = 0;

    const workerSource = `
const { DatabaseSync } = require("node:sqlite");
const { workerData, parentPort } = require("node:worker_threads");
const db = new DatabaseSync(workerData.dbPath);
db.exec("PRAGMA busy_timeout = 5000;");
parentPort.postMessage({ ready: true });
Atomics.wait(new Int32Array(workerData.barrier), 0, 0);
try {
  db.exec("BEGIN IMMEDIATE");
  db.prepare(
    "INSERT INTO desktop_commander_capability_issuances (capability_issuance_id, lease_id, attempt_id, work_item_id, runtime_id, action_hash, request_hash, invocation_hash, approval_id, key_id, nonce_hash, issued_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)"
  ).run(
    workerData.issuanceId, workerData.leaseId, workerData.attemptId, workerData.workItemId,
    workerData.runtimeId, workerData.actionHash, workerData.requestHash, workerData.invocationHash,
    null, "test-key-1", workerData.nonceHash, workerData.issuedAt, workerData.expiresAt
  );
  db.exec("COMMIT");
  parentPort.postMessage({ ok: true });
} catch (error) {
  try { db.exec("ROLLBACK"); } catch {}
  parentPort.postMessage({ ok: false, code: error.code ?? null, message: String(error.message) });
}`;

    const spawnWriter = (nonceHash: string) =>
      new Promise<{ ok: boolean; code?: string | null; message?: string }>((resolve, reject) => {
        const worker = new Worker(workerSource, {
          eval: true,
          workerData: {
            dbPath: fixture.dbPath,
            barrier,
            issuanceId: `dc_capability_${nonceHash.slice(0, 8)}`,
            leaseId: fixture.binding.leaseId,
            attemptId: fixture.binding.attemptId,
            workItemId: fixture.binding.workItemId,
            runtimeId: fixture.binding.runtimeId,
            actionHash: fixture.binding.actionHash,
            requestHash,
            invocationHash: fixture.binding.invocationHash,
            nonceHash,
            issuedAt: fixture.binding.issuedAt,
            expiresAt: fixture.binding.expiresAt
          }
        });
        let ready = false;
        worker.on("message", (message) => {
          if (message.ready && !ready) {
            ready = true;
            return;
          }
          resolve(message);
        });
        worker.on("error", reject);
        worker.on("exit", (code) => {
          if (code !== 0) reject(new Error(`writer exited with ${code}`));
        });
      });

    try {
      const writers = [spawnWriter("d".repeat(64)), spawnWriter("e".repeat(64))];
      // Both writers connect first (message 1), then block on the barrier.
      await new Promise((resolve) => setTimeout(resolve, 250));
      Atomics.store(new Int32Array(barrier), 0, 1);
      Atomics.notify(new Int32Array(barrier), 0);

      const results = await Promise.all(writers);
      const succeeded = results.filter((result) => result.ok);
      const failed = results.filter((result) => !result.ok);
      expect(succeeded).toHaveLength(1);
      expect(failed).toHaveLength(1);
      expect(String(failed[0].message)).toMatch(/UNIQUE constraint failed: desktop_commander_capability_issuances/);
      const db = new DatabaseSync(fixture.dbPath);
      expect(
        db
          .prepare("SELECT COUNT(*) AS count FROM desktop_commander_capability_issuances WHERE invocation_hash = ?")
          .get(fixture.binding.invocationHash)
      ).toEqual({ count: 1 });
      db.close();
    } finally {
      fixture.registry.close();
      fixture.store.close();
    }
  });
});
