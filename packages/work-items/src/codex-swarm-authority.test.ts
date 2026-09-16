import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { controlPlaneMigrations } from "@agent-control-stack/shared";
import { describe, expect, it } from "vitest";
import { defaultExecutionPlanForWorkItem } from "./execution-plan.js";
import { SqliteWorkItemStore } from "./store.js";

const hash = (value: string) => value.repeat(64).slice(0, 64);

const providerBinding = {
  contextHash: hash("a"),
  proofBindingHash: hash("b"),
  providerGeneration: 1,
  sessionEpochBindingHash: hash("c")
};

const raceWorkerUrl = new URL("./concurrency-race-worker.ts", import.meta.url);

async function concurrentlyCancel(dbPath: string, cancellation: object) {
  const barrier = new SharedArrayBuffer(4);
  const workers = [0, 1].map(
    () =>
      new Worker(raceWorkerUrl, {
        execArgv: ["--import", "tsx"],
        workerData: { kind: "codex_cancel", dbPath, cancellation, barrier }
      })
  );
  try {
    return await Promise.all(
      workers.map(
        (worker) =>
          new Promise<{ ok: boolean; value?: unknown; error?: unknown }>((resolve, reject) => {
            worker.once("message", resolve);
            worker.once("error", reject);
          })
      )
    );
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
}

function databaseOf(store: SqliteWorkItemStore) {
  return (store as unknown as {
    db: { prepare(query: string): { get(...params: unknown[]): unknown; run(...params: unknown[]): unknown } };
  }).db;
}

function createCancellableAttempt(store: SqliteWorkItemStore, options: { ttlMs?: number } = {}) {
  store.registerActor({ id: "actor-user", actorType: "HUMAN", displayName: "requester" });
  store.registerActor({ id: "actor-attacker", actorType: "HUMAN", displayName: "attacker" });
  const workItem = store.create({ title: "durable cancellation", requester: "user", requesterSubject: "actor-user", intent: "test", target: { cwd: "/repo", files: ["src/index.ts"] }, requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: ["src/index.ts"], write: false } }], risk: "low" });
  const plan = store.createExecutionPlan({ workItemId: workItem.id, definition: defaultExecutionPlanForWorkItem(workItem), createdByActorId: "actor-user" });
  const admission = store.admitExecutionPlan({ workItemId: workItem.id, planHash: plan.planHash, policyVersion: "acs.policy.v1", policyDecisionHash: hash("d"), requiresApproval: false, admittedByActorId: "policy-gate" }, { via: "policy_gate" });
  const attempt = store.createAttempt({ workItemId: workItem.id, planHash: plan.planHash, inputHash: hash("e") }, { via: "domain_service" });
  const lease = store.leaseAttempt({ attemptId: attempt.attemptId, workItemId: workItem.id, admissionId: admission.admissionId, workerId: "worker-1", leaseToken: "x".repeat(32), policyVersion: "acs.policy.v1", policyDecisionHash: hash("d"), ttlMs: options.ttlMs ?? 60_000 }, { via: "domain_service" });
  store.recordWorkspaceAllocation({ allocationId: "workspace-cancel-1", workItemId: workItem.id, attemptId: attempt.attemptId, leaseId: lease.leaseId, workerId: lease.workerId, fencingEpoch: lease.fencingEpoch, hostPath: "/isolated/workspace-cancel-1", branch: "acs/test", baseRef: "HEAD" }, { via: "domain_service" });
  return { workItem, attempt, lease };
}

function cancellationSideEffectCounts(database: { prepare(query: string): { get(...params: unknown[]): unknown; run(...params: unknown[]): unknown } }): {
  receipts: number;
  supervision: number;
} {
  return {
    receipts: (database.prepare("SELECT COUNT(*) AS count FROM codex_swarm_cancellation_receipts").get() as {
      count: number;
    }).count,
    supervision: (database.prepare("SELECT COUNT(*) AS count FROM codex_swarm_cancellation_supervision").get() as {
      count: number;
    }).count
  };
}

