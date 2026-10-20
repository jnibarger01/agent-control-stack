import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteWorkItemStore, defaultExecutionPlanForWorkItem } from "@agent-control-stack/work-items";
import { describe, expect, it } from "vitest";
import { createPolicyEngine, type PolicyEngine } from "./policy.js";
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
      tools.approve_work_item({
        id: workItem.id,
        approvedBy: "qa-operator",
        reason: "ok",
        actionHash: evaluation!.actionHash
      });

      expect(() =>
        tools.approve_work_item({
          id: workItem.id,
          approvedBy: "qa-operator",
          reason: "bad",
          actionHash: "0".repeat(64)
        })
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

  function approvedFixture(policy: PolicyEngine = createPolicyEngine()) {
    const dir = mkdtempSync(join(tmpdir(), "acs-approval-replay-fx-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));
    const tools = createWorkItemTools(store, policy);
    const workItem = tools.create_work_item({
      title: "Replay fixture",
      requester: "user",
      intent: "approval replay boundaries",
      target: { cwd: "/repo" },
      requestedActions: [{ kind: "fs.write", description: "write", params: { paths: ["src/index.ts"] } }],
      risk: "high"
    });
    const actionHash = createPolicyEngine().evaluateWorkItem(workItem, "qa-operator", "approve")[0]!.actionHash;
    const input = { id: workItem.id, approvedBy: "qa-operator", reason: "approve", actionHash };
    const countOf = (name: string) => store.readEvents().filter((event) => event.name === name).length;
    const cleanup = () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    };
    return { store, tools, workItem, actionHash, input, countOf, cleanup };
  }

  it("an expired approval is not a replay: it is re-granted through the normal path", () => {
    const fx = approvedFixture();
    try {
      fx.tools.approve_work_item(fx.input);
      expect(fx.countOf("approval.granted")).toBe(1);
      const db = (fx.store as unknown as { db: { prepare: (sql: string) => { run: (...a: unknown[]) => void } } }).db;
      db.prepare("UPDATE approval_records SET expires_at = ? WHERE work_item_id = ? AND action_hash = ?").run(
        "2000-01-01T00:00:00.000Z",
        fx.workItem.id,
        fx.actionHash
      );
      expect(fx.store.hasApproval(fx.workItem.id, fx.actionHash)).toBe(false);

      fx.tools.approve_work_item({ ...fx.input, reason: "re-approve after expiry" });

      expect(fx.countOf("approval.granted")).toBe(2);
      expect(fx.store.hasApproval(fx.workItem.id, fx.actionHash)).toBe(true);
    } finally {
      fx.cleanup();
    }
  });

  it("a consumed approval is rejected on replay and grants nothing", () => {
    const fx = approvedFixture();
    try {
      fx.tools.approve_work_item(fx.input);
      fx.store.consumeApproval(fx.workItem.id, fx.actionHash);
      const granted = fx.countOf("approval.granted");

      expect(() => fx.tools.approve_work_item({ ...fx.input, reason: "replay after consume" })).toThrow(
        /already consumed/
      );
      expect(fx.countOf("approval.granted")).toBe(granted);
      expect(fx.store.hasApproval(fx.workItem.id, fx.actionHash)).toBe(false);
    } finally {
      fx.cleanup();
    }
  });

  it("a policy change to deny after approval rejects the replay and audits the denial", () => {
    let deny = false;
    const real = createPolicyEngine();
    const policy: PolicyEngine = {
      ...real,
      evaluateWorkItem: (workItem, actor, operation) => {
        const evaluations = real.evaluateWorkItem(workItem, actor, operation);
        return deny && operation === "approve"
          ? evaluations.map((evaluation) => ({
              ...evaluation,
              decision: { ...evaluation.decision, decision: "deny" as const, reason: "policy changed" }
            }))
          : evaluations;
      }
    };
    const fx = approvedFixture(policy);
    try {
      fx.tools.approve_work_item(fx.input);
      const granted = fx.countOf("approval.granted");
      const decided = fx.countOf("policy.decided");
      deny = true;

      const replay = fx.tools.approve_work_item({ ...fx.input, reason: "replay after policy change" });

      expect(replay.decision.decision).toBe("deny");
      expect(replay.approvals).toEqual([]);
      expect(fx.countOf("approval.granted")).toBe(granted);
      expect(fx.countOf("policy.decided")).toBeGreaterThan(decided);
    } finally {
      fx.cleanup();
    }
  });

  it("alice then bob is a real update, and bob repeating is then a replay", () => {
    const fx = approvedFixture();
    try {
      fx.tools.approve_work_item({ ...fx.input, approvedBy: "alice" });
      fx.tools.approve_work_item({ ...fx.input, approvedBy: "bob" });
      const granted = fx.countOf("approval.granted");
      const total = fx.store.readEvents({ limit: 500 }).length;

      fx.tools.approve_work_item({ ...fx.input, approvedBy: "bob", reason: "bob again" });

      expect(fx.countOf("approval.granted")).toBe(granted);
      expect(fx.store.readEvents({ limit: 500 })).toHaveLength(total);
      expect(fx.store.getApprovalGrant(fx.workItem.id, fx.actionHash)?.approvedBy).toBe("bob");
    } finally {
      fx.cleanup();
    }
  });

  it("a replay under a changed but still-approvable policy records the evaluation it reports", () => {
    let reason = "original";
    const real = createPolicyEngine();
    const policy: PolicyEngine = {
      ...real,
      evaluateWorkItem: (workItem, actor, operation) =>
        real.evaluateWorkItem(workItem, actor, operation).map((evaluation) => ({
          ...evaluation,
          decision: { ...evaluation.decision, reason }
        }))
    };
    const fx = approvedFixture(policy);
    try {
      fx.tools.approve_work_item(fx.input);
      const decided = fx.countOf("policy.decided");

      fx.tools.approve_work_item({ ...fx.input, reason: "unchanged policy" });
      expect(fx.countOf("policy.decided")).toBe(decided);

      reason = "policy tightened";
      const replay = fx.tools.approve_work_item({ ...fx.input, reason: "changed policy" });

      expect(replay.decision.decision).not.toBe("deny");
      expect(fx.countOf("policy.decided")).toBe(decided + 1);
      expect(fx.countOf("approval.granted")).toBe(1);
    } finally {
      fx.cleanup();
    }
  });

  it("an approval the current plan does not carry is not a replay: the new plan is approved", () => {
    const fx = approvedFixture();
    try {
      fx.tools.approve_work_item(fx.input);
      const oldPlan = fx.store.getCurrentExecutionPlan(fx.workItem.id)!;
      const granted = fx.countOf("approval.granted");
      const superseding = fx.store.createExecutionPlan({
        workItemId: fx.workItem.id,
        definition: defaultExecutionPlanForWorkItem(fx.workItem, { executionMode: "desktop_commander" }),
        createdByActorId: "qa-operator",
        expectedCurrentPlanHash: oldPlan.planHash
      });
      expect(superseding.planHash).not.toBe(oldPlan.planHash);
      expect(fx.store.hasExecutionPlanApproval(fx.workItem.id, superseding.planHash, fx.actionHash)).toBe(false);

      fx.tools.approve_work_item({ ...fx.input, reason: "approve the superseding plan" });

      expect(fx.store.hasExecutionPlanApproval(fx.workItem.id, superseding.planHash, fx.actionHash)).toBe(true);
      expect(fx.countOf("approval.granted")).toBe(granted + 1);
    } finally {
      fx.cleanup();
    }
  });
});
