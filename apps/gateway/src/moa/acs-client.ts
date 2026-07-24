import type {
  AcsClient,
  ActionCategory,
  CreateWorkItemInput,
  ExecutableGrant,
  ExecutableGrantRequest,
  ExecutionRequest
} from "@agent-control-stack/moa-orchestrator";
import { HIGH_RISK_CATEGORIES } from "@agent-control-stack/moa-orchestrator";
import { createPolicyEngine, createWorkItemTools } from "@agent-control-stack/policy-gate";
import { ControlStackError } from "@agent-control-stack/shared";
import {
  approvalRequestHash,
  type WorkItem,
  type WorkItemRisk,
  type WorkItemStore
} from "@agent-control-stack/work-items";

const riskRank: Record<WorkItemRisk, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export function rederiveMoaRisk(
  category: ActionCategory,
  claimed: "low" | "medium" | "high" | "blocked"
): WorkItemRisk {
  const claimedRisk: WorkItemRisk = claimed === "blocked" ? "critical" : claimed;
  const floor: WorkItemRisk = (HIGH_RISK_CATEGORIES as readonly string[]).includes(category)
    ? "high"
    : category === "network"
      ? "medium"
      : "low";
  return riskRank[claimedRisk] >= riskRank[floor] ? claimedRisk : floor;
}

export function createMoaAcsClient(store: WorkItemStore): AcsClient {
  const policy = createPolicyEngine();
  const tools = createWorkItemTools(store, policy);

  return {
    async createWorkItem(input: CreateWorkItemInput) {
      const risk = rederiveMoaRisk(input.category, input.risk);
      const workItem = tools.create_work_item({
        title: input.title,
        requester: "agent",
        requesterSubject: input.actor,
        intent: input.summary,
        target: {},
        requestedActions: [workItemAction(input)],
        risk
      });
      if (input.requires_approval && (workItem.status === "pending_policy" || workItem.status === "approved")) {
        return {
          work_item_id: store.transition(workItem.id, "needs_approval", { via: "policy_gate" }).id,
          status: "pending_approval" as const
        };
      }
      return {
        work_item_id: workItem.id,
        status: workItem.status === "approved" ? ("approved" as const) : ("pending_approval" as const)
      };
    },

    async getExecutableGrant(input: ExecutableGrantRequest): Promise<ExecutableGrant> {
      const { workItem, actionHash } = verifyExecutableGrant(store, input);
      return {
        grant_id: approvalRequestHash(workItem.id, actionHash),
        lease_token: dispatchToken(workItem.id, actionHash),
        action_hash: actionHash
      };
    },

    async requestExecution(input: ExecutionRequest) {
      const workItem = store.get(input.work_item_id);
      if (!workItem || workItem.status !== "approved") {
        return { dispatched: false, reason: "work item is not approved or leaseable" };
      }
      const action = matchingMoaAction(workItem, input.expected_action_hash);
      if (!action) {
        return { dispatched: false, reason: "work item action hash/category binding mismatch" };
      }
      const evaluation = policy
        .evaluateWorkItem(workItem, input.actor, "claim")
        .find((candidate) => candidate.action === action);
      if (!evaluation) {
        return { dispatched: false, reason: "policy evaluation missing for work item action" };
      }
      const expectedGrantId = approvalRequestHash(workItem.id, evaluation.actionHash);
      if (
        input.grant_id !== expectedGrantId ||
        input.lease_token !== dispatchToken(workItem.id, evaluation.actionHash)
      ) {
        return { dispatched: false, reason: "approval grant mismatch" };
      }
      if (!store.hasApproval(workItem.id, evaluation.actionHash)) {
        return { dispatched: false, reason: "approval grant is missing, expired, or consumed" };
      }
      return {
        dispatched: false,
        reason: "acs.worker.v2 result acceptance is not available in Phase 2 Slice 1"
      };
    },

    async policySummary() {
      return [
        "ACS is the sole authority for policy, approval, audit, lease/claim, and execution.",
        "MoA decisions are requests only; legacy worker claim and result paths are disabled after schema v6.",
        "Execution requests require matching task/session/actor/source/category/action-hash metadata and an unconsumed approval grant."
      ].join("\n");
    }
  };
}

export function verifyExecutableGrant(
  store: WorkItemStore,
  input: ExecutableGrantRequest
): { workItem: WorkItem; actionHash: string } {
  const workItem = store.get(input.work_item_id);
  if (!workItem) {
    throw new ControlStackError("moa_work_item_not_found", `work item not found: ${input.work_item_id}`);
  }
  if (workItem.status !== "approved") {
    throw new ControlStackError("moa_work_item_not_approved", `work item is ${workItem.status}, not approved`);
  }
  if (workItem.requesterSubject !== input.actor) {
    throw new ControlStackError("moa_actor_mismatch", "work item actor binding mismatch");
  }
  const action = matchingMoaAction(workItem, input.expected_action_hash);
  if (!action) {
    throw new ControlStackError("moa_action_hash_mismatch", "work item action hash binding mismatch");
  }
  if (
    action.params.moa_task_id !== input.task_id ||
    action.params.moa_session_id !== input.session_id ||
    action.params.moa_source !== input.source ||
    action.params.moa_category !== input.expected_category
  ) {
    throw new ControlStackError(
      "moa_grant_binding_mismatch",
      "work item task/session/source/category binding mismatch"
    );
  }
  const evaluation = createPolicyEngine()
    .evaluateWorkItem(workItem, input.actor, "claim")
    .find((candidate) => candidate.action === action);
  if (!evaluation) {
    throw new ControlStackError("moa_policy_evaluation_missing", "policy evaluation missing for work item action");
  }
  if (!store.hasApproval(workItem.id, evaluation.actionHash)) {
    throw new ControlStackError("moa_approval_grant_missing", "approval grant is missing, expired, or consumed");
  }
  return { workItem, actionHash: evaluation.actionHash };
}

function workItemAction(input: CreateWorkItemInput) {
  const write = input.category !== "read_only";
  return {
    kind: input.category === "shell" ? "shell" : input.category === "read_only" ? "fs.read" : "fs.patch",
    description: input.summary,
    params: {
      write,
      moa_task_id: input.task_id,
      moa_session_id: input.session_id,
      moa_source: input.source,
      moa_category: input.category,
      moa_expected_action_hash: input.expected_action_hash
    }
  };
}

function matchingMoaAction(workItem: WorkItem, expectedActionHash: string) {
  return workItem.requestedActions.find((action) => action.params.moa_expected_action_hash === expectedActionHash);
}

function dispatchToken(workItemId: string, actionHash: string): string {
  return `acs-dispatch:${approvalRequestHash(workItemId, actionHash)}`;
}
