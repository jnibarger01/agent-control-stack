import type { EvidenceStoreReader } from "@agent-control-stack/evidence";
import { SqliteExecutionReadStore, SqliteWorkItemStore } from "@agent-control-stack/work-items";

/**
 * READ-ONLY adapter from ACS store state to the evidence surface. Only *read*
 * methods of the underlying stores are used. This class exposes no mutator.
 */
export class SqliteEvidenceStoreReader implements EvidenceStoreReader {
  private readonly store: SqliteWorkItemStore;
  private readonly reads: SqliteExecutionReadStore;

  constructor(private readonly dbPath: string) {
    this.store = new SqliteWorkItemStore(dbPath);
    this.reads = new SqliteExecutionReadStore(dbPath);
  }

  close(): void {
    this.store.close();
    this.reads.close();
  }

  getWorkItemSummary(workItemId: string): unknown {
    const item = this.store.get(workItemId);
    if (!item) return { available: false };
    return {
      id: item.id,
      title: item.title,
      status: item.status,
      risk: item.risk,
      intent: item.intent,
      requester: item.requester,
      requestedActions: item.requestedActions,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt
    };
  }

  getAttemptSummary(attemptId: string): unknown {
    const attempt = this.store.getAttempt(attemptId);
    if (!attempt) return { available: false };
    return {
      attemptId: attempt.attemptId,
      workItemId: attempt.workItemId,
      planHash: attempt.planHash,
      status: attempt.status,
      attemptNumber: attempt.attemptNumber,
      currentFencingEpoch: attempt.currentFencingEpoch,
      phase: this.store.getAttemptPhase(attemptId) ?? null,
      startedAt: attempt.startedAt ?? null
    };
  }

  getWorkspaceAllocationSummary(attemptId: string): unknown {
    const allocation = this.store.getActiveWorkspaceAllocationForAttempt(attemptId);
    if (!allocation) return { available: false };
    return {
      allocationId: allocation.allocationId,
      branch: allocation.branch,
      baseRef: allocation.baseRef,
      status: allocation.status,
      hostPath: allocation.hostPath
    };
  }

  getValidationRunSummary(attemptId: string): unknown {
    const run = this.store.getValidationRunForAttempt(attemptId);
    if (!run) return { available: false };
    return {
      runId: run.runId,
      passed: run.passed,
      checks: run.checks.map((c) => ({ name: c.name, passed: c.passed, detail: c.detail })),
      createdAt: run.createdAt
    };
  }

  getExecutionPlanSummary(workItemId: string): unknown {
    const plan = this.store.getCurrentExecutionPlan(workItemId);
    if (!plan) return { available: false };
    return {
      planId: plan.planId,
      planHash: plan.planHash,
      planNumber: plan.planNumber,
      objective: plan.definition.objective,
      constraints: plan.definition.constraints,
      steps: plan.definition.steps.map((s) => ({ stepId: s.stepId, action: s.action.kind }))
    };
  }

  getExecutionSummary(workItemId: string): unknown {
    const events = this.store
      .readEvents({ limit: 200, workItemId })
      .filter((e) => e.name.startsWith("execution.") || e.name.startsWith("desktop_commander."));
    return { events: events.map((e) => ({ name: e.name, sequence: e.sequence, body: e.body })) };
  }

  getSandboxSummary(attemptId: string): unknown {
    const manifest = this.store.getEvidenceManifestForAttempt(attemptId);
    if (!manifest) return { available: false };
    const m = manifest.manifest as Record<string, unknown>;
    return {
      sandboxProfile: m.sandboxProfile ?? null,
      networkProfile: m.networkProfile ?? null,
      networkDecisions: m.networkDecisions ?? null
    };
  }

  getPolicyDecisions(workItemId: string): unknown {
    return this.store
      .readEvents({ limit: 200, workItemId })
      .filter((e) => e.name === "policy.decided")
      .map((e) => ({ sequence: e.sequence, body: e.body }));
  }

  getApprovalSummary(workItemId: string): unknown {
    return this.store
      .readEvents({ limit: 200, workItemId })
      .filter((e) => e.name.startsWith("approval.") || e.name.startsWith("execution_plan_approval."))
      .map((e) => ({ name: e.name, sequence: e.sequence, body: e.body }));
  }

  getAuditExcerpt(workItemId: string, options: { limit?: number; afterSequence?: number }): unknown {
    return this.store
      .readEvents({ workItemId, ...options })
      .map((e) => ({ sequence: e.sequence, name: e.name, timeUnixNano: e.timeUnixNano, attributes: e.attributes }));
  }

  getEvidenceManifest(attemptId: string): unknown {
    const manifest = this.store.getEvidenceManifestForAttempt(attemptId);
    return manifest ? manifest.manifest : { available: false };
  }
}
