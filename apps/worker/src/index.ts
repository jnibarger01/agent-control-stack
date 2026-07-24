import { stableHash } from "@agent-control-stack/shared";
import { SqliteWorkItemStore, WORKER_PROTOCOL_VERSION } from "@agent-control-stack/work-items";

export interface WorkerOptions {
  dbPath?: string;
  workerId?: string;
}

export interface WorkerResult {
  executed: boolean;
  executionMode?: "dry_run";
  workItemId?: string;
  reason?: string;
}

export async function runWorkerOnce(options: WorkerOptions = {}): Promise<WorkerResult> {
  const dbPath = options.dbPath ?? process.env.ACS_DB_PATH ?? "storage/local.db";
  const workItems = new SqliteWorkItemStore(dbPath);

  try {
    return {
      executed: false,
      reason: `${WORKER_PROTOCOL_VERSION} result acceptance is not available in Phase 2 Slice 1`
    };
  } finally {
    workItems.close();
  }
}

export function workerResultIdempotencyKey(workItemId: string, leaseId: string, workerId: string): string {
  return stableHash({ domain: "acs.worker-result", workItemId, leaseId, workerId, attempt: 1 });
}
