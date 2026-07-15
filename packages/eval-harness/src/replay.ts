import { strictCanonicalSha256V1, type AuditEvent } from "@agent-control-stack/shared";
import { projectMemories } from "@agent-control-stack/temporal-memory";
import {
  WorkItemEvent,
  assertCanTransition,
  workItemSchema,
  type WorkItem
} from "@agent-control-stack/work-items";

const workItemLifecycleEvents = new Set<string>(Object.values(WorkItemEvent));
const initialWorkItemStatuses = new Set(["draft", "pending_policy", "needs_approval"]);
const lifecycleStatusByEvent = new Map<string, string>([
  [WorkItemEvent.PendingPolicy, "pending_policy"],
  [WorkItemEvent.NeedsApproval, "needs_approval"],
  [WorkItemEvent.Approved, "approved"],
  [WorkItemEvent.Running, "running"],
  [WorkItemEvent.Succeeded, "succeeded"],
  [WorkItemEvent.Failed, "failed"],
  [WorkItemEvent.Blocked, "blocked"],
  [WorkItemEvent.Cancelled, "cancelled"],
  [WorkItemEvent.Rejected, "rejected"]
]);

export function replay(events: AuditEvent[]) {
  const knownWorkItems = new Map<string, WorkItem>();
  for (const event of events) {
    if (event.name.startsWith("work_item.") && !workItemLifecycleEvents.has(event.name)) {
      throw new Error(`replay: unknown work item lifecycle event ${event.name}`);
    }
    if (workItemLifecycleEvents.has(event.name)) {
      strictCanonicalSha256V1(event.body);
      const parsed = workItemSchema.safeParse(event.body);
      if (!parsed.success) {
        throw new Error(`replay: malformed work item lifecycle event ${event.name}`);
      }
      if (event.attributes["work_item.id"] !== parsed.data.id) {
        throw new Error(`replay: work item id attribute mismatch for ${parsed.data.id}`);
      }
      if (event.attributes["work_item.status"] !== parsed.data.status) {
        throw new Error(`replay: work item status attribute mismatch for ${parsed.data.id}`);
      }
      if (event.attributes["work_item.risk"] !== parsed.data.risk) {
        throw new Error(`replay: work item risk attribute mismatch for ${parsed.data.id}`);
      }
      if (event.attributes["work_item.requester"] !== parsed.data.requester) {
        throw new Error(`replay: work item requester attribute mismatch for ${parsed.data.id}`);
      }
      if (event.attributes["work_item.requester_subject"] !== parsed.data.requesterSubject) {
        throw new Error(`replay: work item requester subject attribute mismatch for ${parsed.data.id}`);
      }
      const expectedStatus = lifecycleStatusByEvent.get(event.name);
      if (expectedStatus && parsed.data.status !== expectedStatus) {
        throw new Error(`replay: lifecycle event status mismatch for ${parsed.data.id}`);
      }
      if (event.name === WorkItemEvent.Created) {
        if (knownWorkItems.has(parsed.data.id)) {
          throw new Error(`replay: duplicate work item creation ${parsed.data.id}`);
        }
        if (!initialWorkItemStatuses.has(parsed.data.status)) {
          throw new Error(`replay: invalid initial work item status ${parsed.data.status}`);
        }
        knownWorkItems.set(parsed.data.id, parsed.data);
      } else {
        const current = knownWorkItems.get(parsed.data.id);
        if (!current) {
          throw new Error(`replay: event for unknown work item ${parsed.data.id}`);
        }
        if (
          strictCanonicalSha256V1(workItemIdentity(current)) !==
          strictCanonicalSha256V1(workItemIdentity(parsed.data))
        ) {
          throw new Error(`replay: work item snapshot mismatch for ${parsed.data.id}`);
        }
        assertCanTransition(current.status, parsed.data.status);
        knownWorkItems.set(parsed.data.id, parsed.data);
      }
    }
  }
  return {
    workItems: [...knownWorkItems.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    memories: projectMemories(events)
  };
}

function workItemIdentity(workItem: WorkItem): Record<string, unknown> {
  return {
    id: workItem.id,
    title: workItem.title,
    requester: workItem.requester,
    ...(workItem.requesterSubject ? { requesterSubject: workItem.requesterSubject } : {}),
    intent: workItem.intent,
    target: workItem.target,
    requestedActions: workItem.requestedActions,
    risk: workItem.risk,
    createdAt: workItem.createdAt
  };
}
