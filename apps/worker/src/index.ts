import { evaluateWorkItemPolicy, summarizePolicy } from "@agent-control-stack/policy-gate";
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

    const evaluations = evaluateWorkItemPolicy(running, workerId);
    for (const evaluation of evaluations) {
      workItems.recordPolicyDecision({
        workItemId: running.id,
        actionHash: evaluation.actionHash,
        ...evaluation.decision
      });
    }

    const decision = summarizePolicy(evaluations);
    const missingApproval = evaluations.find(
      (evaluation) =>
        evaluation.decision.decision === "require_approval" &&
        !workItems.hasApproval(running.id, evaluation.actionHash)
    );
    if (decision.decision === "deny" || missingApproval) {
      workItems.submitWorkResult({
        id: running.id,
        status: "blocked",
        result: { error: missingApproval ? "approval missing for action hash" : decision.reason }
      });
      return { executed: false, workItemId: running.id, reason: missingApproval ? "approval missing" : decision.reason };
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
