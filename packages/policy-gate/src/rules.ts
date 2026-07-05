import type { ApprovalRequest, WorkItem } from "@agent-control-stack/work-items";

export function canApproveWorkItem(workItem: WorkItem, approval: ApprovalRequest): string | undefined {
  if (workItem.status !== "pending_policy" && workItem.status !== "needs_approval") {
    return `work item is ${workItem.status}`;
  }
  if (requiresApprovalReason(workItem) && !approval.reason?.trim()) {
    return `${workItem.risk}-risk work requires an approval reason`;
  }
  return undefined;
}

export function requiresApprovalReason(workItem: WorkItem): boolean {
  return workItem.risk === "high" || workItem.risk === "critical";
}
