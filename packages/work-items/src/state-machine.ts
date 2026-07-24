import { ControlStackError } from "@agent-control-stack/shared";
import type { ExecutionAttemptStatus } from "./execution-plan.js";
import type { WorkItem, WorkItemStatus } from "./work-item.js";

const allowedTransitions: Record<WorkItemStatus, readonly WorkItemStatus[]> = {
  draft: ["pending_policy", "blocked", "cancelled"],
  pending_policy: ["needs_approval", "approved", "blocked", "cancelled"],
  needs_approval: ["approved", "blocked", "cancelled", "rejected"],
  approved: ["running", "cancelled"],
  running: ["succeeded", "failed", "blocked", "cancelled"],
  succeeded: [],
  failed: [],
  blocked: ["pending_policy", "cancelled", "rejected"],
  cancelled: [],
  rejected: []
};

export function transitionWorkItem(
  workItem: WorkItem,
  status: WorkItemStatus,
  now = new Date().toISOString()
): WorkItem {
  assertCanTransition(workItem.status, status);
  return { ...workItem, status, updatedAt: now };
}

export function assertCanTransition(from: WorkItemStatus, to: WorkItemStatus): void {
  if (!allowedTransitions[from].includes(to)) {
    throw new ControlStackError("invalid_work_item_transition", `cannot transition work item from ${from} to ${to}`);
  }
}

export function assertExecutableWorkItem(workItem: WorkItem): void {
  if (workItem.status !== "running") {
    throw new ControlStackError("work_item_not_executable", `work item ${workItem.id} is ${workItem.status}`);
  }
}

const allowedAttemptTransitions: Record<ExecutionAttemptStatus, readonly ExecutionAttemptStatus[]> = {
  leased: ["unknown", "quarantined"],
  unknown: [],
  quarantined: []
};

export function assertCanTransitionExecutionAttempt(from: ExecutionAttemptStatus, to: ExecutionAttemptStatus): void {
  if (!allowedAttemptTransitions[from].includes(to)) {
    throw new ControlStackError(
      "invalid_execution_attempt_transition",
      `cannot transition execution attempt from ${from} to ${to}`
    );
  }
}