describe("Codex Swarm durable authority migration", () => {
  it("registers and applies migration 023 through the canonical store", () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-codex-swarm-authority-"));
    try {
      expect(controlPlaneMigrations()).toContainEqual(
        expect.objectContaining({ version: 23, name: "codex_swarm_authoritative_store", filename: "023_codex_swarm_authoritative_store.sql" })
      );
      const store = new SqliteWorkItemStore(join(directory, "control.db"));
      expect(store.health().checks.migrations).toEqual({ ok: true });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("atomically reserves a current tuple and replays only the identical dispatch", () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-codex-swarm-authority-"));
    try {
      const store = new SqliteWorkItemStore(join(directory, "control.db"));
      const workItem = store.create({ title: "durable authority", requester: "user", requesterSubject: "actor-user", intent: "test", target: { cwd: "/repo", files: ["src/index.ts"] }, requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: ["src/index.ts"], write: false } }], risk: "low" });
      const plan = store.createExecutionPlan({ workItemId: workItem.id, definition: defaultExecutionPlanForWorkItem(workItem), createdByActorId: "actor-user" });
      const admission = store.admitExecutionPlan({ workItemId: workItem.id, planHash: plan.planHash, policyVersion: "acs.policy.v1", policyDecisionHash: hash("a"), requiresApproval: false, admittedByActorId: "policy-gate" }, { via: "policy_gate" });
      const attempt = store.createAttempt({ workItemId: workItem.id, planHash: plan.planHash, inputHash: hash("b") }, { via: "domain_service" });
      const lease = store.leaseAttempt({ attemptId: attempt.attemptId, workItemId: workItem.id, admissionId: admission.admissionId, workerId: "worker-1", leaseToken: "x".repeat(32), policyVersion: "acs.policy.v1", policyDecisionHash: hash("a"), ttlMs: 60_000 }, { via: "domain_service" });
      store.recordWorkspaceAllocation({ allocationId: "workspace-1", workItemId: workItem.id, attemptId: attempt.attemptId, leaseId: lease.leaseId, workerId: lease.workerId, fencingEpoch: lease.fencingEpoch, hostPath: "/isolated/workspace-1", branch: "acs/test", baseRef: "HEAD" }, { via: "domain_service" });
      const authority = store as unknown as { reserveCodexSwarmDispatch(input: { workItemId: string; attemptId: string; leaseId: string; fencingEpoch: number; envelopeHash: string; idempotencyKey: string }): { kind: string } };
      const input = { workItemId: workItem.id, attemptId: attempt.attemptId, leaseId: lease.leaseId, fencingEpoch: lease.fencingEpoch, envelopeHash: hash("c"), idempotencyKey: "dispatch-1" };
      expect(authority.reserveCodexSwarmDispatch(input)).toEqual({ kind: "reserved" });
      expect(authority.reserveCodexSwarmDispatch(input)).toEqual({ kind: "replay" });
      expect(authority.reserveCodexSwarmDispatch({ ...input, envelopeHash: hash("d") })).toEqual({ kind: "conflict" });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("fails closed without a current provider binding", () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-codex-swarm-authority-"));
    try {
      const store = new SqliteWorkItemStore(join(directory, "control.db"));
      store.registerActor({ id: "actor-canceller", actorType: "HUMAN", displayName: "canceller" });
      expect(
        store.cancelCodexSwarmAttempt({
          requestId: "cancel-1",
          workItemId: "work-1",
          attemptId: "attempt-1",
          leaseId: "lease-1",
          fencingEpoch: 1,
          authenticatedPrincipalId: "actor-canceller",
          canonicalIntentHash: hash("a"),
          providerBinding: { contextHash: hash("b"), proofBindingHash: hash("c"), providerGeneration: 1, sessionEpochBindingHash: hash("d") }
        })
      ).toEqual({ kind: "denied", reason: "codex_swarm_cancel_provider_revoked" });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("denies a different registered principal without durable effects", () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-codex-swarm-authority-"));
    try {
      const store = new SqliteWorkItemStore(join(directory, "control.db"), {
        currentProviderBindingValidator: { validateCurrent: () => ({ kind: "current" }) }
      });
      const { workItem, attempt, lease } = createCancellableAttempt(store);
      const database = databaseOf(store);
      const before = {
        workItemStatus: store.get(workItem.id)?.status,
        attemptStatus: store.getAttempt(attempt.attemptId)?.status,
        leaseStatus: (database.prepare("SELECT status FROM attempt_leases WHERE lease_id = ?").get(lease.leaseId) as { status: string }).status
      };

      expect(
        store.cancelCodexSwarmAttempt({
          requestId: "cancel-attacker-1",
          workItemId: workItem.id,
          attemptId: attempt.attemptId,
          leaseId: lease.leaseId,
          fencingEpoch: lease.fencingEpoch,
          authenticatedPrincipalId: "actor-attacker",
          canonicalIntentHash: hash("f"),
          providerBinding
        })
      ).toEqual({ kind: "denied", reason: "codex_swarm_cancel_binding_invalid" });
      expect({
        workItemStatus: store.get(workItem.id)?.status,
        attemptStatus: store.getAttempt(attempt.attemptId)?.status,
        leaseStatus: (database.prepare("SELECT status FROM attempt_leases WHERE lease_id = ?").get(lease.leaseId) as { status: string }).status
      }).toEqual(before);
      expect(cancellationSideEffectCounts(database)).toEqual({ receipts: 0, supervision: 0 });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("commits only the work-item requester cancellation and replays it after reopening", () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-codex-swarm-authority-"));
    const dbPath = join(directory, "control.db");
    try {
      const store = new SqliteWorkItemStore(dbPath, {
        currentProviderBindingValidator: { validateCurrent: () => ({ kind: "current" }) }
      });
      const { workItem, attempt, lease } = createCancellableAttempt(store);
      const cancellation = {
        requestId: "cancel-current-1",
        workItemId: workItem.id,
        attemptId: attempt.attemptId,
        leaseId: lease.leaseId,
        fencingEpoch: lease.fencingEpoch,
        authenticatedPrincipalId: "actor-user",
        canonicalIntentHash: hash("f"),
        providerBinding
      };

      const committed = store.cancelCodexSwarmAttempt(cancellation);
      expect(committed).toMatchObject({ kind: "committed", replay: false });
      if (committed.kind !== "committed") throw new Error("expected committed cancellation");
      expect(store.getAttempt(attempt.attemptId)?.status).toBe("cancellation_requested");

      const reopened = new SqliteWorkItemStore(dbPath, {
        currentProviderBindingValidator: { validateCurrent: () => ({ kind: "current" }) }
      });
      const replay = reopened.cancelCodexSwarmAttempt(cancellation);
      expect(replay).toEqual({ ...committed, kind: "replay", replay: true });
      if (replay.kind !== "replay") throw new Error("expected replayed cancellation");
      expect(replay.serializedOutcome).toBe(committed.serializedOutcome);
      expect(replay.outcomeHash).toBe(committed.outcomeHash);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("rejects a reused request id when its canonical request binding changes", () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-codex-swarm-authority-"));
    try {
      const store = new SqliteWorkItemStore(join(directory, "control.db"), {
        currentProviderBindingValidator: { validateCurrent: () => ({ kind: "current" }) }
      });
      const { workItem, attempt, lease } = createCancellableAttempt(store);
      const cancellation = {
        requestId: "cancel-binding-conflict-1",
        workItemId: workItem.id,
        attemptId: attempt.attemptId,
        leaseId: lease.leaseId,
        fencingEpoch: lease.fencingEpoch,
        authenticatedPrincipalId: "actor-user",
        canonicalIntentHash: hash("f"),
        providerBinding
      };

      expect(store.cancelCodexSwarmAttempt(cancellation)).toMatchObject({ kind: "committed", replay: false });
      expect(
        store.cancelCodexSwarmAttempt({ ...cancellation, canonicalIntentHash: hash("e") })
      ).toEqual({ kind: "conflict", reason: "cancellation_request_key_conflict" });
      expect(
        store.cancelCodexSwarmAttempt({ ...cancellation, requestId: "cancel-binding-conflict-2", leaseId: "other-lease" })
      ).toEqual({ kind: "denied", reason: "codex_swarm_cancel_binding_invalid" });
      expect(cancellationSideEffectCounts(databaseOf(store))).toEqual({ receipts: 1, supervision: 1 });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("serializes same-request cancellation through independent worker connections", async () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-codex-swarm-authority-"));
    const dbPath = join(directory, "control.db");
    try {
      const store = new SqliteWorkItemStore(dbPath, {
        currentProviderBindingValidator: { validateCurrent: () => ({ kind: "current" }) }
      });
      const { workItem, attempt, lease } = createCancellableAttempt(store);
      const cancellation = {
        requestId: "cancel-parallel-1",
        workItemId: workItem.id,
        attemptId: attempt.attemptId,
        leaseId: lease.leaseId,
        fencingEpoch: lease.fencingEpoch,
        authenticatedPrincipalId: "actor-user",
        canonicalIntentHash: hash("f"),
        providerBinding
      };
      store.close();
      const outcomes = await concurrentlyCancel(dbPath, cancellation);
      expect(outcomes).toHaveLength(2);
      expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
      expect(outcomes.map((outcome) => outcome.value)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "committed", replay: false }),
          expect.objectContaining({ kind: "replay", replay: true })
        ])
      );
      const check = new SqliteWorkItemStore(dbPath, {
        currentProviderBindingValidator: { validateCurrent: () => ({ kind: "current" }) }
      });
      expect(cancellationSideEffectCounts(databaseOf(check))).toEqual({ receipts: 1, supervision: 1 });
      expect(check.getAttempt(attempt.attemptId)?.status).toBe("cancellation_requested");
      check.close();
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("fails closed when a reserved child start arrives after its lease expires", async () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-codex-swarm-authority-"));
    try {
      const store = new SqliteWorkItemStore(join(directory, "control.db"));
      const { workItem, attempt, lease } = createCancellableAttempt(store, { ttlMs: 1_000 });
      const tuple = {
        workItemId: workItem.id,
        attemptId: attempt.attemptId,
        leaseId: lease.leaseId,
        fencingEpoch: lease.fencingEpoch,
        envelopeHash: hash("c"),
        idempotencyKey: "dispatch-expired-completion"
      };
      expect(store.reserveCodexSwarmDispatch(tuple)).toEqual({ kind: "reserved" });
      const database = databaseOf(store);
      await new Promise((resolve) => setTimeout(resolve, 1_100));

      expect(store.completeCodexSwarmDispatchStart(tuple, { kind: "started" })).toEqual({ kind: "conflict" });
      expect(
        database.prepare("SELECT start_status, completed_at FROM codex_swarm_dispatch_reservations WHERE idempotency_key = ?").get(tuple.idempotencyKey)
      ).toEqual({ start_status: "reserved", completed_at: null });
      expect(cancellationSideEffectCounts(database)).toEqual({ receipts: 0, supervision: 0 });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("fails closed when an old reservation is superseded by a replacement fence", () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-codex-swarm-authority-"));
    try {
      const store = new SqliteWorkItemStore(join(directory, "control.db"));
      const { workItem, attempt, lease } = createCancellableAttempt(store);
      const tuple = {
        workItemId: workItem.id,
        attemptId: attempt.attemptId,
        leaseId: lease.leaseId,
        fencingEpoch: lease.fencingEpoch,
        envelopeHash: hash("c"),
        idempotencyKey: "dispatch-replaced-completion"
      };
      expect(store.reserveCodexSwarmDispatch(tuple)).toEqual({ kind: "reserved" });
      const database = databaseOf(store);
      const now = new Date().toISOString();
      database.prepare("UPDATE attempt_leases SET status = 'revoked', closed_at = ? WHERE lease_id = ?").run(now, lease.leaseId);
      database
        .prepare("UPDATE execution_attempts SET status = 'interrupted', updated_at = ? WHERE attempt_id = ?")
        .run(now, attempt.attemptId);
      const replacement = store.leaseAttempt(
        {
          attemptId: attempt.attemptId,
          workItemId: workItem.id,
          admissionId: store.getActiveLeaseForAttempt(attempt.attemptId)?.admissionId ?? "missing-admission",
          workerId: "worker-replacement",
          leaseToken: "y".repeat(32),
          policyVersion: "acs.policy.v1",
          policyDecisionHash: hash("d"),
          ttlMs: 60_000
        },
        { via: "domain_service" }
      );
      expect(replacement.fencingEpoch).toBe(lease.fencingEpoch + 1);

      expect(store.completeCodexSwarmDispatchStart(tuple, { kind: "started" })).toEqual({ kind: "conflict" });
      expect(
        database.prepare("SELECT start_status, completed_at FROM codex_swarm_dispatch_reservations WHERE idempotency_key = ?").get(tuple.idempotencyKey)
      ).toEqual({ start_status: "reserved", completed_at: null });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("fails closed when cancellation supersedes a reserved child start", () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-codex-swarm-authority-"));
    try {
      const store = new SqliteWorkItemStore(join(directory, "control.db"), {
        currentProviderBindingValidator: { validateCurrent: () => ({ kind: "current" }) }
      });
      const { workItem, attempt, lease } = createCancellableAttempt(store);
      const tuple = {
        workItemId: workItem.id,
        attemptId: attempt.attemptId,
        leaseId: lease.leaseId,
        fencingEpoch: lease.fencingEpoch,
        envelopeHash: hash("c"),
        idempotencyKey: "dispatch-cancelled-completion"
      };
      expect(store.reserveCodexSwarmDispatch(tuple)).toEqual({ kind: "reserved" });
      expect(
        store.cancelCodexSwarmAttempt({
          requestId: "cancel-before-child-start",
          workItemId: workItem.id,
          attemptId: attempt.attemptId,
          leaseId: lease.leaseId,
          fencingEpoch: lease.fencingEpoch,
          authenticatedPrincipalId: "actor-user",
          canonicalIntentHash: hash("f"),
          providerBinding
        })
      ).toMatchObject({ kind: "committed", replay: false });
      expect(store.completeCodexSwarmDispatchStart(tuple, { kind: "started" })).toEqual({ kind: "conflict" });
      expect(
        databaseOf(store)
          .prepare("SELECT start_status, completed_at FROM codex_swarm_dispatch_reservations WHERE idempotency_key = ?")
          .get(tuple.idempotencyKey)
      ).toEqual({ start_status: "cancelled", completed_at: expect.any(String) });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it("persists a failed child start exactly once and survives reopening the canonical store", () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-codex-swarm-authority-"));
    const dbPath = join(directory, "control.db");
    try {
      const store = new SqliteWorkItemStore(dbPath);
      const workItem = store.create({ title: "durable failed start", requester: "user", requesterSubject: "actor-user", intent: "test", target: { cwd: "/repo", files: ["src/index.ts"] }, requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: ["src/index.ts"], write: false } }], risk: "low" });
      const plan = store.createExecutionPlan({ workItemId: workItem.id, definition: defaultExecutionPlanForWorkItem(workItem), createdByActorId: "actor-user" });
      const admission = store.admitExecutionPlan({ workItemId: workItem.id, planHash: plan.planHash, policyVersion: "acs.policy.v1", policyDecisionHash: hash("a"), requiresApproval: false, admittedByActorId: "policy-gate" }, { via: "policy_gate" });
      const attempt = store.createAttempt({ workItemId: workItem.id, planHash: plan.planHash, inputHash: hash("b") }, { via: "domain_service" });
      const lease = store.leaseAttempt({ attemptId: attempt.attemptId, workItemId: workItem.id, admissionId: admission.admissionId, workerId: "worker-1", leaseToken: "x".repeat(32), policyVersion: "acs.policy.v1", policyDecisionHash: hash("a"), ttlMs: 60_000 }, { via: "domain_service" });
      store.recordWorkspaceAllocation({ allocationId: "workspace-1", workItemId: workItem.id, attemptId: attempt.attemptId, leaseId: lease.leaseId, workerId: lease.workerId, fencingEpoch: lease.fencingEpoch, hostPath: "/isolated/workspace-1", branch: "acs/test", baseRef: "HEAD" }, { via: "domain_service" });
      const tuple = { workItemId: workItem.id, attemptId: attempt.attemptId, leaseId: lease.leaseId, fencingEpoch: lease.fencingEpoch, envelopeHash: hash("c"), idempotencyKey: "dispatch-failed-start" };
      expect(store.reserveCodexSwarmDispatch(tuple)).toEqual({ kind: "reserved" });

      expect(store.completeCodexSwarmDispatchStart(tuple, { kind: "failed_start", reason: "untrusted child error" })).toEqual({ kind: "completed" });
      expect(store.completeCodexSwarmDispatchStart(tuple, { kind: "failed_start", reason: "untrusted child error" })).toEqual({ kind: "replay" });
      expect(store.completeCodexSwarmDispatchStart(tuple, { kind: "started" })).toEqual({ kind: "conflict" });

      const reopened = new SqliteWorkItemStore(dbPath);
      expect(reopened.completeCodexSwarmDispatchStart(tuple, { kind: "failed_start", reason: "untrusted child error" })).toEqual({ kind: "replay" });
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });
});
