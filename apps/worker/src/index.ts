import { createPolicyEngine, createWorkItemTools } from "@agent-control-stack/policy-gate";
import { executeSandboxed } from "@agent-control-stack/sandbox";
import { stableHash } from "@agent-control-stack/shared";
import { SqliteWorkItemStore, type WorkItem } from "@agent-control-stack/work-items";

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

/**
 * The one-shot worker is the first safe execution slice. Until authoritative
 * attempt/workspace wiring is complete, it may only simulate filesystem
 * inspection. Approval alone must never turn a mutation into a successful
 * worker result.
 */
const readOnlyWorkerActionKinds = new Set(["system.status", "fs.list", "fs.stat", "fs.read", "fs.search_name"]);

export function isReadOnlyWorkerWorkItem(workItem: Pick<WorkItem, "requestedActions">): boolean {
  return (
    workItem.requestedActions.length > 0 &&
    workItem.requestedActions.every(
      (action) =>
        readOnlyWorkerActionKinds.has(action.kind) &&
        action.params.write !== true &&
        action.params.destructive !== true &&
        action.params.network !== true &&
        action.params.allowNetwork !== true
    )
  );
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
    if (!isReadOnlyWorkerWorkItem(running)) {
      const completedAt = new Date().toISOString();
      workItems.recordDerivedWorkResult({
        workItemId: running.id,
        leaseId: running.leaseId,
        workerId,
        actionHash: running.actionHash,
        idempotencyKey: workerResultIdempotencyKey(running.id, running.leaseId, workerId),
        outcome: "blocked",
        startedAt,
        finishedAt: completedAt,
        exitCode: null,
        summary: "worker supports read-only repository inspection only; no command ran",
        error: "worker_read_only_scope",
        structuredOutput: { simulated: true, blocked: true, reason: "worker_read_only_scope" },
        artifacts: [],
        simulationMetadata: {
          executionMode: "dry_run",
          simulated: true,
          reason: "worker_read_only_scope"
        }
      });
      return {
        executed: false,
        workItemId: running.id,
        reason: "worker supports read-only repository inspection only"
      };
    }

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
