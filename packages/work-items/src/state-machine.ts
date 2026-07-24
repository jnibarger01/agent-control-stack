import { ControlStackError } from "@agent-control-stack/shared";
import type { WorkItem, WorkItemStatus } from "./work-item.js";

// 'cancelling', 'unknown', and 'quarantined' mirror the transitions already
// encoded in storage/migrations/006_execution_plans_and_attempts.sql's
// work_items_terminal_immutable_guard trigger - unknown -> quarantined
// (crash/recovery reclassification) and failed/quarantined -> pending_policy
// (retry re-entry) are exceptions that trigger carves out of an otherwise
// terminal status; this table must stay in sync with that guard.
const allowedTransitions: Record<WorkItemStatus, readonly WorkItemStatus[]> = {
  draft: ["pending_policy", "blocked", "cancelled"],
  pending_policy: ["needs_approval", "approved", "blocked", "cancelled"],
  needs_approval: ["approved", "blocked", "cancelled", "rejected"],
  approved: ["running", "cancelled"],
  running: ["succeeded", "failed", "blocked", "cancelled", "cancelling", "unknown"],
  cancelling: ["cancelled", "failed", "unknown"],
  succeeded: [],
  failed: ["pending_policy"],
  blocked: ["pending_policy", "cancelled", "rejected"],
  cancelled: [],
  rejected: [],
  unknown: ["quarantined"],
  quarantined: ["pending_policy"]
};

export function transitionWorkItem(workItem: WorkItem, status: WorkItemStatus, now = new Date().toISOString()): WorkItem {
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
