import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { describe, expect, it } from "vitest";
import { runWorkerOnce } from "./index.js";

describe("worker policy gate", () => {
  it("executes approved read-only work", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-worker-"));
    const dbPath = join(dir, "control.db");
    const store = new SqliteWorkItemStore(dbPath);

    try {
      const workItem = store.create({
        title: "Read work",
        requester: "user",
        intent: "read source",
        target: { cwd: "/repo" },
        requestedActions: [{ kind: "read", description: "inspect", params: { paths: ["src/index.ts"] } }],
        risk: "low"
      });
      store.approveWorkItem(workItem.id);
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
        requestedActions: [{ kind: "edit", description: "write", params: { write: true, paths: ["src/index.ts"] } }],
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
});
