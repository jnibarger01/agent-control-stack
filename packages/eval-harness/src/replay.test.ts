import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateApproval } from "@agent-control-stack/policy-gate";
import { executeSandboxed } from "@agent-control-stack/sandbox";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { describe, expect, it } from "vitest";
import { findUnapprovedExecution, replay } from "./index.js";

describe("deterministic replay", () => {
  it("replays approved work through SQLite events", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-"));
    const dbPath = join(dir, "control.db");
    const store = new SqliteWorkItemStore(dbPath);

    try {
      const workItem = store.create({
        title: "Check policy path",
        requester: "user",
        intent: "Exercise approval and worker lifecycle",
        requestedActions: [{ kind: "manual", description: "run dry execution" }],
        risk: "low"
      });

      const decision = evaluateApproval(workItem, { approvedBy: "test", reason: "low-risk eval" });
      expect(decision.allowed).toBe(true);
      const approved = store.approveWorkItem(workItem.id);

      expect(approved?.status).toBe("approved");
      const running = store.claimNextApprovedWorkItem("eval-worker");
      expect(running).toBeDefined();

      const result = await executeSandboxed(running!);
      expect(result.ok).toBe(true);
      const succeeded = store.submitWorkResult({
        id: workItem.id,
        status: "succeeded",
        result: { output: result.output }
      });

      expect(store.get(workItem.id)?.status).toBe("succeeded");
      expect(replay(store.readEvents()).workItems[0]?.status).toBe("succeeded");
      expect(findUnapprovedExecution(store.readEvents())).toEqual([]);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
