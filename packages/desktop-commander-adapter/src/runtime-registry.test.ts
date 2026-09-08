import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteWorkItemStore, defaultExecutionPlanForWorkItem } from "@agent-control-stack/work-items";
import { SqliteDesktopCommanderRuntimeRegistry } from "./runtime-registry.js";

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
  const admission = store.admitExecutionPlan({
    workItemId: workItem.id,
    planHash: plan.planHash,
    policyVersion: "acs.policy.v1",
    policyDecisionHash: hex("1"),
    requiresApproval: approvalRequired,
    admittedByActorId: "policy-gate"
  }, { via: "policy_gate" });
  const actionHash = hex("3");
  const approval = approvalRequired
    ? store.grantExecutionPlanApproval({
      workItemId: workItem.id,
      planHash: plan.planHash,
      actionHash,
      approvedByActorId: "human-approver"
    }, { via: "domain_service" })
    : undefined;
  const attempt = store.createAttempt({ workItemId: workItem.id, planHash: plan.planHash, inputHash: hex("2") }, { via: "domain_service" });
  const lease = store.leaseAttempt({
    attemptId: attempt.attemptId,
    workItemId: workItem.id,
    admissionId: admission.admissionId,
    approvalId: approval?.approvalId,
    workerId: "worker_1",
    leaseToken: "a".repeat(32),
    policyVersion: admission.policyVersion,
    policyDecisionHash: admission.policyDecisionHash,
    ttlMs: 60_000
  }, { via: "domain_service" });
  const registry = new SqliteDesktopCommanderRuntimeRegistry(dbPath);
  const bootstrap = registry.issueBootstrap({ runtimeId: "runtime_1", identityConfigFingerprint: identity, scopes: ["fs.read"] });
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
    const bootstrap = store.issueBootstrap({ runtimeId: "runtime_1", identityConfigFingerprint: identity, scopes: ["fs.read", "fs.write"] });
    store.completeBootstrap({ ...bootstrap });

    const dbPath = directories[0] ? join(directories[0], "control.db") : "";
    const db = new DatabaseSync(dbPath);
    const runtime = db.prepare("SELECT status, identity_config_fingerprint FROM desktop_commander_runtimes WHERE runtime_id = ?").get("runtime_1") as { status: string; identity_config_fingerprint: string };
    expect(runtime).toEqual({ status: "active", identity_config_fingerprint: identity });
    const rawChallenge = readFileSync(dbPath).includes(Buffer.from(bootstrap.challenge));
    expect(rawChallenge).toBe(false);
    db.close();
    store.close();
  });

  it("fails closed on changed identity, scope drift, replay, and revocation", () => {
    const store = registry();
    const bootstrap = store.issueBootstrap({ runtimeId: "runtime_1", identityConfigFingerprint: identity, scopes: ["fs.read"] });
    expect(() => store.completeBootstrap({ ...bootstrap, identityConfigFingerprint: "b".repeat(64) })).toThrow(/challenge or identity/);
    expect(() => store.completeBootstrap({ ...bootstrap, scopes: ["fs.read", "fs.write"] })).toThrow(/scopes/);
    store.completeBootstrap(bootstrap);
    expect(() => store.completeBootstrap(bootstrap)).toThrow(/challenge or identity/);
    store.revoke("runtime_1", "operator revoked runtime");
    expect(() => store.revoke("runtime_1", "again")).toThrow(/already revoked/);
    store.close();
  });

  it("rejects malformed and unsorted runtime registrations before persistence", () => {
    const store = registry();
    expect(() => store.issueBootstrap({ runtimeId: "runtime_1", identityConfigFingerprint: identity, scopes: ["fs.write", "fs.read"] })).toThrow(/sorted/);
    expect(() => store.issueBootstrap({ runtimeId: "runtime_1", identityConfigFingerprint: identity, scopes: ["not.a.scope"] })).toThrow(/invalid/);
    store.close();
  });

  it("durably records a fully bound issuance and rejects runtime, scope, lease, plan, and nonce replays atomically", () => {
    const fixture = issuanceFixture();
    try {
      const recorded = fixture.registry.recordIssuance(fixture.binding);
      expect(recorded.requestHash).toMatch(/^[a-f0-9]{64}$/);
      const db = new DatabaseSync(fixture.dbPath);
      expect(db.prepare("SELECT runtime_id, lease_id, nonce_hash FROM desktop_commander_capability_issuances").all()).toHaveLength(1);
      expect(db.prepare("SELECT scope_name FROM desktop_commander_capability_issuance_scopes").all()).toEqual([{ scope_name: "fs.read" }]);
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
      expect(check.prepare("SELECT COUNT(*) AS count FROM desktop_commander_capability_issuances").get()).toEqual({ count: 1 });
      check.close();
    } finally {
      fixture.registry.close();
      fixture.store.close();
    }
  });

  it("rejects invalid capability TTLs before an issuance is stored", () => {
    const fixture = issuanceFixture();
    try {
      expect(() => fixture.registry.recordIssuance({ ...fixture.binding, expiresAt: fixture.binding.issuedAt })).toThrow(/expiration/);
      expect(() => fixture.registry.recordIssuance({ ...fixture.binding, expiresAt: new Date(Date.parse(fixture.binding.issuedAt) + 30_001).toISOString() })).toThrow(/expiration/);
      const db = new DatabaseSync(fixture.dbPath);
      expect(db.prepare("SELECT COUNT(*) AS count FROM desktop_commander_capability_issuances").get()).toEqual({ count: 0 });
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
      expect(() => fixture.registry.recordIssuance({ ...fixture.binding, approvalId: "approval_wrong", nonce: "B".repeat(43) })).toThrow(/approval/);
      expect(() => fixture.registry.recordIssuance({ ...fixture.binding, actionHash: hex("5"), nonce: "C".repeat(43) })).toThrow(/approval/);
      expect(db.prepare("SELECT COUNT(*) AS count FROM desktop_commander_capability_issuances").get()).toEqual({ count: 1 });
      db.close();
    } finally {
      fixture.registry.close();
      fixture.store.close();
    }
  });

  it("rejects missing, pending, expired, and request-mismatched approvals without recording an issuance", () => {
    const variants: Array<{ name: string; mutate: (fixture: ReturnType<typeof issuanceFixture>) => void; binding: (fixture: ReturnType<typeof issuanceFixture>) => object }> = [
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
          db.prepare("UPDATE execution_plan_approvals SET status = 'granted', consumed_at = NULL WHERE approval_id = ?").run(requiredApprovalId(fixture));
          db.close();
        },
        binding: () => ({})
      },
      {
        name: "expired approval",
        mutate: (fixture) => {
          const db = new DatabaseSync(fixture.dbPath);
          db.exec("DROP TRIGGER execution_plan_approvals_transition_guard");
          db.prepare("UPDATE execution_plan_approvals SET expires_at = ? WHERE approval_id = ?").run(new Date(Date.now() + 1).toISOString(), requiredApprovalId(fixture));
          db.close();
        },
        binding: () => ({})
      },
      {
        name: "request binding mismatch",
        mutate: (fixture) => {
          const db = new DatabaseSync(fixture.dbPath);
          db.exec("DROP TRIGGER execution_plan_approvals_transition_guard");
          db.prepare("UPDATE execution_plan_approvals SET request_hash = ? WHERE approval_id = ?").run(hex("9"), requiredApprovalId(fixture));
          db.close();
        },
        binding: () => ({})
      }
    ];

    for (const variant of variants) {
      const fixture = issuanceFixture(true);
      try {
        variant.mutate(fixture);
        expect(() => fixture.registry.recordIssuance({ ...fixture.binding, ...variant.binding(fixture), nonce: `${fixture.binding.nonce.slice(0, -1)}${variant.name.length}`.slice(0, 43) }), variant.name).toThrow(/approval/);
        const db = new DatabaseSync(fixture.dbPath);
        expect(db.prepare("SELECT COUNT(*) AS count FROM desktop_commander_capability_issuances").get(), variant.name).toEqual({ count: 0 });
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
      expect(db.prepare("SELECT COUNT(*) AS count FROM desktop_commander_capability_issuances").get()).toEqual({ count: 1 });
      db.close();
    } finally {
      fixture.registry.close();
      fixture.store.close();
    }
  });
});
