import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPolicyEngine, createWorkItemTools } from "@agent-control-stack/policy-gate";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { describe, expect, it, vi } from "vitest";
import { runWorkerOnce } from "./index.js";

describe("PR30 worker cleanup regression", () => {
  it("tears down a provisioned workspace when execution throws", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-worker-cleanup-"));
    const dbPath = join(dir, "control.db");
    const store = new SqliteWorkItemStore(dbPath);
    const tools = createWorkItemTools(store, createPolicyEngine());
    tools.create_work_item({
      title: "throwing execution",
      requester: "user",
      intent: "prove cleanup",
      target: { cwd: "/repo" },
      requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: ["README.md"] } }],
      risk: "low"
    });
    store.close();
    const teardown = vi.fn(async () => undefined);
    const workspaceManager = {
      provision: vi.fn(async (workItemId: string, options: Record<string, unknown>) => ({
        allocationId: "workspace_throw",
        workItemId,
        attemptId: String(options.attemptId),
        leaseId: String(options.leaseId),
        workerId: String(options.workerId),
        fencingEpoch: Number(options.fencingEpoch),
        hostPath: "/tmp/workspace-throw",
        branch: "acs/throw",
        baseRef: "HEAD",
        status: "active",
        createdAt: new Date().toISOString()
      })),
      teardown
    } as unknown as import("@agent-control-stack/workspace-manager").WorkspaceManager;
    try {
      await expect(
        runWorkerOnce({
          dbPath,
          workerId: "worker-throw",
          workspaceManager,
          execute: async () => {
            throw new Error("boom");
          }
        })
      ).rejects.toThrow("boom");
      expect(teardown).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
