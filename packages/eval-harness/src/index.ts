export * from "./promotion-gate.js";
export * from "./replay.js";
export * from "./sqlite-eval.js";
import type { AuditEvent } from "@agent-control-stack/shared";
import { WorkItemEvent, workItemSchema } from "@agent-control-stack/work-items";

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
