import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec, fork, spawn } from "node:child_process";
import { createPolicyEngine, createWorkItemTools } from "@agent-control-stack/policy-gate";
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
  it("executes a registered filesystem connector action and persists evidence", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-worker-connector-"));
    const allowed = join(dir, "allowed");
    mkdirSync(allowed);
    writeFileSync(join(allowed, "package.json"), '{"name":"worker-fixture"}\n');
    const configPath = join(dir, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        paths: { allow: [allowed], deny: [] },
        commands: { allow_readonly: ["uname"], deny: [] },
        audit: { log_path: join(dir, "audit.jsonl") }
      })
    );
    const dbPath = join(dir, "control.db");
    const store = new SqliteWorkItemStore(dbPath);
    const tools = createWorkItemTools(store, createPolicyEngine());
    const workItem = tools.create_work_item({
      title: "Read connector fixture",
      requester: "agent",
      intent: "read package metadata",
      target: { cwd: allowed },
      requestedActions: [
        {
          kind: "fs.read",
          description: "read package",
          params: {
            rootId: "acs-repo",
            relativePath: "package.json",
            paths: ["package.json"],
            registryActionId: "acs.filesystem.read_text",
            registryVersion: "1.0"
          }
        }
      ],
      risk: "low"
    });
    store.close();
    vi.stubEnv("ACS_MACHINE_CONTROLLER_CONFIG", configPath);

    try {
      const result = await runWorkerOnce({ dbPath, workerId: "test-worker" });
      const check = new SqliteWorkItemStore(dbPath);
      try {
        expect(result.executed).toBe(true);
        expect(check.get(workItem.id)?.status).toBe("succeeded");
        expect(check.get(workItem.id)?.result).toMatchObject({
          execution_mode: "controlled_action",
          executor_id: "test-worker",
          evidence: [expect.objectContaining({ evidence_type: "filesystem" })]
        });
      } finally {
        check.close();
      }
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
    }
  });

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

  it("simulates approved write work with a matching action approval", async () => {
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
        const succeededEvent = check.readEvents().find((event) => event.name === "work_item.succeeded");
        expect(result.executed).toBe(true);
        expect(result.executionMode).toBe("dry_run");
        expect(check.get(workItem.id)?.status).toBe("succeeded");
        expect(events).toContain("approval.granted");
        expect(events).toContain("approval.consumed");
        expect(events).toContain("work_item.succeeded");
        expect(succeededEvent?.body.result).toMatchObject({ execution_mode: "dry_run" });
        expect(succeededEvent?.attributes).toMatchObject({ "execution.mode": "dry_run" });
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
