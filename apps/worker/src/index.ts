import { executeSandboxed } from "@agent-control-stack/sandbox";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";

export interface WorkerOptions {
  dbPath?: string;
  workerId?: string;
}

export interface WorkerResult {
  executed: boolean;
  workItemId?: string;
  reason?: string;
}

export async function runWorkerOnce(options: WorkerOptions = {}): Promise<WorkerResult> {
  const dbPath = options.dbPath ?? process.env.ACS_DB_PATH ?? "storage/local.db";
  const workItems = new SqliteWorkItemStore(dbPath);
  const workerId = options.workerId ?? "local-worker";

  try {
    workItems.failExpiredLeases();
    const running = workItems.claimNextApprovedWorkItem(workerId);
    if (!running) {
      return { executed: false, reason: "no approved work item" };
    }

    const result = await executeSandboxed(running);

    if (result.ok) {
      workItems.submitWorkResult({ id: running.id, status: "succeeded", result: { output: result.output } });
    } else {
      workItems.submitWorkResult({
        id: running.id,
        status: "failed",
        result: { error: result.error ?? "sandbox execution failed" }
      });
    }

    return { executed: true, workItemId: running.id, reason: workerId };
  } finally {
    workItems.close();
  }
}
