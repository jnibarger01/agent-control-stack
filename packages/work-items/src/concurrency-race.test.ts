import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { Worker } from "node:worker_threads";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stableHash } from "@agent-control-stack/shared";
import { SqliteWorkItemStore, defaultExecutionPlanForWorkItem } from "./index.js";

const transition = { via: "domain_service" as const };
const workerUrl = new URL("./concurrency-race-worker.ts", import.meta.url);

function hex(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}

async function race(input: Record<string, unknown>): Promise<Array<{ ok: boolean; value?: any; error?: any }>> {
  const barrier = new SharedArrayBuffer(4);
  const workers = [0, 1].map(
    (index) =>
      new Worker(workerUrl, {
        execArgv: ["--import", "tsx"],
        workerData: { ...input, workerId: `race-${index}`, barrier }
      })
  );
  const results = await Promise.all(
    workers.map(
      (worker) =>
        new Promise<any>((resolve, reject) => {
          worker.once("message", resolve);
          worker.once("error", reject);
        })
    )
  );
  await Promise.all(workers.map((worker) => worker.terminate()));
  return results;
}

function item(store: SqliteWorkItemStore) {
  return store.create({
    title: "race",
    requester: "agent",
    intent: "race",
    target: { cwd: "/tmp" },
    requestedActions: [{ kind: "test", description: "race" }],
    risk: "low"
  });
}

describe("deterministic multi-connection concurrency invariants", () => {
  it("issues one lease and one fencing epoch under competing workers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-race-lease-"));
    const path = join(dir, "control.db");
    const store = new SqliteWorkItemStore(path);
    const workItem = item(store);
    const plan = store.createExecutionPlan({
      workItemId: workItem.id,
      definition: defaultExecutionPlanForWorkItem(workItem),
      createdByActorId: "seed"
    });
    const admission = store.admitExecutionPlan(
      {
        workItemId: workItem.id,
        planHash: plan.planHash,
        policyVersion: "acs.policy.v1",
        policyDecisionHash: hex("a"),
        requiresApproval: false,
        admittedByActorId: "policy"
      },
      { via: "policy_gate" }
    );
    const attempt = store.createAttempt(
      { workItemId: workItem.id, planHash: plan.planHash, inputHash: hex("b") },
      transition
    );
    store.close();
    const results = await race({
      kind: "lease",
      dbPath: path,
      input: {
        attemptId: attempt.attemptId,
        workItemId: workItem.id,
        admissionId: admission.admissionId,
        leaseToken: "a".repeat(32),
        policyVersion: "acs.policy.v1",
        policyDecisionHash: hex("a"),
        ttlMs: 60_000
      }
    });
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(
      results.filter((r) => !r.ok && ["attempt_not_leasable", "attempt_conflict"].includes(r.error.code))
    ).toHaveLength(1);
    const check = new SqliteWorkItemStore(path);
    expect(check.getAttempt(attempt.attemptId)?.currentFencingEpoch).toBe(1);
    expect(check.readEvents().filter((e) => e.name === "attempt_lease.issued")).toHaveLength(1);
    check.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // Eight real worker-process races can exceed Vitest's 5s default on hosted runners.
  it("lets exactly one claimant win, repeatedly", async () => {
    for (let round = 0; round < 8; round++) {
      const dir = mkdtempSync(join(tmpdir(), "acs-race-claim-"));
      const path = join(dir, "control.db");
      const store = new SqliteWorkItemStore(path);
      const workItem = item(store);
      store.approveWorkItem(workItem.id, transition);
      store.close();
      const results = await race({ kind: "claim", dbPath: path });
      expect(results.filter((r) => r.ok && r.value)).toHaveLength(1);
      expect(results.filter((r) => r.ok && !r.value)).toHaveLength(1);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it("consumes an approval once and emits one audit event", async () => {
    for (let round = 0; round < 8; round++) {
      const dir = mkdtempSync(join(tmpdir(), "acs-race-approval-"));
      const path = join(dir, "control.db");
      const store = new SqliteWorkItemStore(path);
      const workItem = item(store);
      const actionHash = stableHash({ round, action: "approve" });
      store.recordApproval({ workItemId: workItem.id, actionHash, approvedBy: "approver", expiresInMs: 60_000 });
      store.close();
      const results = await race({ kind: "consume", dbPath: path, workItemId: workItem.id, actionHash });
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok && r.error.code === "approval_not_granted")).toHaveLength(1);
      const check = new SqliteWorkItemStore(path);
      expect(check.readEvents().filter((e) => e.name === "approval.consumed")).toHaveLength(1);
      check.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  it("accepts one result and keeps all loser/replay writes idempotent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-race-result-"));
    const path = join(dir, "control.db");
    const store = new SqliteWorkItemStore(path);
    const workItem = item(store);
    store.approveWorkItem(workItem.id, transition);
    const claimed = store.claimNextApprovedWorkItem("seed", { allowLegacyClaimForTests: true });
    if (!claimed) throw new Error("expected claim");
    const input = {
      workItemId: claimed.id,
      leaseId: claimed.leaseId,
      workerId: claimed.workerId,
      actionHash: claimed.actionHash,
      idempotencyKey: stableHash({ result: claimed.leaseId }),
      outcome: "succeeded",
      startedAt: claimed.startedAt,
      finishedAt: claimed.startedAt,
      exitCode: 0,
      summary: "race",
      stdout: "",
      stderr: "",
      structuredOutput: {},
      artifacts: [],
      simulationMetadata: { executionMode: "dry_run", simulated: true }
    };
    store.close();
    const results = await race({ kind: "result", dbPath: path, input });
    expect(results.filter((r) => r.ok)).toHaveLength(2);
    const check = new SqliteWorkItemStore(path);
    expect(check.readEvents().filter((e) => e.name === "execution_result.accepted")).toHaveLength(1);
    check.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("serializes a retry-versus-cancellation race", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-race-retry-cancel-"));
    const path = join(dir, "control.db");
    const store = new SqliteWorkItemStore(path);
    const workItem = item(store);
    store.approveWorkItem(workItem.id, transition);
    store.claimNextApprovedWorkItem("seed", { allowLegacyClaimForTests: true });
    store.close();
    const barrier = new SharedArrayBuffer(4);
    const workers = (["retry", "cancel"] as const).map(
      (op) =>
        new Worker(workerUrl, {
          execArgv: ["--import", "tsx"],
          workerData: { kind: "mixed", op, dbPath: path, workItemId: workItem.id, actor: "seed", barrier }
        })
    );
    const results = await Promise.all(
      workers.map(
        (worker) =>
          new Promise<any>((resolve, reject) => {
            worker.once("message", resolve);
            worker.once("error", reject);
          })
      )
    );
    await Promise.all(workers.map((worker) => worker.terminate()));
    expect(results.filter((r) => r.ok).length).toBeGreaterThanOrEqual(1);
    expect(results.filter((r) => !r.ok).length).toBeLessThanOrEqual(1);
    const check = new SqliteWorkItemStore(path);
    const terminalEvents = check
      .readEvents()
      .filter((e) => e.name === "work_item.retried" || e.name === "work_item.cancelled");
    expect(terminalEvents.length).toBeGreaterThanOrEqual(1);
    expect(terminalEvents.filter((e) => e.name === "work_item.retried").length).toBeLessThanOrEqual(1);
    expect(terminalEvents.filter((e) => e.name === "work_item.cancelled").length).toBeLessThanOrEqual(1);
    check.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
