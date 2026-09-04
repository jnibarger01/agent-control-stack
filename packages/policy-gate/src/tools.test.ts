import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stableHash } from "@agent-control-stack/shared";
import { SqliteWorkItemStore, type WorkItem } from "@agent-control-stack/work-items";
import { describe, expect, it } from "vitest";
import { createPolicyEngine, type PolicyDecision, type PolicyEngine, type PolicyOperation } from "./policy.js";
import { createWorkItemTools } from "./tools.js";

const domainTransition = { via: "domain_service" } as const;

describe("policy-gated work item tools", () => {
  it("persists a native route binding atomically with a created work item", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-native-route-persistence-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));
    const tools = createWorkItemTools(store, createPolicyEngine());

    try {
      const workItem = tools.create_work_item({
        title: "Inspect a source file",
        requester: "user",
        intent: "inspect the source code",
        target: { cwd: "/repo" },
        requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: ["src/index.ts"] } }],
        risk: "low"
      });

      expect(store.getVerifiedMissionRouting(workItem.id)).toMatchObject({
        workItemId: workItem.id,
        route: { decision: "routed", engineId: "codex" }
      });
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("persists only a redacted presence projection of native intake and audit evidence", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-native-route-redaction-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));
    const tools = createWorkItemTools(store, createPolicyEngine());
    try {
      const workItem = tools.create_work_item({
        title: "Inspect /private/.ssh/id_rsa source file",
        requester: "user",
        intent: "inspect private/.env and /private/.ssh/id_rsa source code",
        target: { cwd: "/private/.ssh/id_rsa", files: ["private/.env"] },
        requestedActions: [
          {
            kind: "fs.read",
            description: "inspect src/index.ts and /private/.ssh/id_rsa",
            params: {
              paths: ["private/.env", "/private/.ssh/id_rsa"],
              password: "native-password-literal",
              apiKey: "native-api-key-literal",
              token: "native-token-literal",
              authorization: "Bearer native-bearer-literal",
              secret: "native-secret-literal"
            }
          }
        ],
        risk: "low"
      });
      const db = (
        store as unknown as { db: { prepare(sql: string): { get(...args: unknown[]): { canonical_json: string } } } }
      ).db;
      const canonical = db
        .prepare(
          `SELECT canonical_json FROM mission_intake_records WHERE intake_hash = (SELECT intake_hash FROM work_item_mission_routing WHERE work_item_id = ?)`
        )
        .get(workItem.id).canonical_json;
      const audit = JSON.stringify(store.readEvents());
      expect(JSON.parse(canonical)).toMatchObject({
        target: { files: [] },
        proposedActions: [{ params: { declared: true } }]
      });
      for (const literal of [
        "native-password-literal",
        "native-api-key-literal",
        "native-token-literal",
        "native-bearer-literal",
        "native-secret-literal",
        "/private/.ssh/id_rsa",
        "private/.env"
      ]) {
        expect(canonical).not.toContain(literal);
        expect(audit).not.toContain(literal);
      }
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects persisted route-table metadata tampering", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-native-route-tamper-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));
    const tools = createWorkItemTools(store, createPolicyEngine());

    try {
      const workItem = tools.create_work_item({
        title: "Inspect a source file",
        requester: "user",
        intent: "inspect the source code",
        target: { cwd: "/repo" },
        requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: ["src/index.ts"] } }],
        risk: "low"
      });
      const db = (
        store as unknown as { db: { exec(sql: string): void; prepare(sql: string): { run(...args: unknown[]): void } } }
      ).db;
      db.exec(`DROP TRIGGER mission_route_evidence_records_no_update`);
      db.prepare(
        `UPDATE mission_route_evidence_records
         SET route_table_hash = ?
         WHERE route_evidence_hash = (SELECT route_evidence_hash FROM work_item_mission_routing WHERE work_item_id = ?)`
      ).run("0".repeat(64), workItem.id);

      expect(() => store.getVerifiedMissionRouting(workItem.id)).toThrowError(
        expect.objectContaining({ code: "mission_routing_evidence_invalid" })
      );
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

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
        actionHash: testActionHash(0)
      });

      expect(first.approvals).toHaveLength(1);
      expect(first.workItem.status).toBe("needs_approval");
      expect(tools.claim_next_approved_work_item({ workerId: "worker-a" })).toBeUndefined();

      const second = tools.approve_work_item({
        id: workItem.id,
        approvedBy: "approver",
        reason: "approve two",
        actionHash: testActionHash(1)
      });

      expect(second.approvals).toHaveLength(1);
      expect(second.workItem.status).toBe("approved");
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("binds and consumes every required approval for a multi-action plan on claim, not just the first", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-tools-multi-approval-lease-"));
    const store = new SqliteWorkItemStore(join(dir, "control.db"));
    const tools = createWorkItemTools(store, fakePolicy("require_approval"));

    try {
      const workItem = tools.create_work_item({
        title: "Multi-action work",
        requester: "user",
        intent: "verify all required approvals are bound to the lease",
        target: { cwd: "/repo" },
        requestedActions: [
          { kind: "fs.write", description: "write first", params: { paths: ["src/one.ts"] } },
          { kind: "fs.write", description: "write second", params: { paths: ["src/two.ts"] } }
        ],
        risk: "high"
      });

      tools.approve_work_item({
        id: workItem.id,
        approvedBy: "approver",
        reason: "approve one",
        actionHash: testActionHash(0)
      });
      tools.approve_work_item({
        id: workItem.id,
        approvedBy: "approver",
        reason: "approve two",
        actionHash: testActionHash(1)
      });

      const claimed = tools.claim_next_approved_work_item({ workerId: "worker-a" });
      expect(claimed?.status).toBe("running");

      const dbAny = store as unknown as {
        db: {
          prepare: (sql: string) => { all: (...a: unknown[]) => Array<{ status: string }> };
        };
      };
      const approvalRows = dbAny.db
        .prepare(`SELECT status FROM execution_plan_approvals WHERE work_item_id = ?`)
        .all(workItem.id);
      // Both action approvals were bound to the lease's authority and
      // consumed transactionally with it - not just the first one.
      expect(approvalRows).toHaveLength(2);
      for (const row of approvalRows) {
        expect(row.status).toBe("consumed");
      }
      const leaseRows = dbAny.db
        .prepare(`SELECT approval_id FROM attempt_lease_approvals WHERE work_item_id = ?`)
        .all(workItem.id);
      expect(leaseRows).toHaveLength(1);
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
        attemptId: claimed.attemptId,
        leaseId: claimed.leaseId,
        workerId: claimed.workerId,
        actionHash: claimed.actionHash,
        planHash: claimed.planHash,
        inputHash: claimed.inputHash,
        fencingEpoch: claimed.fencingEpoch,
        idempotencyKey: stableHash({ domain: "acs.attempt-result.v1", attemptId: claimed.attemptId }),
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
      expect(store.getVerifiedMissionRouting(retried.id)).toBeDefined();
      expect(store.getVerifiedMissionRouting(cloned.id)).toBeDefined();
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
        actionHash: testActionHash(index),
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

function testActionHash(index: number): string {
  return index.toString(16).padStart(64, "0");
}
