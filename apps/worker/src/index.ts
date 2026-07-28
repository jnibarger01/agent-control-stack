import { createPolicyEngine, createWorkItemTools } from "@agent-control-stack/policy-gate";
import { executeSandboxed } from "@agent-control-stack/sandbox";
import { stableHash } from "@agent-control-stack/shared";
import { SqliteWorkItemStore, type WorkItem } from "@agent-control-stack/work-items";
import { WorkspaceManager } from "@agent-control-stack/workspace-manager";

export interface WorkerOptions {
  dbPath?: string;
  workerId?: string;
  execute?: typeof executeSandboxed;
  workspaceManager?: WorkspaceManager;
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
  const execute = options.execute ?? executeSandboxed;

  try {
    workItems.failExpiredLeases();
    const running = tools.claim_next_approved_work_item({ workerId });
    if (!running) {
      return { executed: false, reason: "no approved work item" };
    }
    if (running.status === "blocked") {
      return { executed: false, workItemId: running.id, reason: "blocked by policy" };
    }
    if (!running.attemptId || !running.planHash || !running.inputHash || running.fencingEpoch === undefined) {
      throw new Error("worker claim did not include persisted attempt authority");
    }

    const workspace = running.attemptId
      ? await options.workspaceManager?.provision(running.id, {
          attemptId: running.attemptId,
          leaseId: running.leaseId,
          workerId,
          fencingEpoch: running.fencingEpoch
        })
      : undefined;
    const startedAt = new Date().toISOString();
    if (!isReadOnlyWorkerWorkItem(running)) {
      const completedAt = new Date().toISOString();
      workItems.recordDerivedWorkResult({
        workItemId: running.id,
        leaseId: running.leaseId,
        workerId,
        actionHash: running.actionHash,
        idempotencyKey: workerResultIdempotencyKey(running.attemptId),
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
      if (workspace && running.attemptId) {
        await options.workspaceManager?.teardown(running.id, {
          attemptId: running.attemptId,
          leaseId: running.leaseId,
          workerId,
          fencingEpoch: running.fencingEpoch
        });
      }
      return {
        executed: false,
        workItemId: running.id,
        reason: "worker supports read-only repository inspection only"
      };
    }

    const result = await execute(workspace ? ({ ...running, workspace } as typeof running) : running);
    const completedAt = new Date().toISOString();

    if (result.ok) {
      tools.submit_work_result({
        workItemId: running.id,
        attemptId: running.attemptId,
        leaseId: running.leaseId,
        workerId,
        actionHash: running.actionHash,
        planHash: running.planHash,
        inputHash: running.inputHash,
        fencingEpoch: running.fencingEpoch,
        idempotencyKey: workerResultIdempotencyKey(running.attemptId),
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
        attemptId: running.attemptId,
        leaseId: running.leaseId,
        workerId,
        actionHash: running.actionHash,
        planHash: running.planHash,
        inputHash: running.inputHash,
        fencingEpoch: running.fencingEpoch,
        idempotencyKey: workerResultIdempotencyKey(running.attemptId),
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

    if (workspace && running.attemptId) {
      await options.workspaceManager?.teardown(running.id, {
        attemptId: running.attemptId,
        leaseId: running.leaseId,
        workerId,
        fencingEpoch: running.fencingEpoch
      });
    }

    return { executed: true, executionMode: result.executionMode, workItemId: running.id, reason: workerId };
  } finally {
    workItems.close();
  }
}

export function workerResultIdempotencyKey(attemptId: string): string {
  return stableHash({ domain: "acs.attempt-result.v1", attemptId });
}
