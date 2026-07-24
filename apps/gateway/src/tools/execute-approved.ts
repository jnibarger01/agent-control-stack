import { WORKER_PROTOCOL_VERSION, type WorkItem, type WorkItemStore } from "@agent-control-stack/work-items";

export interface ExecutionResult {
  ok: boolean;
  executionMode: "dry_run";
  output?: string;
  error?: string;
}

export interface ExecuteApprovedOptions {
  store: WorkItemStore;
  workerId: string;
  execute: (workItem: WorkItem) => Promise<ExecutionResult>;
}

export async function executeApprovedWorkItem(options: ExecuteApprovedOptions) {
  void options;
  return {
    executed: false,
    reason: `${WORKER_PROTOCOL_VERSION} result acceptance is not available in Phase 2 Slice 1`
  };
}
