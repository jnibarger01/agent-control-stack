import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { describe, expect, it } from "vitest";
import { createPolicyEngine } from "./policy.js";
import { createWorkItemTools } from "./tools.js";

// Every row that can carry approval authority for a work item: the legacy approval record
// (upserted in place, so its expiry/reason/created_at are snapshotted too) and every
// execution-plan approval row (append-only, so a new grant is a new row).
function grantSnapshot(dbPath: string, workItemId: string): unknown {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return {
      approvalRecords: db
        .prepare(
          `SELECT action_hash, approved_by, reason, status, created_at, expires_at, consumed_at
           FROM approval_records WHERE work_item_id = ? ORDER BY action_hash`
        )
        .all(workItemId),
      planApprovals: db
        .prepare(
          `SELECT approval_id, approved_by_actor_id, reason, status, created_at, expires_at
           FROM execution_plan_approvals WHERE work_item_id = ? ORDER BY approval_id`
        )
        .all(workItemId)
    };
  } finally {
    db.close();
  }
}

// A replay must append nothing to the audit log and grant nothing: same event list
// (by id), same approval rows. Returns the post-replay result for further checks.
function expectNoNewEventsOrGrants<T>(
  store: SqliteWorkItemStore,
  dbPath: string,
  workItemId: string,
  replay: () => T
): T {
  const eventsBefore = store.readEvents().map((event) => event.id);
  const grantsBefore = grantSnapshot(dbPath, workItemId);
  const result = replay();
  expect(store.readEvents().map((event) => event.id)).toEqual(eventsBefore);
  expect(grantSnapshot(dbPath, workItemId)).toEqual(grantsBefore);
  return result;
}

describe("approve_work_item replay", () => {
  it("a replay of a granted approval appends no further audit events and leaves the approval untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-approval-replay-"));
    const dbPath = join(dir, "control.db");
    const store = new SqliteWorkItemStore(dbPath);
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

      const replay = expectNoNewEventsOrGrants(store, dbPath, workItem.id, () =>
        tools.approve_work_item({ ...input, reason: "replay" })
      );

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
    const dbPath = join(dir, "control.db");
    const store = new SqliteWorkItemStore(dbPath);
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

      // The rejected hash did not disturb the original grant: a replay of it is still a no-op.
      expectNoNewEventsOrGrants(store, dbPath, workItem.id, () =>
        tools.approve_work_item({
          id: workItem.id,
          approvedBy: "qa-operator",
          reason: "replay",
          actionHash: evaluation!.actionHash
        })
      );
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a different approver is not a replay: a human still supersedes an acs:admin approval", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-approval-replay-admin-"));
    const dbPath = join(dir, "control.db");
    const store = new SqliteWorkItemStore(dbPath);
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

      // Once the human holds the approval, the human approving again is a replay and is a no-op.
      const replay = expectNoNewEventsOrGrants(store, dbPath, workItem.id, () =>
        tools.approve_work_item({ id: workItem.id, approvedBy: "qa-operator", reason: "human replay", actionHash })
      );
      expect(replay.workItem.status).toBe("approved");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
