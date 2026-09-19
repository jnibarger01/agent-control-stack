import { endpoints } from "../api/endpoints";
import type { ApprovalResult, UnblockResult, WorkItem } from "../api/types";
import { keys } from "./reconcile";
import { queryCache } from "./query";

/** Every write is followed by invalidation of exactly the views it can change; nothing is patched optimistically. */
function refresh(workItemId: string): void {
  queryCache.invalidate(keys.workItem(workItemId));
  queryCache.invalidate(keys.workItems);
  queryCache.invalidate(keys.executions);
  queryCache.invalidate(keys.events);
}

export const workMutations = {
  async approve(id: string, actionHash: string, reason: string): Promise<ApprovalResult> {
    // The hash is the one ACS recorded for this exact action; ACS re-derives and compares it.
    const result = await endpoints.approveWorkItem(id, { reason, actionHash });
    refresh(id);
    return result;
  },
  async reject(id: string, reason: string): Promise<{ workItem: WorkItem }> {
    const result = await endpoints.rejectWorkItem(id, reason ? { reason } : {});
    refresh(id);
    return result;
  },
  async cancel(id: string, reason: string): Promise<{ workItem: WorkItem }> {
    const result = await endpoints.cancelWorkItem(id, reason ? { reason } : {});
    refresh(id);
    return result;
  },
  async unblock(id: string): Promise<UnblockResult> {
    const result = await endpoints.unblockWorkItem(id);
    refresh(id);
    return result;
  },
  async retry(id: string, reason: string): Promise<{ workItem: WorkItem }> {
    const result = await endpoints.retryWorkItem(id, { reason });
    refresh(id);
    queryCache.invalidate(keys.workItems);
    return result;
  },
  async clone(id: string): Promise<{ workItem: WorkItem }> {
    const result = await endpoints.cloneWorkItem(id, {});
    refresh(id);
    return result;
  }
};
