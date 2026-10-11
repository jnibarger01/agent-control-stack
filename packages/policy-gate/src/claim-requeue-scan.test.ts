import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { describe, expect, it } from "vitest";
import { createPolicyEngine } from "./policy.js";
import { createWorkItemTools } from "./tools.js";

const domainTransition = { via: "domain_service" } as const;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("claim_next_approved_work_item re-queue handling", () => {
  it("returns a stale approved item to needs_approval and still claims the next executable item", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-claim-requeue-scan-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));
    const policy = createPolicyEngine();
    const tools = createWorkItemTools(store, policy);

    try {
      // Oldest approved item: approved, but its action approval is missing, so claim-time policy re-queues it.
      const stale = store.create({
        title: "Stale approved item",
        requester: "user",
        intent: "approved without an action approval",
        target: { cwd: "/repo" },
        requestedActions: [{ kind: "fs.write", description: "write", params: { paths: ["src/stale.ts"] } }],
        risk: "low"
      });
      store.approveWorkItem(stale.id, domainTransition);
      await sleep(5);

      // Newer approved item with its action fully approved: executable.
      const ready = tools.create_work_item({
        title: "Executable approved item",
        requester: "user",
        intent: "fully approved and executable",
        target: { cwd: "/repo" },
        requestedActions: [{ kind: "fs.write", description: "write", params: { paths: ["src/ready.ts"] } }],
        risk: "low"
      });
      const evaluation = policy.evaluateWorkItem(ready, "approver", "approve")[0];
      tools.approve_work_item({
        id: ready.id,
        approvedBy: "approver",
        reason: "approve exact write",
        actionHash: evaluation!.actionHash
      });

      const claimed = tools.claim_next_approved_work_item({ workerId: "worker-a" });

      // Before the fix this returned undefined and spent the one-shot claim on the stale item.
      expect(claimed?.id).toBe(ready.id);
      expect(claimed?.status).toBe("running");
      expect(store.get(stale.id)?.status).toBe("needs_approval");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
