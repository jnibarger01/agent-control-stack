import { planRecovery, type RecoveryPlan } from "./index.js";

export interface ReconciliationWorkspace {
  attemptId?: string;
  workItemId: string;
  hostPath: string;
}
export interface ReconciliationWorkspaceManager {
  reconcile(activeWorkItemIds: ReadonlySet<string>): Promise<{ orphaned: ReconciliationWorkspace[] }>;
}
export interface ReconciliationLease {
  status: "active" | "expired" | "consumed" | "revoked";
  expiresAt: string;
}
export interface ReconciliationValidationRun {
  passed: boolean;
}
export interface ReconciliationWorkspaceAllocation {
  status: "active" | "closed" | string;
}
export interface ReconciliationStore {
  recordRecoveryDecision(input: { attemptId: string; workItemId: string; decision: RecoveryPlan["decision"]; retryAllowed: boolean; reason: string; retryAfterMs?: number; idempotencyKey: string }, options: { via: "domain_service" }): unknown;
  /** Most recent lease for the attempt, whatever its status - never assumed. */
  getActiveLeaseForAttempt(attemptId: string): ReconciliationLease | undefined;
  /** Independent validation evidence for the attempt, if any was ever recorded. */
  getValidationRunForAttempt(attemptId: string): ReconciliationValidationRun | undefined;
  /** Current workspace-allocation record for the attempt, to know whether cleanup is still owed. */
  getActiveWorkspaceAllocationForAttempt(attemptId: string): ReconciliationWorkspaceAllocation | undefined;
}
export interface StartupReconciliationInput {
  activeWorkItemIds: ReadonlySet<string>;
  maxAttempts: number;
  attemptNumberById: Record<string, number>;
  store: ReconciliationStore;
  workspaceManager: ReconciliationWorkspaceManager;
  now?: () => Date;
}

/**
 * Startup-only reconciliation: observe orphaned workspaces, inspect the real
 * durable evidence for each one (lease status, independent validation
 * result, workspace-allocation status), plan, persist. It never deletes or
 * resumes anything itself - a disappeared process is not, by itself,
 * evidence that the task failed, so every input to planRecovery() here must
 * come from a store lookup, never from an assumption.
 */
export async function reconcileStartup(input: StartupReconciliationInput): Promise<RecoveryPlan[]> {
  const now = input.now ?? (() => new Date());
  const { orphaned } = await input.workspaceManager.reconcile(input.activeWorkItemIds);
  const plans: RecoveryPlan[] = [];
  for (const workspace of orphaned) {
    if (!workspace.attemptId) continue;
    const attemptId = workspace.attemptId;

    const lease = input.store.getActiveLeaseForAttempt(attemptId);
    const leaseActive = lease?.status === "active";
    const leaseExpired = lease ? Date.parse(lease.expiresAt) <= now().getTime() : true;

    const validationRun = input.store.getValidationRunForAttempt(attemptId);
    const validationPresent = validationRun !== undefined;
    const validationPassed = validationRun?.passed ?? false;

    // Fail closed on missing evidence: cleanup only counts as complete when
    // the store positively confirms a closed allocation, not merely because
    // no allocation record was found for this attempt.
    const allocation = input.store.getActiveWorkspaceAllocationForAttempt(attemptId);
    const cleanupComplete = allocation !== undefined && allocation.status !== "active";

    const plan = planRecovery({
      attemptNumber: input.attemptNumberById[attemptId] ?? 1,
      maxAttempts: input.maxAttempts,
      attemptStatus: "unknown",
      // A fresh process on startup genuinely cannot have a live child from a
      // prior run - this is the one input it is legitimate to assume rather
      // than look up.
      processAlive: false,
      leaseActive,
      leaseExpired,
      workspacePresent: true,
      validationPresent,
      validationPassed,
      cleanupComplete,
      failureClass: "process_gone"
    });
    input.store.recordRecoveryDecision({
      attemptId,
      workItemId: workspace.workItemId,
      decision: plan.decision,
      retryAllowed: plan.retryAllowed,
      reason: plan.reason,
      ...(plan.retryAfterMs === undefined ? {} : { retryAfterMs: plan.retryAfterMs }),
      idempotencyKey: `startup-recovery:${attemptId}`
    }, { via: "domain_service" });
    plans.push(plan);
  }
  return plans;
}
