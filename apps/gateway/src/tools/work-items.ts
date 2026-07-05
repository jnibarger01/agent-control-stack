import {
  evaluateWorkItemPolicy,
  summarizePolicy,
  type PolicyEvaluation,
  type PolicyDecision
} from "@agent-control-stack/policy-gate";
import { ControlStackError } from "@agent-control-stack/shared";
import {
  approvalRequestSchema,
  createWorkItemTools,
  submitWorkResultSchema,
  type WorkItem,
  type WorkItemStore
} from "@agent-control-stack/work-items";
import { z } from "zod";

export const workItemToolNames = [
  "create_work_item",
  "get_work_item",
  "list_work_items",
  "approve_work_item",
  "unblock_work_item",
  "cancel_work_item",
  "submit_work_result"
] as const;

export function createGatewayWorkItemTools(store: WorkItemStore) {
  const base = createWorkItemTools(store);

  return {
    ...base,
    create_work_item(input: unknown): WorkItem {
      const workItem = store.create(input);
      const evaluations = recordPolicy(store, workItem, workItem.requester);
      const summary = summarizePolicy(evaluations);

      if (summary.decision === "deny") {
        return store.blockWorkItem(workItem.id);
      }
      if (summary.decision === "require_approval") {
        return workItem.status === "pending_policy" ? store.transition(workItem.id, "needs_approval") : workItem;
      }
      return store.approveWorkItem(workItem.id);
    },
    unblock_work_item(input: unknown): WorkItem {
      const parsed = z.object({ id: z.string().min(1) }).parse(input);
      return store.unblockWorkItem(parsed.id);
    },
    submit_work_result(input: unknown): WorkItem {
      const parsed = submitWorkResultSchema.parse(input);
      const workItem = store.get(parsed.id);
      if (!workItem) {
        throw new ControlStackError("work_item_not_found", `work item not found: ${parsed.id}`);
      }

      const evaluations = recordPolicy(store, workItem, "result-submitter");
      const summary = summarizePolicy(evaluations);
      const missingApproval = evaluations.find(
        (evaluation) =>
          evaluation.decision.decision === "require_approval" && !store.hasApproval(workItem.id, evaluation.actionHash)
      );
      if (summary.decision === "deny" || missingApproval) {
        throw new ControlStackError(
          "policy_denied",
          missingApproval ? "approval missing for action hash" : summary.reason
        );
      }

      return store.submitWorkResult(parsed);
    },
    approve_work_item(input: unknown): { decision: PolicyDecision; workItem: WorkItem } {
      const parsed = approvalRequestSchema.extend({ id: z.string().min(1) }).safeParse(input);
      if (!parsed.success) {
        throw new ControlStackError("invalid_approval_request", "invalid approval request");
      }

      const workItem = store.get(parsed.data.id);
      if (!workItem) {
        throw new ControlStackError("work_item_not_found", `work item not found: ${parsed.data.id}`);
      }

      const evaluations = recordPolicy(store, workItem, parsed.data.approvedBy);
      const summary = summarizePolicy(evaluations);
      if (summary.decision === "deny") {
        return { decision: summary, workItem };
      }

      for (const evaluation of evaluations.filter((entry) => entry.decision.decision === "require_approval")) {
        store.recordApproval({
          workItemId: workItem.id,
          actionHash: evaluation.actionHash,
          approvedBy: parsed.data.approvedBy,
          reason: parsed.data.reason
        });
      }

      return { decision: summary, workItem: store.approveWorkItem(workItem.id) };
    }
  };
}

function recordPolicy(store: WorkItemStore, workItem: WorkItem, actor: string): PolicyEvaluation[] {
  const evaluations = evaluateWorkItemPolicy(workItem, actor);
  for (const evaluation of evaluations) {
    store.recordPolicyDecision({
      workItemId: workItem.id,
      actionHash: evaluation.actionHash,
      ...evaluation.decision
    });
  }
  return evaluations;
}
