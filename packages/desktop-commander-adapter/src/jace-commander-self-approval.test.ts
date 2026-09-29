/**
 * Regression for the PR #212 review, B2: the requester could approve its own
 * approval-gated Jace Commander tool. Only privileged_exec was guarded in the
 * issuance registry, and the policy rule compared the approver with requester
 * "agent" instead of the attested requesterSubject. Every manifest tool with
 * requiresApproval is covered here, for both the policy rule and the registry.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACS_ADMIN_APPROVER,
  createPolicyEngine,
  createWorkItemTools,
  evaluateWorkItemPolicy,
  gateApproval,
  summarizePolicy,
  type PolicyEngine
} from "@agent-control-stack/policy-gate";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { SqliteJaceCommanderIssuanceRegistry } from "./jace-commander-registry.js";
import { validateJaceCommanderInvocation } from "./jace-commander.js";
import {
  GATED,
  HUMAN,
  REQUESTER,
  WORKER,
  invocationFor,
  jcWorkItemInput
} from "./jace-commander-approval.test-support.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("B2: self-approval and admin approval are refused for every approval-gated tool", () => {
  for (const tool of GATED) {
    it(`${tool}: policy denies approval by the requesting subject and by acs:admin; a different human is allowed`, () => {
      const directory = mkdtempSync(join(tmpdir(), "jc-approval-policy-"));
      directories.push(directory);
      const store = new SqliteWorkItemStore(join(directory, "control.db"));
      try {
        const tools = createWorkItemTools(store, createPolicyEngine());
        const item = tools.create_work_item(jcWorkItemInput(invocationFor(tool), REQUESTER));
        expect(item.status).toBe("needs_approval");
        const self = evaluateWorkItemPolicy(item, REQUESTER, "approve");
        expect(summarizePolicy(self)).toMatchObject({ decision: "deny", matchedRules: ["deny:self-approval"] });
        const admin = summarizePolicy(evaluateWorkItemPolicy(item, ACS_ADMIN_APPROVER, "approve"));
        expect(admin.decision).toBe("deny");
        expect(summarizePolicy(evaluateWorkItemPolicy(item, HUMAN, "approve")).decision).toBe("require_approval");

        // Through the real approve gate: nothing is recorded for the requester.
        const actionHash = self[0]!.actionHash;
        const attempt = tools.approve_work_item({ id: item.id, actionHash, approvedBy: REQUESTER, reason: "self" });
        expect(attempt.decision.decision).toBe("deny");
        expect(attempt.approvals).toEqual([]);
        expect(store.hasApproval(item.id, actionHash)).toBe(false);
      } finally {
        store.close();
      }
    });

    for (const [approver, code] of [
      [REQUESTER, "jace_commander_self_approval_denied"],
      [ACS_ADMIN_APPROVER, "jace_commander_human_approval_required"],
      [HUMAN, undefined]
    ] as const) {
      it(`${tool}: the issuance registry ${code ? `refuses an approval by ${approver} (${code})` : "accepts a different human's approval"}`, () => {
        const directory = mkdtempSync(join(tmpdir(), "jc-approval-registry-"));
        directories.push(directory);
        const dbPath = join(directory, "control.db");
        const store = new SqliteWorkItemStore(dbPath);
        const registry = new SqliteJaceCommanderIssuanceRegistry(dbPath);
        try {
          const invocation = invocationFor(tool);
          const policy = createPolicyEngine();
          const tools = createWorkItemTools(store, policy);
          const item = tools.create_work_item(jcWorkItemInput(invocation, REQUESTER));
          // Simulate a policy regression: record the approval with a gate that
          // does not know the approver (the registry must still refuse it).
          const permissive: PolicyEngine = {
            evaluateWorkItem: (workItem, actor) => evaluateWorkItemPolicy(workItem, actor, "create"),
            summarize: summarizePolicy
          };
          const actionHash = evaluateWorkItemPolicy(item, HUMAN, "create")[0]!.actionHash;
          gateApproval(store, permissive, { id: item.id, actionHash, approvedBy: approver, reason: "forged" });
          const claimed = tools.claim_approved_work_item_by_id({ id: item.id, workerId: WORKER, leaseMs: 60_000 });
          expect(claimed?.attemptId).toBeDefined();
          const lease = store.getActiveLeaseForAttempt(claimed!.attemptId!)!;
          const approval = store.getExecutionPlanApprovalById(lease.approvalId!)!;
          const now = Date.now();
          const binding = {
            runtimeId: "jc-test-runtime",
            toolName: tool,
            leaseId: claimed!.leaseId,
            attemptId: claimed!.attemptId!,
            workItemId: item.id,
            workerId: WORKER,
            fencingEpoch: claimed!.fencingEpoch!,
            planHash: claimed!.planHash!,
            actionHash: approval.actionHash,
            invocationHash: invocation.invocationHash,
            approvalId: lease.approvalId,
            requesterSubject: REQUESTER,
            keyId: "jc-test-key",
            nonce: randomBytes(32).toString("base64url"),
            issuedAt: new Date(now).toISOString(),
            expiresAt: new Date(now + 20_000).toISOString()
          };
          if (code) {
            expect(() => registry.recordIssuance(binding)).toThrow(expect.objectContaining({ code }));
          } else {
            expect(() => registry.recordIssuance({ ...binding, requesterSubject: "" })).toThrow(
              expect.objectContaining({ code: "jace_commander_requester_unknown" })
            );
            expect(registry.recordIssuance(binding).approvalId).toBe(lease.approvalId);
          }
        } finally {
          registry.close();
          store.close();
        }
      });
    }
  }
});

describe("shared JC issuance transaction", () => {
  it("rolls back the issuance row when later evidence in the same transaction fails", () => {
    const directory = mkdtempSync(join(tmpdir(), "jc-shared-issuance-"));
    directories.push(directory);
    const store = new SqliteWorkItemStore(join(directory, "control.db"));
    try {
      const invocation = validateJaceCommanderInvocation("acs_read", { view: "health" });
      const tools = createWorkItemTools(store, createPolicyEngine());
      const item = tools.create_work_item(jcWorkItemInput(invocation, REQUESTER));
      expect(item.status).toBe("approved");
      const claimed = tools.claim_approved_work_item_by_id({
        id: item.id,
        workerId: WORKER,
        leaseMs: 60_000
      });
      expect(claimed?.attemptId).toBeDefined();
      const now = Date.now();
      const binding = {
        runtimeId: "jc-test-runtime",
        toolName: "acs_read",
        leaseId: claimed!.leaseId,
        attemptId: claimed!.attemptId!,
        workItemId: item.id,
        workerId: WORKER,
        fencingEpoch: claimed!.fencingEpoch!,
        planHash: claimed!.planHash!,
        actionHash: claimed!.actionHash,
        invocationHash: invocation.invocationHash,
        requesterSubject: REQUESTER,
        keyId: "jc-test-key",
        nonce: randomBytes(32).toString("base64url"),
        issuedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + 20_000).toISOString()
      };

      const countIssuances = () =>
        store.withSqliteTransaction((db) => {
          const row = db.prepare("SELECT COUNT(*) AS count FROM jace_commander_capability_issuances").get() as {
            count: number;
          };
          return row.count;
        });
      expect(countIssuances()).toBe(0);
      expect(() =>
        store.withSqliteTransaction((db) => {
          const shared = new SqliteJaceCommanderIssuanceRegistry(db);
          shared.recordIssuance(binding, { withinTransaction: true });
          throw new Error("simulated evidence failure");
        })
      ).toThrow("simulated evidence failure");
      expect(countIssuances()).toBe(0);
    } finally {
      store.close();
    }
  });
});
