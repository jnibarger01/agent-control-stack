import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { describe, expect, it } from "vitest";
import { findUnapprovedExecution, replay } from "./index.js";

describe("deterministic replay", () => {
  it("replays approved work through SQLite events", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-"));
    const dbPath = join(dir, "control.db");
    const store = new SqliteWorkItemStore(dbPath);

    try {
      const workItem = store.create({
        title: "Check policy path",
        requester: "user",
        intent: "Exercise approval and worker lifecycle",
        target: { cwd: "/repo" },
        requestedActions: [{ kind: "read", description: "inspect source", params: { paths: ["src/index.ts"] } }],
        risk: "low"
      });

      const approved = store.approveWorkItem(workItem.id);

      expect(approved?.status).toBe("approved");
      const running = store.claimNextApprovedWorkItem("eval-worker");
      expect(running).toBeDefined();

      store.submitWorkResult({
        id: running!.id,
        workerId: "eval-worker",
        leaseToken: running!.leaseToken,
        status: "succeeded",
        result: { output: "ok" }
      });

      expect(store.get(workItem.id)?.status).toBe("succeeded");
      expect(replay(store.readEvents()).workItems[0]?.status).toBe("succeeded");
      expect(findUnapprovedExecution(store.readEvents())).toEqual([]);
    } finally {
      store.close();
    }
  });
});
