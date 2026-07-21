import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteWorkItemStore, type WorkItem } from "@agent-control-stack/work-items";
import { describe, expect, it } from "vitest";
import { createPolicyEngine, type PolicyDecision, type PolicyEngine, type PolicyOperation } from "./policy.js";
import { createWorkItemTools } from "./tools.js";

const domainTransition = { via: "domain_service" } as const;

describe("policy-gated work item tools", () => {
  it("rejects invalid contract envelopes before creating work items", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-contract-invalid-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));
    const tools = createWorkItemTools(store, createPolicyEngine());

    try {
      expect(() =>
        tools.create_work_item({
          title: "Delete without rollback",
          requester: "agent",
          intent: "verify contract admission happens before persistence",
          requestedActions: [
            { kind: "fs.delete", description: "delete", params: { paths: ["dist"], destructive: true } }
          ],
          risk: "low"
        })
      ).toThrow("contract envelope invalid");
      expect(store.list()).toEqual([]);
      expect(store.readEvents()).toEqual([]);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

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
      store.approveWorkItem(workItem.id, domainTransition);

      const claimed = tools.claim_next_approved_work_item({ workerId: "worker-a" });

      expect(claimed?.status).toBe("blocked");
      expect(store.readEvents().map((event) => event.name)).toContain("policy.decided");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("consumes one write approval once across competing store connections", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-tools-claim-race-"));
    const dbPath = join(dir, "control.db");
    const firstStore = new SqliteWorkItemStore(dbPath);
    const secondStore = new SqliteWorkItemStore(dbPath);
    const policy = createPolicyEngine();
    const firstTools = createWorkItemTools(firstStore, policy);
    const secondTools = createWorkItemTools(secondStore, policy);

    try {
      const workItem = firstTools.create_work_item({
        title: "Claim approved write once",
        requester: "user",
        intent: "verify one approval cannot authorize competing claims",
        target: { cwd: "/repo" },
        requestedActions: [{ kind: "fs.write", description: "write", params: { paths: ["src/index.ts"] } }],
        risk: "low"
      });
      const approvalEvaluation = policy.evaluateWorkItem(workItem, "approver", "approve")[0];

      expect(approvalEvaluation?.decision.decision).toBe("require_approval");
      const approval = firstTools.approve_work_item({
        id: workItem.id,
        approvedBy: "approver",
        reason: "approve the exact write action",
        actionHash: approvalEvaluation!.actionHash
      });
      expect(approval.workItem.status).toBe("approved");

      const claims = [
        firstTools.claim_next_approved_work_item({ workerId: "worker-a" }),
        secondTools.claim_next_approved_work_item({ workerId: "worker-b" })
      ];
      const claimed = claims.filter((candidate) => candidate !== undefined);
      const events = firstStore.readEvents();

      expect(claimed).toHaveLength(1);
      expect(claimed[0]?.id).toBe(workItem.id);
      expect(events.filter((event) => event.name === "approval.granted")).toHaveLength(1);
      expect(events.filter((event) => event.name === "approval.consumed")).toHaveLength(1);
      expect(events.find((event) => event.name === "approval.consumed")?.body).toMatchObject({
        workItemId: workItem.id,
        actionHash: approvalEvaluation!.actionHash
      });
    } finally {
      firstStore.close();
      secondStore.close();
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

      expect(() => tools.unblock_work_item({ id: workItem.id })).toThrow();
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

  it("requires explicit actors for cancel and reject tool calls", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-terminal-tool-actor-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));
    const tools = createWorkItemTools(store, createPolicyEngine());

    try {
      const cancelled = store.create({
        title: "Cancel tool requires actor",
        requester: "user",
        intent: "verify explicit cancel actor",
        requestedActions: [{ kind: "manual", description: "cancel" }],
        risk: "low"
      });
      const rejected = store.create({
        title: "Reject tool requires actor",
        requester: "user",
        intent: "verify explicit reject actor",
        requestedActions: [{ kind: "manual", description: "reject" }],
        risk: "high"
      });

      expect(() => tools.cancel_work_item({ id: cancelled.id })).toThrow();
      expect(() => tools.reject_work_item({ id: rejected.id })).toThrow();
      expect(store.get(cancelled.id)?.status).toBe("pending_policy");
      expect(store.get(rejected.id)?.status).toBe("needs_approval");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps multi-action work unclaimable until every required action hash is approved", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-tools-multi-approval-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));
    const tools = createWorkItemTools(store, fakePolicy("require_approval"));

    try {
      const workItem = tools.create_work_item({
        title: "Multi-action work",
        requester: "user",
        intent: "verify per-action approvals",
        target: { cwd: "/repo" },
        requestedActions: [
          { kind: "fs.write", description: "write first", params: { paths: ["src/one.ts"] } },
          { kind: "fs.write", description: "write second", params: { paths: ["src/two.ts"] } }
        ],
        risk: "high"
      });

      expect(() =>
        tools.approve_work_item({ id: workItem.id, approvedBy: "approver", reason: "missing hash" })
      ).toThrow("approval_action_hash_required");

      const first = tools.approve_work_item({
        id: workItem.id,
        approvedBy: "approver",
        reason: "approve one",
        actionHash: "hash_0"
      });

      expect(first.approvals).toHaveLength(1);
      expect(first.workItem.status).toBe("needs_approval");
      expect(tools.claim_next_approved_work_item({ workerId: "worker-a" })).toBeUndefined();

      const second = tools.approve_work_item({
        id: workItem.id,
        approvedBy: "approver",
        reason: "approve two",
        actionHash: "hash_1"
      });

      expect(second.approvals).toHaveLength(1);
      expect(second.workItem.status).toBe("approved");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("re-evaluates policy for retry and clone lineage instead of copying approval", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-lineage-policy-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));
    const tools = createWorkItemTools(store, createPolicyEngine());

    try {
      const source = tools.create_work_item({
        title: "Completed source",
        requester: "user",
        intent: "verify retry policy",
        target: { cwd: "/repo" },
        requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: ["src/index.ts"] } }],
        risk: "low"
      });
      const claimed = tools.claim_next_approved_work_item({ workerId: "worker-a" });
      if (!claimed) throw new Error("expected source claim");
      tools.submit_work_result({
        workItemId: claimed.id,
        leaseId: claimed.leaseId,
        workerId: claimed.workerId,
        actionHash: claimed.actionHash,
        idempotencyKey: "policy-lineage-source",
        outcome: "succeeded",
        startedAt: claimed.startedAt,
        finishedAt: new Date(Date.parse(claimed.startedAt) + 10).toISOString(),
        exitCode: 0,
        summary: "source simulated",
        structuredOutput: { simulated: true },
        artifacts: [],
        simulationMetadata: { executionMode: "dry_run", simulated: true }
      });

      const retried = tools.retry_work_item({ id: source.id, actor: "operator", reason: "repeat inspection" });
      const cloned = tools.clone_work_item({ id: source.id, actor: "operator", risk: "high" });
      const policyEvents = store
        .readEvents()
        .filter((event) => event.name === "policy.decided")
        .filter((event) => (event.body.context as { operation?: string } | undefined)?.operation === "create");

      expect(retried.status).toBe("approved");
      expect(cloned.status).toBe("needs_approval");
      expect(store.get(source.id)?.status).toBe("succeeded");
      expect(
        policyEvents.some(
          (event) => (event.body.context as { workItemId?: string } | undefined)?.workItemId === retried.id
        )
      ).toBe(true);
      expect(
        policyEvents.some(
          (event) => (event.body.context as { workItemId?: string } | undefined)?.workItemId === cloned.id
        )
      ).toBe(true);
      expect(store.hasApproval(retried.id, "policy-lineage-source")).toBe(false);
      expect(store.hasApproval(cloned.id, "policy-lineage-source")).toBe(false);
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
