import { stableHash } from "@agent-control-stack/shared";
import { createPolicyEngine, createWorkItemTools } from "@agent-control-stack/policy-gate";
import { type WorkItem, type WorkItemStore } from "@agent-control-stack/work-items";

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
  const tools = createWorkItemTools(options.store, createPolicyEngine());
  options.store.failExpiredLeases();
  const running = tools.claim_next_approved_work_item({ workerId: options.workerId });
  if (!running) {
    return { executed: false, reason: "no approved work item" };
  }
  if (running.status === "blocked") {
    return { executed: false, workItemId: running.id, reason: "policy blocked claim" };
  }
  if (!running.attemptId || !running.planHash || !running.inputHash || running.fencingEpoch === undefined) {
    throw new Error("approved dispatcher claim did not include persisted attempt authority");
  }

  const startedAt = running.startedAt;
  let result: ExecutionResult;
  try {
    result = await options.execute(running);
  } catch (error) {
    result = {
      ok: false,
      executionMode: "dry_run",
      error: error instanceof Error ? error.message : "simulated worker failure"
    };
  }

  const finishedAt = new Date().toISOString();
  tools.submit_work_result({
    workItemId: running.id,
    attemptId: running.attemptId,
    leaseId: running.leaseId,
    workerId: running.workerId,
    actionHash: running.actionHash,
    planHash: running.planHash,
    inputHash: running.inputHash,
    fencingEpoch: running.fencingEpoch,
    idempotencyKey: stableHash({ domain: "acs.attempt-result.v1", attemptId: running.attemptId }),
    outcome: result.ok ? "succeeded" : "worker_infrastructure_failure",
    startedAt,
    finishedAt,
    exitCode: result.ok ? 0 : null,
    summary: result.ok ? "approved dry-run dispatch completed" : "approved dry-run dispatch failed",
    stdout: result.output,
    error: result.ok ? undefined : (result.error ?? "simulated worker failure"),
    structuredOutput: { simulated: true },
    artifacts: [],
    simulationMetadata: { executionMode: "dry_run", simulated: true, reason: "approved_dispatch" }
  });

  return { executed: true, workItemId: running.id, reason: options.workerId };
}
