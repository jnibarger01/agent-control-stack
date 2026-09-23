import { ControlStackError } from "@agent-control-stack/shared";
import { createWorkItemSchema, type WorkItem } from "@agent-control-stack/work-items";
import { evaluateContractAdmission } from "./contracts.js";
import type { PolicyEngine } from "./policy.js";

/**
 * What would happen if a candidate work item were created now, without
 * creating it: the same contract admission and `create` policy evaluation
 * as `create_work_item`, but nothing is persisted and no audit event is
 * recorded. Decisions and rule ids only; no hashes, params, or commands.
 */
export interface WorkItemPolicyPreview {
  outcome: "auto_admitted" | "needs_approval" | "blocked" | "rejected";
  reason: string;
  matchedRules: string[];
  actions: Array<{ kind: string; decision: "allow" | "deny" | "require_approval"; reason: string }>;
}

const PREVIEW_WORK_ITEM_ID = "wrk_policy_preview";

export function previewWorkItemPolicy(policy: PolicyEngine, input: unknown, now = new Date()): WorkItemPolicyPreview {
  const parsed = createWorkItemSchema.parse(input);
  try {
    evaluateContractAdmission(parsed);
  } catch (error) {
    if (!(error instanceof ControlStackError)) throw error;
    return { outcome: "rejected", reason: error.message, matchedRules: [`contract:${error.code}`], actions: [] };
  }
  const timestamp = now.toISOString();
  const candidate: WorkItem = { ...parsed, id: PREVIEW_WORK_ITEM_ID, createdAt: timestamp, updatedAt: timestamp };
  const evaluations = policy.evaluateWorkItem(candidate, candidate.requester, "create");
  const decision = policy.summarize(evaluations);
  return {
    outcome:
      decision.decision === "deny"
        ? "blocked"
        : decision.decision === "require_approval"
          ? "needs_approval"
          : "auto_admitted",
    reason: decision.reason,
    matchedRules: [...decision.matchedRules],
    actions: evaluations.map((evaluation) => ({
      kind: evaluation.action.kind,
      decision: evaluation.decision.decision,
      reason: evaluation.decision.reason
    }))
  };
}
