import { ExecutionAdmissionScheduler } from "@agent-control-stack/execution-admission";
import {
  claimNextAuthoritativeWorkItem,
  createPolicyEngine,
  createWorkItemTools,
  recordAuthoritativeExecutionOutcome,
  resolveNimbleRoutingConfig,
  type AuthoritativeRouteResult
} from "@agent-control-stack/policy-gate";
import { stableHash } from "@agent-control-stack/shared";
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
  /** Inject the Nimble transport (tests only). */
  routingFetch?: typeof fetch;
  now?: Date;
}

export async function executeApprovedWorkItem(options: ExecuteApprovedOptions) {
  const policy = createPolicyEngine();
  const tools = createWorkItemTools(options.store, policy);
  options.store.failExpiredLeases();
  const routingConfig = resolveNimbleRoutingConfig(process.env);
  let releaseAdmission: (() => void) | undefined;
  let routedDecision: AuthoritativeRouteResult | undefined;
  let running: ReturnType<typeof tools.claim_next_approved_work_item>;
  if (routingConfig.enabled) {
    const scheduler = new ExecutionAdmissionScheduler();
    const claimed = await claimNextAuthoritativeWorkItem({
      store: options.store,
      policy,
      workerId: options.workerId,
      config: routingConfig,
      ...(options.now ? { now: options.now } : {}),
      ...(options.routingFetch ? { fetchImpl: options.routingFetch } : {}),
      admission: {
        acquire: (input) => {
          const now = Date.now();
          return scheduler.acquire({
            requestId: input.requestId,
            lane: input.lane,
            executorId: input.executorId,
            actorId: input.actorId,
            toolName: "authoritative_dispatch",
            executionClass: "execution",
            enqueuedAt: now,
            deadlineAt: now + 1_000,
            signal: AbortSignal.timeout(1_000)
          });
        }
      }
    });
    if (!claimed.claimed) {
      return { executed: false, reason: claimed.reason };
    }
    running = claimed.running;
    releaseAdmission = claimed.releaseAdmission;
    routedDecision = claimed.decision;
  } else {
    running = tools.claim_next_approved_work_item({ workerId: options.workerId });
  }
  if (!running) {
    return { executed: false, reason: "no approved work item" };
  }
  try {
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
    if (routedDecision?.executorId && running.attemptId) {
      recordAuthoritativeExecutionOutcome(options.store, routedDecision, {
        executorId: routedDecision.executorId,
        ...(routedDecision.model ? { model: routedDecision.model } : {}),
        latencyMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
        success: result.ok,
        timedOut: false,
        retryCount: 0,
        idempotencyKey: `o${stableHash({ decisionId: routedDecision.decisionId, attemptId: running.attemptId })}`
      });
    }
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
  } finally {
    releaseAdmission?.();
  }
}
