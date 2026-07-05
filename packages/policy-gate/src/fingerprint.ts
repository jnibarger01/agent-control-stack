import { stableHash } from "@agent-control-stack/shared";
import type { WorkItem } from "@agent-control-stack/work-items";

export function policyFingerprint(workItem: WorkItem): string {
  return stableHash({
    requestedActions: workItem.requestedActions,
    requester: workItem.requester,
    risk: workItem.risk,
    target: workItem.target
  });
}
