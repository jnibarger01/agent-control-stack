import { evaluateWorkItemPolicy, summarizePolicy } from "@agent-control-stack/policy-gate";
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

  const evaluations = evaluateWorkItemPolicy(running, options.workerId);
  for (const evaluation of evaluations) {
    options.store.recordPolicyDecision({
      workItemId: running.id,
      actionHash: evaluation.actionHash,
      ...evaluation.decision
    });
  }

  const decision = summarizePolicy(evaluations);
  const missingApproval = evaluations.find(
    (evaluation) =>
      evaluation.decision.decision === "require_approval" &&
      !options.store.hasApproval(running.id, evaluation.actionHash)
  );
  if (decision.decision === "deny" || missingApproval) {
    options.store.submitWorkResult({
      id: running.id,
      status: "blocked",
      result: { error: missingApproval ? "approval missing for action hash" : decision.reason }
    });
    return { executed: false, workItemId: running.id, reason: missingApproval ? "approval missing" : decision.reason };
  }

  const result = await options.execute(running);
  options.store.submitWorkResult({
    id: running.id,
    status: result.ok ? "succeeded" : "failed",
    result: result.ok ? { output: result.output ?? "" } : { error: result.error ?? "execution failed" }
  });

  return { executed: true, workItemId: running.id, reason: options.workerId };
}
