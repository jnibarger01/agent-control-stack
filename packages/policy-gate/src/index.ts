import { approvalRequestSchema, type WorkItem } from "@agent-control-stack/work-items";
import { z } from "zod";

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
  if (workItem.status !== "pending_policy" && workItem.status !== "needs_approval") {
    return deny(`work item is ${workItem.status}`);
  }
  if ((workItem.risk === "high" || workItem.risk === "critical") && !parsed.data.reason?.trim()) {
    return deny(`${workItem.risk}-risk work requires an approval reason`);
  }

  return { allowed: true, reason: "approval accepted" };
}

function deny(reason: string): PolicyDecision {
  return { allowed: false, reason };
}
