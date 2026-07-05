import type { WorkItem, WorkItemStore } from "@agent-control-stack/work-items";

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
  options.store.failExpiredLeases();
  const running = options.store.claimNextApprovedWorkItem(options.workerId);
  if (!running) {
    return { executed: false, reason: "no approved work item" };
  }

  const result = await options.execute(running);
  options.store.submitWorkResult({
    id: running.id,
    status: result.ok ? "succeeded" : "failed",
    result: result.ok ? { output: result.output ?? "" } : { error: result.error ?? "execution failed" }
  });

  return { executed: true, workItemId: running.id, reason: options.workerId };
}
