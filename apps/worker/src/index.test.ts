import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPolicyEngine, createWorkItemTools } from "@agent-control-stack/policy-gate";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { describe, expect, it } from "vitest";
import { runWorkerOnce } from "./index.js";

describe("worker policy gate", () => {
  it("executes approved read-only work", async () => {
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
      store.approveWorkItem(workItem.id);
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

  it("executes approved write work with a matching action approval", async () => {
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
        reason: "approve exact write action"
      });
      expect(approval.workItem.status).toBe("approved");
      store.close();

      const result = await runWorkerOnce({ dbPath, workerId: "test-worker" });
      const check = new SqliteWorkItemStore(dbPath);
      try {
        const events = check.readEvents().map((event) => event.name);
        expect(result.executed).toBe(true);
        expect(check.get(workItem.id)?.status).toBe("succeeded");
        expect(events).toContain("approval.granted");
        expect(events).toContain("work_item.succeeded");
      } finally {
        check.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
