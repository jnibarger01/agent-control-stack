import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec, fork, spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createPolicyEngine, createWorkItemTools } from "@agent-control-stack/policy-gate";
import { SqliteWorkItemStore, type ClaimedWorkItem, type WorkItem } from "@agent-control-stack/work-items";
import { describe, expect, it, vi } from "vitest";
import { runWorkerOnce, workerResultIdempotencyKey } from "./index.js";

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
      } finally {
        check.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records a fenced failed attempt when dry-run execution reports failure", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-worker-failed-attempt-"));
    const dbPath = join(dir, "control.db");
    const store = new SqliteWorkItemStore(dbPath);
    const tools = createWorkItemTools(store, createPolicyEngine());
    try {
      const workItem = tools.create_work_item(readOnlyInput("Failed dry-run attempt"));
      store.close();
      const result = await runWorkerOnce({
        dbPath,
        workerId: "test-worker",
        execute: async () => ({
          ok: false,
          executionMode: "dry_run",
          output: "",
          error: "simulated bounded failure"
        })
      });
      const check = new SqliteWorkItemStore(dbPath);
      try {
        expect(result.executed).toBe(true);
        expect(check.get(workItem.id)).toMatchObject({
          status: "failed",
          result: { outcome: "failed", summary: "dry-run simulation failed; no real command ran" }
        });
        const db = new DatabaseSync(dbPath, { readOnly: true });
        try {
          expect(db.prepare(`SELECT status, outcome_code FROM execution_attempts`).get()).toEqual({
            status: "failed",
            outcome_code: "failed"
          });
        } finally {
          db.close();
        }
      } finally {
        check.close();
      }
    } finally {
      try {
        store.close();
      } catch {
        // The worker setup already closed this handle.
      }
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

  it("persists one authoritative attempt and does not duplicate a crashed claim", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-worker-attempt-crash-"));
    const dbPath = join(dir, "control.db");
    const store = new SqliteWorkItemStore(dbPath);
    const tools = createWorkItemTools(store, createPolicyEngine());
    try {
      tools.create_work_item(readOnlyInput("Crash-resume authority"));
      const claimed = tools.claim_next_approved_work_item({ workerId: "worker-a" });
      expect(claimed).toMatchObject({
        status: "running",
        workerId: "worker-a",
        fencingEpoch: 1
      });
      expect(claimed?.attemptId).toMatch(/^attempt_/u);
      expect(claimed?.planHash).toMatch(/^[a-f0-9]{64}$/u);
      expect(claimed?.inputHash).toMatch(/^[a-f0-9]{64}$/u);
      expect(claimed?.workspaceHash).toMatch(/^[a-f0-9]{64}$/u);
      expect(tools.claim_next_approved_work_item({ workerId: "worker-a" })).toBeUndefined();
      store.close();

      const resumed = new SqliteWorkItemStore(dbPath);
      try {
        expect(
          createWorkItemTools(resumed, createPolicyEngine()).claim_next_approved_work_item({
            workerId: "worker-a"
          })
        ).toBeUndefined();
        const db = new DatabaseSync(dbPath, { readOnly: true });
        try {
          expect(db.prepare(`SELECT COUNT(*) AS count FROM execution_attempts`).get()).toEqual({ count: 1 });
          expect(db.prepare(`SELECT status FROM execution_attempts`).get()).toEqual({ status: "running" });
        } finally {
          db.close();
        }
      } finally {
        resumed.close();
      }
    } finally {
      try {
        store.close();
      } catch {
        // The simulated crash path already closed this handle.
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects omitted, stale, and tampered attempt bindings, then accepts one replay-safe result", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-worker-attempt-result-"));
    const dbPath = join(dir, "control.db");
    const store = new SqliteWorkItemStore(dbPath);
    const tools = createWorkItemTools(store, createPolicyEngine());
    try {
      tools.create_work_item(readOnlyInput("Attempt result authority"));
      const claimed = tools.claim_next_approved_work_item({ workerId: "worker-a" });
      if (!claimed?.attemptId || !claimed.planHash || !claimed.inputHash || claimed.fencingEpoch === undefined) {
        throw new Error("expected authoritative attempt claim");
      }
      const input = authoritativeResult(claimed);
      const legacy: Partial<typeof input> = { ...input };
      delete legacy.attemptId;
      delete legacy.planHash;
      delete legacy.inputHash;
      delete legacy.fencingEpoch;
      expect(() => tools.submit_work_result(legacy)).toThrow("attemptId, planHash, inputHash, and fencingEpoch");
      expect(() => tools.submit_work_result({ ...input, fencingEpoch: input.fencingEpoch + 1 })).toThrow(
        "lease epoch is stale or mismatched"
      );
      expect(() => tools.submit_work_result({ ...input, planHash: "f".repeat(64) })).toThrow(
        "result plan does not match"
      );
      expect(() => tools.submit_work_result({ ...input, inputHash: "e".repeat(64) })).toThrow(
        "result inputs do not match"
      );
      expect(store.get(claimed.id)?.status).toBe("running");

      const accepted = tools.submit_work_result(input);
      expect(tools.submit_work_result(input)).toEqual(accepted);
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        expect(db.prepare(`SELECT COUNT(*) AS count FROM attempt_results`).get()).toEqual({ count: 1 });
        expect(db.prepare(`SELECT status FROM attempt_leases`).get()).toEqual({ status: "consumed" });
        expect(db.prepare(`SELECT status FROM execution_attempts`).get()).toEqual({ status: "succeeded" });
      } finally {
        db.close();
      }
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rolls back attempt, result, work-item, lease, and audit state together", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-worker-attempt-rollback-"));
    const dbPath = join(dir, "control.db");
    const store = new SqliteWorkItemStore(dbPath);
    const tools = createWorkItemTools(store, createPolicyEngine());
    try {
      tools.create_work_item(readOnlyInput("Attempt rollback"));
      const claimed = tools.claim_next_approved_work_item({ workerId: "worker-a" });
      if (!claimed?.attemptId) throw new Error("expected authoritative attempt claim");
      const sabotage = new DatabaseSync(dbPath);
      sabotage.exec(`
        CREATE TRIGGER fail_attempt_terminal
        BEFORE UPDATE ON execution_attempts
        WHEN NEW.status IN ('succeeded', 'failed', 'cancelled')
        BEGIN
          SELECT RAISE(ABORT, 'attempt terminal failure');
        END;
      `);
      sabotage.close();

      expect(() => tools.submit_work_result(authoritativeResult(claimed))).toThrow("attempt terminal failure");
      expect(store.get(claimed.id)?.status).toBe("running");
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        expect(db.prepare(`SELECT COUNT(*) AS count FROM attempt_results`).get()).toEqual({ count: 0 });
        expect(db.prepare(`SELECT COUNT(*) AS count FROM execution_results`).get()).toEqual({ count: 0 });
        expect(db.prepare(`SELECT status FROM attempt_leases`).get()).toEqual({ status: "active" });
        expect(db.prepare(`SELECT status FROM leases`).get()).toEqual({ status: "active" });
      } finally {
        db.close();
      }
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("creates a fresh immutable attempt for a policy-rechecked retry", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-worker-attempt-retry-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));
    const tools = createWorkItemTools(store, createPolicyEngine());
    try {
      const source = tools.create_work_item(readOnlyInput("Attempt retry"));
      const first = tools.claim_next_approved_work_item({ workerId: "worker-a" });
      if (!first?.attemptId) throw new Error("expected first attempt");
      tools.submit_work_result(authoritativeResult(first));
      const retry = tools.retry_work_item({ id: source.id, actor: "operator", reason: "verified retry" });
      const second = tools.claim_next_approved_work_item({ workerId: "worker-b" });
      expect(retry.id).not.toBe(source.id);
      expect(second?.id).toBe(retry.id);
      expect(second?.attemptId).not.toBe(first.attemptId);
      expect(second?.planHash).not.toBe(first.planHash);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails an expired authoritative attempt without leaving either lease active", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-worker-attempt-expiry-"));
    const dbPath = join(dir, "control.db");
    const store = new SqliteWorkItemStore(dbPath);
    const tools = createWorkItemTools(store, createPolicyEngine());
    try {
      tools.create_work_item(readOnlyInput("Attempt expiry"));
      const claimed = tools.claim_next_approved_work_item({ workerId: "worker-a", leaseMs: 1 });
      if (!claimed?.attemptId) throw new Error("expected authoritative attempt claim");
      const failed = store.failExpiredLeases(new Date(Date.parse(claimed.leaseExpiresAt) + 1));
      expect(failed).toHaveLength(1);
      expect(failed[0]?.status).toBe("failed");
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        expect(db.prepare(`SELECT status FROM execution_attempts`).get()).toEqual({ status: "unknown" });
        expect(db.prepare(`SELECT status FROM attempt_leases`).get()).toEqual({ status: "expired" });
        expect(db.prepare(`SELECT status FROM leases`).get()).toEqual({ status: "expired" });
      } finally {
        db.close();
      }
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function readOnlyInput(title: string) {
  return {
    title,
    requester: "user" as const,
    intent: "inspect source with attempt authority",
    target: { cwd: "/repo" },
    requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: ["src/index.ts"] } }],
    risk: "low" as const
  };
}

function authoritativeResult(claimed: ClaimedWorkItem) {
  if (!claimed.attemptId || !claimed.planHash || !claimed.inputHash || claimed.fencingEpoch === undefined) {
    throw new Error("expected authoritative attempt claim");
  }
  return {
    workItemId: claimed.id,
    attemptId: claimed.attemptId,
    leaseId: claimed.leaseId,
    workerId: claimed.workerId,
    actionHash: claimed.actionHash,
    planHash: claimed.planHash,
    inputHash: claimed.inputHash,
    fencingEpoch: claimed.fencingEpoch,
    idempotencyKey: workerResultIdempotencyKey(claimed.attemptId),
    outcome: "succeeded" as const,
    startedAt: claimed.startedAt,
    finishedAt: new Date(Date.parse(claimed.startedAt) + 10).toISOString(),
    exitCode: 0,
    summary: "authoritative dry-run result",
    structuredOutput: { simulated: true },
    artifacts: [],
    simulationMetadata: { executionMode: "dry_run" as const, simulated: true as const }
  };
}
