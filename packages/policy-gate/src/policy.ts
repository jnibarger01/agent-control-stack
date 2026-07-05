import { approvalRequestSchema, type WorkItem } from "@agent-control-stack/work-items";
import { z } from "zod";
import { canApproveWorkItem } from "./rules.js";

export const policyDecisionSchema = z.object({
  allowed: z.boolean(),
  reason: z.string()
});

export type PolicyDecision = z.infer<typeof policyDecisionSchema>;

export function evaluateApproval(workItem: WorkItem, request: unknown): PolicyDecision {
  const parsed = approvalRequestSchema.safeParse(request);
  if (!parsed.success) {
    return deny("approval request is invalid");
  }

  const denialReason = canApproveWorkItem(workItem, parsed.data);
  if (denialReason) {
    return deny(denialReason);
  }

  return { allowed: true, reason: "approval accepted" };
}

function deny(reason: string): PolicyDecision {
  return { allowed: false, reason };
}
