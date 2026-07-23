import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { describe, expect, it } from "vitest";
import { findUnapprovedExecution, replay } from "./index.js";

const domainTransition = { via: "domain_service" } as const;

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

      const approved = store.approveWorkItem(workItem.id, domainTransition);

      expect(approved?.status).toBe("approved");
      const running = store.claimNextApprovedWorkItem("eval-worker");
      expect(running).toBeDefined();

      store.submitWorkResult({
        workItemId: running!.id,
        leaseId: running!.leaseId,
        workerId: "eval-worker",
        actionHash: running!.actionHash,
        idempotencyKey: "eval-replay-result-1",
        outcome: "succeeded",
        startedAt: running!.startedAt,
        finishedAt: new Date().toISOString(),
        summary: "deterministic replay completed",
        structuredOutput: { output: "ok" },
        simulationMetadata: { executionMode: "dry_run", simulated: true, reason: "eval_replay" }
      });

      expect(store.get(workItem.id)?.status).toBe("succeeded");
      expect(replay(store.readEvents()).workItems[0]?.status).toBe("succeeded");
      expect(findUnapprovedExecution(store.readEvents())).toEqual([]);
    } finally {
      store.close();
    }
  });
});
