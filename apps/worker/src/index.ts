import { SqliteAuditLog } from "@agent-control-stack/audit-log";
import { executeSandboxed } from "@agent-control-stack/sandbox";
import { nextApprovedWorkItem, SqliteWorkItemStore, workItemStatusEvent } from "@agent-control-stack/work-items";

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
  const auditLog = new SqliteAuditLog(dbPath);
  const workItems = new SqliteWorkItemStore(dbPath);
  const workerId = options.workerId ?? "local-worker";

  try {
    const workItem = nextApprovedWorkItem(workItems);
    if (!workItem) {
      return { executed: false, reason: "no approved work item" };
    }

    const running = workItems.startWorkItem(workItem.id);
    auditLog.append(workItemStatusEvent(running));
    const result = await executeSandboxed(running);

    if (result.ok) {
      auditLog.append(
        workItemStatusEvent(
          workItems.submitWorkResult({ id: workItem.id, status: "succeeded", result: { output: result.output } })
        )
      );
    } else {
      auditLog.append(
        workItemStatusEvent(
          workItems.submitWorkResult({
            id: workItem.id,
            status: "failed",
            result: { error: result.error ?? "sandbox execution failed" }
          })
        )
      );
    }

    return { executed: true, workItemId: workItem.id, reason: workerId };
  } finally {
    auditLog.close();
    workItems.close();
  }
}
