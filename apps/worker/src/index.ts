import { createPolicyEngine, createWorkItemTools } from "@agent-control-stack/policy-gate";
import { executeSandboxed } from "@agent-control-stack/sandbox";
import { stableHash } from "@agent-control-stack/shared";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";

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
  const tools = createWorkItemTools(workItems, createPolicyEngine());
  const workerId = options.workerId ?? "local-worker";

  try {
    workItems.failExpiredLeases();
    const running = tools.claim_next_approved_work_item({ workerId });
    if (!running) {
      return { executed: false, reason: "no approved work item" };
    }
    if (running.status === "blocked") {
      return { executed: false, workItemId: running.id, reason: "blocked by policy" };
    }

    const startedAt = new Date().toISOString();
    const result = await executeSandboxed(running);
    const completedAt = new Date().toISOString();

    if (result.ok) {
      tools.submit_work_result({
        workItemId: running.id,
        leaseId: running.leaseId,
        workerId,
        actionHash: running.actionHash,
        idempotencyKey: workerResultIdempotencyKey(running.id, running.leaseId, workerId),
        outcome: "succeeded",
        startedAt,
        finishedAt: completedAt,
        exitCode: 0,
        summary: "dry-run simulation completed; no real command ran",
        stdout: result.output,
        structuredOutput: { simulated: true },
        artifacts: [],
        simulationMetadata: { executionMode: result.executionMode, simulated: true }
      });
    } else {
      tools.submit_work_result({
        workItemId: running.id,
        leaseId: running.leaseId,
        workerId,
        actionHash: running.actionHash,
        idempotencyKey: workerResultIdempotencyKey(running.id, running.leaseId, workerId),
        outcome: "failed",
        startedAt,
        finishedAt: completedAt,
        exitCode: null,
        summary: "dry-run simulation failed; no real command ran",
        error: result.error ?? "dry-run sandbox simulation failed",
        stdout: result.output,
        stderr: result.error,
        structuredOutput: { simulated: true },
        artifacts: [],
        simulationMetadata: { executionMode: result.executionMode, simulated: true }
      });
    }

    return { executed: true, executionMode: result.executionMode, workItemId: running.id, reason: workerId };
  } finally {
    workItems.close();
  }
}

export function workerResultIdempotencyKey(workItemId: string, leaseId: string, workerId: string): string {
  return stableHash({ domain: "acs.worker-result", workItemId, leaseId, workerId, attempt: 1 });
}
