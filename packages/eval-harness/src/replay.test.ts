import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteAuditLog } from "@agent-control-stack/audit-log";
import { evaluateApproval } from "@agent-control-stack/policy-gate";
import { executeSandboxed } from "@agent-control-stack/sandbox";
import {
  SqliteWorkItemStore,
  workItemCreatedEvent,
  workItemStatusEvent
} from "@agent-control-stack/work-items";
import { describe, expect, it } from "vitest";
import { findUnapprovedExecution, replay } from "./index.js";

describe("deterministic replay", () => {
  it("replays approved work through SQLite events", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-"));
    const dbPath = join(dir, "control.db");
    const log = new SqliteAuditLog(dbPath);
    const store = new SqliteWorkItemStore(dbPath);

    try {
      const workItem = store.create({
        title: "Check policy path",
        requester: "user",
        intent: "Exercise approval and worker lifecycle",
        requestedActions: [{ kind: "manual", description: "run dry execution" }],
        risk: "low"
      });
      log.append(workItemCreatedEvent(workItem));

      const decision = evaluateApproval(workItem, { approvedBy: "test", reason: "low-risk eval" });
      expect(decision.allowed).toBe(true);
      const approved = store.approveWorkItem(workItem.id);
      log.append(workItemStatusEvent(approved));

      expect(approved?.status).toBe("approved");
      const running = store.startWorkItem(approved.id);
      log.append(workItemStatusEvent(running));

      const result = await executeSandboxed(running);
      expect(result.ok).toBe(true);
      const succeeded = store.submitWorkResult({
        id: workItem.id,
        status: "succeeded",
        result: { output: result.output }
      });
      log.append(workItemStatusEvent(succeeded));

      expect(store.get(workItem.id)?.status).toBe("succeeded");
      expect(replay(log.readEvents()).workItems[0]?.status).toBe("succeeded");
      expect(findUnapprovedExecution(log.readEvents())).toEqual([]);
    } finally {
      log.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
