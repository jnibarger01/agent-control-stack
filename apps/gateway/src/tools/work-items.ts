import { createWorkItemTools, type WorkItemStore } from "@agent-control-stack/work-items";

export const workItemToolNames = [
  "create_work_item",
  "get_work_item",
  "list_work_items",
  "approve_work_item",
  "cancel_work_item",
  "submit_work_result"
] as const;

export function createGatewayWorkItemTools(store: WorkItemStore) {
  return createWorkItemTools(store);
}
