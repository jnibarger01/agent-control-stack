import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteWorkItemStore, type WorkItem } from "@agent-control-stack/work-items";
import { describe, expect, it } from "vitest";
import { createPolicyEngine, type PolicyDecision, type PolicyEngine, type PolicyOperation } from "./policy.js";
import { createWorkItemTools } from "./tools.js";

describe("policy-gated work item tools", () => {
  it("routes created work through injected policy", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-risk-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));
    const tools = createWorkItemTools(store, fakePolicy("require_approval"));

    try {
      const workItem = tools.create_work_item({
        title: "High risk item",
        requester: "user",
        intent: "verify approval trigger",
        requestedActions: [{ kind: "fs.read", description: "inspect" }],
        risk: "high"
      });

      expect(workItem.status).toBe("needs_approval");
      expect(store.readEvents().map((event) => event.name)).toContain("policy.decided");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blocks claimed work when required approval is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-tools-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));
    const tools = createWorkItemTools(store, fakePolicy("require_approval"));

    try {
      const workItem = store.create({
        title: "Approved without action approval",
        requester: "user",
        intent: "verify claim policy",
        requestedActions: [{ kind: "fs.write", description: "write", params: { paths: ["src/index.ts"] } }],
        risk: "low"
      });
      store.approveWorkItem(workItem.id);

      const claimed = tools.claim_next_approved_work_item({ workerId: "worker-a" });

      expect(claimed?.status).toBe("blocked");
      expect(store.readEvents().map((event) => event.name)).toContain("policy.decided");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("re-denies blocked work on unblock and records the decision", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-unblock-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));
    const tools = createWorkItemTools(store, createPolicyEngine());

    try {
      const workItem = tools.create_work_item({
        title: "Denied work",
        requester: "user",
        intent: "verify denied unblock",
        requestedActions: [{ kind: "shell", description: "sudo", params: { command: ["sudo", "whoami"] } }],
        risk: "low"
      });
      const before = store.readEvents().filter((event) => event.name === "policy.decided").length;

      const unblocked = tools.unblock_work_item({ id: workItem.id, actor: "operator" });
      const decisions = store.readEvents().filter((event) => event.name === "policy.decided");

      expect(workItem.status).toBe("blocked");
      expect(unblocked.decision.decision).toBe("deny");
      expect(unblocked.workItem.status).toBe("blocked");
      expect(store.get(workItem.id)?.status).toBe("blocked");
      expect(decisions).toHaveLength(before + 1);
      expect(decisions.at(-1)?.body).toMatchObject({ decision: "deny", context: { actor: "operator" } });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function fakePolicy(decision: PolicyDecision["decision"]): PolicyEngine {
  return {
    evaluateWorkItem(workItem: WorkItem, actor: string, operation: PolicyOperation) {
      return workItem.requestedActions.map((action, index) => ({
        action,
        actionHash: `hash_${index}`,
        context: {
          workItemId: workItem.id,
          actor,
          operation,
          requester: workItem.requester,
          risk: workItem.risk,
          action
        },
        decision: { decision, reason: `${decision} by test`, matchedRules: [`test:${decision}`] }
      }));
    },
    summarize(evaluations) {
      return evaluations[0]?.decision ?? { decision: "deny", reason: "no actions", matchedRules: ["test:deny"] };
    }
  };
}
