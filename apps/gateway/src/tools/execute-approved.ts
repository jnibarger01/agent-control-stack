import { createPolicyEngine, createWorkItemTools } from "@agent-control-stack/policy-gate";
import { type WorkItem, type WorkItemStore } from "@agent-control-stack/work-items";

export interface ExecutionResult {
  ok: boolean;
  output?: string;
  error?: string;
}

export interface ExecuteApprovedOptions {
  store: WorkItemStore;
  workerId: string;
  execute: (workItem: WorkItem) => Promise<ExecutionResult>;
}

export async function executeApprovedWorkItem(options: ExecuteApprovedOptions) {
  const tools = createWorkItemTools(options.store, createPolicyEngine());
  options.store.failExpiredLeases();
  const running = tools.claim_next_approved_work_item({ workerId: options.workerId });
  if (!running) {
    return { executed: false, reason: "no approved work item" };
  }
  if (running.status === "blocked") {
    return { executed: false, workItemId: running.id, reason: "policy blocked claim" };
  }

  const result = await options.execute(running);
  tools.submit_work_result({
    id: running.id,
    workerId: options.workerId,
    leaseToken: running.leaseToken,
    status: result.ok ? "succeeded" : "failed",
    result: result.ok ? { output: result.output ?? "" } : { error: result.error ?? "execution failed" }
  });

  return { executed: true, workItemId: running.id, reason: options.workerId };
}
