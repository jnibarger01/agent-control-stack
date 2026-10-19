import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { describe, expect, it } from "vitest";
import { createPolicyEngine } from "./policy.js";
import { createWorkItemTools } from "./tools.js";

describe("approve_work_item replay", () => {
  it("a replay of a granted approval appends no further audit events and leaves the approval untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-approval-replay-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));
    const policy = createPolicyEngine();
    const tools = createWorkItemTools(store, policy);

    try {
      const workItem = tools.create_work_item({
        title: "Replay target",
        requester: "user",
        intent: "verify approval replay is idempotent",
        target: { cwd: "/repo" },
        requestedActions: [{ kind: "fs.write", description: "write", params: { paths: ["src/index.ts"] } }],
        risk: "high"
      });
      const evaluation = policy.evaluateWorkItem(workItem, "qa-operator", "approve")[0];
      const input = { id: workItem.id, approvedBy: "qa-operator", reason: "first", actionHash: evaluation!.actionHash };

      const first = tools.approve_work_item(input);
      expect(first.workItem.status).toBe("approved");
      expect(first.approvals).toHaveLength(1);
      const countOf = (name: string) => store.readEvents().filter((event) => event.name === name).length;
      const before = {
        granted: countOf("approval.granted"),
        decided: countOf("policy.decided"),
        total: store.readEvents().length
      };
      expect(before.granted).toBe(1);

      const replay = tools.approve_work_item({ ...input, reason: "replay" });

      expect(replay.decision.decision).toBe(first.decision.decision);
      expect(replay.workItem.status).toBe("approved");
      expect(countOf("approval.granted")).toBe(1);
      expect(countOf("policy.decided")).toBe(before.decided);
      expect(store.readEvents()).toHaveLength(before.total);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a replay with a hash that does not match still fails closed", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-approval-replay-mismatch-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));
    const policy = createPolicyEngine();
    const tools = createWorkItemTools(store, policy);

    try {
      const workItem = tools.create_work_item({
        title: "Replay mismatch",
        requester: "user",
        intent: "verify a bad hash is still rejected after approval",
        target: { cwd: "/repo" },
        requestedActions: [{ kind: "fs.write", description: "write", params: { paths: ["src/index.ts"] } }],
        risk: "high"
      });
      const evaluation = policy.evaluateWorkItem(workItem, "qa-operator", "approve")[0];
      tools.approve_work_item({ id: workItem.id, approvedBy: "qa-operator", reason: "ok", actionHash: evaluation!.actionHash });

      expect(() =>
        tools.approve_work_item({ id: workItem.id, approvedBy: "qa-operator", reason: "bad", actionHash: "0".repeat(64) })
      ).toThrow(/approval_action_mismatch|does not match/);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a different approver is not a replay: a human still supersedes an acs:admin approval", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-approval-replay-admin-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));
    const policy = createPolicyEngine();
    const tools = createWorkItemTools(store, policy);

    try {
      const workItem = tools.create_work_item({
        title: "Admin then human",
        requester: "user",
        intent: "verify a human approval supersedes an admin approval",
        target: { cwd: "/repo" },
        requestedActions: [{ kind: "fs.write", description: "write", params: { paths: ["src/index.ts"] } }],
        risk: "high"
      });
      const actionHash = policy.evaluateWorkItem(workItem, "qa-operator", "approve")[0]!.actionHash;
      tools.approve_work_item({ id: workItem.id, approvedBy: "acs:admin", reason: "admin", actionHash });
      const granted = () => store.readEvents().filter((event) => event.name === "approval.granted").length;
      const before = granted();

      tools.approve_work_item({ id: workItem.id, approvedBy: "qa-operator", reason: "human", actionHash });

      expect(granted()).toBe(before + 1);
      const plan = store.getCurrentExecutionPlan(workItem.id)!;
      expect(store.getExecutionPlanApproval(workItem.id, plan.planHash, actionHash)?.approvedByActorId).toBe(
        "qa-operator"
      );
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
