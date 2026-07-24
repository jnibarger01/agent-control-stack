import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SqliteWorkItemStore,
  defaultExecutionPlanForWorkItem,
  type ExecutionPlanDefinition,
  type WorkItem
} from "@agent-control-stack/work-items";
import { ControlStackError } from "@agent-control-stack/shared";
import { describe, expect, it } from "vitest";
import { gateAdmitExecutionPlan, gateApproveExecutionPlan } from "./plan-tools.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "acs-plan-tools-"));
  const store = new SqliteWorkItemStore(join(dir, "control.db"));
  return {
    store,
    cleanup: () => {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function createWorkItem(
  store: SqliteWorkItemStore,
  overrides: { risk?: WorkItem["risk"]; requester?: WorkItem["requester"] } = {}
): WorkItem {
  return store.create({
    title: "Plan tools fixture",
    requester: overrides.requester ?? "user",
    requesterSubject: "actor-user",
    intent: "prove plan admission derives requiresApproval from real policy evaluation",
    target: { cwd: "/repo", files: ["src/index.ts"] },
    requestedActions: [
      { kind: "fs.read", description: "inspect the source", params: { paths: ["src/index.ts"], write: false } }
    ],
    risk: overrides.risk ?? "low"
  });
}

function planWithSteps(workItem: WorkItem, steps: ExecutionPlanDefinition["steps"]): ExecutionPlanDefinition {
  const base = defaultExecutionPlanForWorkItem(workItem);
  return { ...base, steps };
}

describe("gateAdmitExecutionPlan", () => {
  it("admits a plan of genuinely read-only steps with requiresApproval derived as false", () => {
    const { store, cleanup } = fixture();
    try {
      const workItem = createWorkItem(store);
      const plan = store.createExecutionPlan({
        workItemId: workItem.id,
        definition: defaultExecutionPlanForWorkItem(workItem),
        createdByActorId: "actor-user"
      });

      const result = gateAdmitExecutionPlan(store, workItem, plan, "actor-user");

      expect(result.decision.decision).toBe("allow");
      expect(result.admission?.requiresApproval).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("derives requiresApproval: true from real policy evaluation - a caller cannot claim otherwise", () => {
    const { store, cleanup } = fixture();
    try {
      const workItem = createWorkItem(store);
      const definition = planWithSteps(workItem, [
        {
          stepId: "step-001",
          sequence: 1,
          action: {
            kind: "shell",
            description: "run the test suite",
            params: { command: ["npm", "run", "test"], cwd: "/repo" }
          },
          successCriteria: []
        }
      ]);
      const plan = store.createExecutionPlan({
        workItemId: workItem.id,
        definition,
        createdByActorId: "actor-user"
      });

      const result = gateAdmitExecutionPlan(store, workItem, plan, "actor-user");

      expect(result.decision.decision).toBe("require_approval");
      expect(result.admission?.requiresApproval).toBe(true);
      // The underlying store API still trusts a caller-supplied flag by
      // design (matching every other privileged store method's authority
      // model) - what THIS test proves is that the sanctioned gate function
      // never lets that flag diverge from what policy actually decided.
    } finally {
      cleanup();
    }
  });

  it("denies admission outright for a step policy forbids, and creates no admission record", () => {
    const { store, cleanup } = fixture();
    try {
      const workItem = createWorkItem(store);
      const definition = planWithSteps(workItem, [
        {
          stepId: "step-001",
          sequence: 1,
          action: {
            kind: "shell",
            description: "wipe the filesystem",
            params: { command: ["rm", "-rf", "/"], cwd: "/repo", destructive: true }
          },
          successCriteria: []
        }
      ]);
      const plan = store.createExecutionPlan({
        workItemId: workItem.id,
        definition,
        createdByActorId: "actor-user"
      });

      const result = gateAdmitExecutionPlan(store, workItem, plan, "actor-user");

      expect(result.decision.decision).toBe("deny");
      expect(result.admission).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("records a policy decision audit event for every evaluated step", () => {
    const { store, cleanup } = fixture();
    try {
      const workItem = createWorkItem(store);
      const plan = store.createExecutionPlan({
        workItemId: workItem.id,
        definition: defaultExecutionPlanForWorkItem(workItem),
        createdByActorId: "actor-user"
      });

      gateAdmitExecutionPlan(store, workItem, plan, "actor-user");

      expect(store.readEvents().some((event) => event.name === "policy.decided")).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("rejects a plan that does not belong to the given work item", () => {
    const { store, cleanup } = fixture();
    try {
      const workItemA = createWorkItem(store);
      const workItemB = createWorkItem(store);
      const planForB = store.createExecutionPlan({
        workItemId: workItemB.id,
        definition: defaultExecutionPlanForWorkItem(workItemB),
        createdByActorId: "actor-user"
      });

      expect(() => gateAdmitExecutionPlan(store, workItemA, planForB, "actor-user")).toThrowError(
        expect.objectContaining<Partial<ControlStackError>>({ code: "execution_plan_work_item_mismatch" })
      );
    } finally {
      cleanup();
    }
  });
});

describe("gateApproveExecutionPlan", () => {
  it("grants approval bound to the exact plan hash and action hash", () => {
    const { store, cleanup } = fixture();
    try {
      const workItem = createWorkItem(store, { risk: "high" });
      const definition = planWithSteps(workItem, [
        {
          stepId: "step-001",
          sequence: 1,
          action: { kind: "fs.write", description: "write a file", params: { paths: ["out.txt"], write: true } },
          successCriteria: []
        }
      ]);
      const plan = store.createExecutionPlan({
        workItemId: workItem.id,
        definition,
        createdByActorId: "actor-user"
      });
      const { admission, evaluations } = gateAdmitExecutionPlan(store, workItem, plan, "actor-user");
      expect(admission?.requiresApproval).toBe(true);
      const actionHash = evaluations[0].actionHash;

      const approval = gateApproveExecutionPlan(store, workItem, plan, actionHash, "approver-user", "looks safe");

      expect(approval.status).toBe("granted");
      expect(approval.planHash).toBe(plan.planHash);
      expect(approval.actionHash).toBe(actionHash);
      expect(store.hasExecutionPlanApproval(workItem.id, plan.planHash, actionHash)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("denies self-approval on high-risk steps using the same isSelfApproval check as regular approvals", () => {
    const { store, cleanup } = fixture();
    try {
      // requester "agent" approving its own high-risk work triggers isSelfApproval
      // (context.actor === context.requester) exactly as it does for the
      // existing action-level approval path.
      const workItem = createWorkItem(store, { risk: "high", requester: "agent" });
      const definition = planWithSteps(workItem, [
        {
          stepId: "step-001",
          sequence: 1,
          action: { kind: "fs.write", description: "write a file", params: { paths: ["out.txt"], write: true } },
          successCriteria: []
        }
      ]);
      const plan = store.createExecutionPlan({
        workItemId: workItem.id,
        definition,
        createdByActorId: "actor-user"
      });
      const { evaluations } = gateAdmitExecutionPlan(store, workItem, plan, "actor-user");
      const actionHash = evaluations[0].actionHash;

      expect(() => gateApproveExecutionPlan(store, workItem, plan, actionHash, "agent")).toThrowError(
        expect.objectContaining<Partial<ControlStackError>>({ code: "approval_denied" })
      );
      expect(store.hasExecutionPlanApproval(workItem.id, plan.planHash, actionHash)).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("rejects an action hash that does not match any step in the current plan", () => {
    const { store, cleanup } = fixture();
    try {
      const workItem = createWorkItem(store);
      const plan = store.createExecutionPlan({
        workItemId: workItem.id,
        definition: defaultExecutionPlanForWorkItem(workItem),
        createdByActorId: "actor-user"
      });

      expect(() =>
        gateApproveExecutionPlan(store, workItem, plan, "0".repeat(64), "approver-user")
      ).toThrowError(expect.objectContaining<Partial<ControlStackError>>({ code: "execution_plan_action_mismatch" }));
    } finally {
      cleanup();
    }
  });

  it("invalidates a prior approval's binding when the plan is superseded, mirroring action-hash behavior", () => {
    const { store, cleanup } = fixture();
    try {
      const workItem = createWorkItem(store, { risk: "high" });
      const definition = planWithSteps(workItem, [
        {
          stepId: "step-001",
          sequence: 1,
          action: { kind: "fs.write", description: "write a file", params: { paths: ["out.txt"], write: true } },
          successCriteria: []
        }
      ]);
      const plan = store.createExecutionPlan({
        workItemId: workItem.id,
        definition,
        createdByActorId: "actor-user"
      });
      const { evaluations } = gateAdmitExecutionPlan(store, workItem, plan, "actor-user");
      const actionHash = evaluations[0].actionHash;
      gateApproveExecutionPlan(store, workItem, plan, actionHash, "approver-user");
      expect(store.hasExecutionPlanApproval(workItem.id, plan.planHash, actionHash)).toBe(true);

      const revisedDefinition = {
        ...definition,
        steps: [{ ...definition.steps[0], action: { ...definition.steps[0].action, description: "write it differently" } }]
      };
      const supersedingPlan = store.createExecutionPlan({
        workItemId: workItem.id,
        definition: revisedDefinition,
        createdByActorId: "actor-user",
        expectedCurrentPlanHash: plan.planHash
      });

      // The old approval still exists and is still "granted" for the OLD
      // plan hash - but it no longer matches the current plan, so nothing
      // that checks "is this the current plan" (e.g. the attempt/lease
      // binding triggers in migration 006) will accept it.
      expect(supersedingPlan.planHash).not.toBe(plan.planHash);
      expect(() =>
        gateApproveExecutionPlan(store, workItem, supersedingPlan, actionHash, "approver-user")
      ).toThrowError(expect.objectContaining<Partial<ControlStackError>>({ code: "execution_plan_action_mismatch" }));
    } finally {
      cleanup();
    }
  });
});
