import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec, fork, spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createPolicyEngine, createWorkItemTools } from "@agent-control-stack/policy-gate";
import { stableHash } from "@agent-control-stack/shared";
import { SqliteWorkItemStore, type WorkItem } from "@agent-control-stack/work-items";
import { describe, expect, it, vi } from "vitest";
import { runWorkerOnce } from "./index.js";

vi.mock("node:child_process", () => ({
  exec: vi.fn(),
  fork: vi.fn(),
  spawn: vi.fn()
}));

const domainTransition = { via: "domain_service" } as const;

function approvalActionHash(workItem: WorkItem, actor: string): string {
  const decision = createPolicyEngine().evaluateWorkItem(workItem, actor, "approve")[0];
  if (!decision?.actionHash) {
    throw new Error(`missing approval action hash for ${workItem.id}`);
  }
  return decision.actionHash;
}

describe("worker policy gate", () => {
  it("simulates approved read-only work", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-worker-"));
    const dbPath = join(dir, "control.db");
    const store = new SqliteWorkItemStore(dbPath);
    const tools = createWorkItemTools(store, createPolicyEngine());

    try {
      const workItem = tools.create_work_item({
        title: "Read work",
        requester: "user",
        intent: "read source",
        target: { cwd: "/repo" },
        requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: ["src/index.ts"] } }],
        risk: "low"
      });
      store.close();

      const result = await runWorkerOnce({ dbPath, workerId: "test-worker" });
      const check = new SqliteWorkItemStore(dbPath);
      try {
        expect(result.executed).toBe(true);
        expect(check.get(workItem.id)?.status).toBe("succeeded");
        const db = new DatabaseSync(dbPath, { readOnly: true });
        try {
          expect(db.prepare("SELECT COUNT(*) AS count FROM execution_attempts").get()).toEqual({ count: 1 });
          expect(db.prepare("SELECT COUNT(*) AS count FROM attempt_leases").get()).toEqual({ count: 1 });
          expect(db.prepare("SELECT status FROM execution_attempts").get()).toEqual({ status: "succeeded" });
          expect(db.prepare("SELECT status FROM attempt_leases").get()).toEqual({ status: "consumed" });
        } finally {
          db.close();
        }
      } finally {
        check.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not manufacture a second active attempt after a worker restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-worker-restart-"));
    const dbPath = join(dir, "control.db");
    const store = new SqliteWorkItemStore(dbPath);
    const tools = createWorkItemTools(store, createPolicyEngine());

    try {
      const workItem = tools.create_work_item({
        title: "Restart authority",
        requester: "user",
        intent: "preserve one active execution authority",
        target: { cwd: "/repo" },
        requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: ["src/index.ts"] } }],
        risk: "low"
      });
      const claimed = tools.claim_next_approved_work_item({ workerId: "test-worker" });
      expect(claimed?.id).toBe(workItem.id);
      expect((claimed as (typeof claimed & { attemptId?: string }) | undefined)?.attemptId).toMatch(/^attempt_/u);
      expect(tools.claim_next_approved_work_item({ workerId: "test-worker" })).toBeUndefined();
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects stale or tampered attempt result bindings before terminalization", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-worker-authority-"));
    const dbPath = join(dir, "control.db");
    const store = new SqliteWorkItemStore(dbPath);
    const tools = createWorkItemTools(store, createPolicyEngine());

    try {
      tools.create_work_item({
        title: "Fenced result",
        requester: "user",
        intent: "reject forged result authority",
        target: { cwd: "/repo" },
        requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: ["README.md"] } }],
        risk: "low"
      });
      const claimed = tools.claim_next_approved_work_item({ workerId: "worker-a" });
      if (!claimed?.attemptId || !claimed.planHash || !claimed.inputHash || claimed.fencingEpoch === undefined) {
        throw new Error("expected authoritative claim");
      }
      const startedAt = new Date().toISOString();
      const result = {
        workItemId: claimed.id,
        attemptId: claimed.attemptId,
        leaseId: claimed.leaseId,
        workerId: "worker-a",
        actionHash: claimed.actionHash,
        planHash: claimed.planHash,
        inputHash: claimed.inputHash,
        fencingEpoch: claimed.fencingEpoch,
        idempotencyKey: stableAttemptResultKey(claimed.attemptId),
        outcome: "succeeded" as const,
        startedAt,
        finishedAt: startedAt,
        exitCode: 0,
        summary: "dry-run result",
        structuredOutput: { simulated: true },
        artifacts: [],
        simulationMetadata: { executionMode: "dry_run" as const, simulated: true }
      };
      expect(() => tools.submit_work_result({ ...result, workerId: "worker-b" })).toThrow(
        "result lease epoch is stale or mismatched"
      );
      expect(() => tools.submit_work_result({ ...result, fencingEpoch: result.fencingEpoch + 1 })).toThrow(
        "result lease epoch is stale or mismatched"
      );
      expect(() => tools.submit_work_result({ ...result, planHash: "f".repeat(64) })).toThrow(
        "result plan does not match"
      );
      expect(() => tools.submit_work_result({ ...result, inputHash: "e".repeat(64) })).toThrow(
        "result inputs do not match"
      );
      expect(store.get(claimed.id)?.status).toBe("running");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blocks approved write work without matching action approval", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-worker-"));
    const dbPath = join(dir, "control.db");
    const store = new SqliteWorkItemStore(dbPath);

    try {
      const workItem = store.create({
        title: "Write work",
        requester: "user",
        intent: "write source",
        target: { cwd: "/repo" },
        requestedActions: [{ kind: "fs.write", description: "write", params: { paths: ["src/index.ts"] } }],
        risk: "low"
      });
      store.approveWorkItem(workItem.id, domainTransition);
      store.close();

      const result = await runWorkerOnce({ dbPath, workerId: "test-worker" });
      const check = new SqliteWorkItemStore(dbPath);
      try {
        expect(result.executed).toBe(false);
        expect(check.get(workItem.id)?.status).toBe("blocked");
      } finally {
        check.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not execute work denied by claim-time policy", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-worker-denied-"));
    const dbPath = join(dir, "control.db");
    const store = new SqliteWorkItemStore(dbPath);

    try {
      const workItem = store.create({
        title: "Denied shell work",
        requester: "user",
        intent: "verify denied work never reaches execution",
        target: { cwd: "/repo" },
        requestedActions: [{ kind: "shell", description: "sudo", params: { command: ["sudo", "whoami"] } }],
        risk: "low"
      });
      expect(store.approveWorkItem(workItem.id, domainTransition).status).toBe("approved");
      store.close();
      vi.clearAllMocks();

      const result = await runWorkerOnce({ dbPath, workerId: "test-worker" });
      const check = new SqliteWorkItemStore(dbPath);
      try {
        expect(result).toEqual({ executed: false, workItemId: workItem.id, reason: "blocked by policy" });
        expect(check.get(workItem.id)?.status).toBe("blocked");
        expect(spawn).not.toHaveBeenCalled();
        expect(exec).not.toHaveBeenCalled();
        expect(fork).not.toHaveBeenCalled();
      } finally {
        check.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not execute write work with a forged approval action hash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-worker-forged-approval-"));
    const dbPath = join(dir, "control.db");
    const store = new SqliteWorkItemStore(dbPath);
    const tools = createWorkItemTools(store, createPolicyEngine());

    try {
      const workItem = tools.create_work_item({
        title: "Forged write approval",
        requester: "user",
        intent: "verify a forged action hash cannot authorize execution",
        target: { cwd: "/repo" },
        requestedActions: [{ kind: "fs.write", description: "write", params: { paths: ["src/index.ts"] } }],
        risk: "low"
      });

      expect(() =>
        tools.approve_work_item({
          id: workItem.id,
          approvedBy: "approver",
          reason: "forged approval",
          actionHash: "forged-action-hash"
        })
      ).toThrow("approval action hash does not match work item");
      expect(store.get(workItem.id)?.status).toBe("needs_approval");
      store.close();
      vi.clearAllMocks();

      const result = await runWorkerOnce({ dbPath, workerId: "test-worker" });
      const check = new SqliteWorkItemStore(dbPath);
      try {
        expect(result).toEqual({ executed: false, reason: "no approved work item" });
        expect(check.get(workItem.id)?.status).toBe("needs_approval");
        expect(spawn).not.toHaveBeenCalled();
        expect(exec).not.toHaveBeenCalled();
        expect(fork).not.toHaveBeenCalled();
      } finally {
        check.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blocks approved write work even with a matching action approval", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-worker-"));
    const dbPath = join(dir, "control.db");
    const store = new SqliteWorkItemStore(dbPath);
    const tools = createWorkItemTools(store, createPolicyEngine());

    try {
      const workItem = tools.create_work_item({
        title: "Approved write work",
        requester: "user",
        intent: "write source",
        target: { cwd: "/repo" },
        requestedActions: [{ kind: "fs.write", description: "write", params: { paths: ["src/index.ts"] } }],
        risk: "low"
      });
      expect(workItem.status).toBe("needs_approval");

      const approval = tools.approve_work_item({
        id: workItem.id,
        approvedBy: "user",
        reason: "approve exact write action",
        actionHash: approvalActionHash(workItem, "user")
      });
      expect(approval.workItem.status).toBe("approved");
      store.close();

      const result = await runWorkerOnce({ dbPath, workerId: "test-worker" });
      const check = new SqliteWorkItemStore(dbPath);
      try {
        const events = check.readEvents().map((event) => event.name);
        const blockedEvent = check.readEvents().find((event) => event.name === "work_item.blocked");
        expect(result).toEqual({
          executed: false,
          workItemId: workItem.id,
          reason: "worker supports read-only repository inspection only"
        });
        expect(check.get(workItem.id)?.status).toBe("blocked");
        expect(events).toContain("approval.granted");
        expect(events).toContain("approval.consumed");
        expect(events).toContain("work_item.blocked");
        expect(events).not.toContain("work_item.succeeded");
        expect(blockedEvent?.body.result).toMatchObject({
          outcome: "blocked",
          executionMode: "dry_run",
          error: "worker_read_only_scope"
        });
        expect(blockedEvent?.attributes).toMatchObject({ "execution.mode": "dry_run" });
        expect(spawn).not.toHaveBeenCalled();
        expect(exec).not.toHaveBeenCalled();
        expect(fork).not.toHaveBeenCalled();
      } finally {
        check.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function stableAttemptResultKey(attemptId: string): string {
  return stableHash({ domain: "acs.attempt-result.v1", attemptId });
}
