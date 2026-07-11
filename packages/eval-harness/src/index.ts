export * from "./promotion-gate.js";
import type { AuditEvent } from "@agent-control-stack/shared";
import { projectMemories } from "@agent-control-stack/temporal-memory";
import { WorkItemEvent, projectWorkItems, workItemSchema } from "@agent-control-stack/work-items";

export function replay(events: AuditEvent[]) {
  return {
    workItems: projectWorkItems(events),
    memories: projectMemories(events)
  };
}

export function findUnapprovedExecution(events: AuditEvent[]): string[] {
  const approved = new Set<string>();
  const violations: string[] = [];

  for (const event of events) {
    const parsed = workItemSchema.safeParse(event.body);
    if (!parsed.success) {
      continue;
    }
    const workItemId = parsed.data.id;
    if (event.name === WorkItemEvent.Approved) {
      approved.add(workItemId);
    }
    if (event.name === WorkItemEvent.Running && !approved.has(workItemId)) {
      violations.push(workItemId);
    }
  }

  return violations;
}
