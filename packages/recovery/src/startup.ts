import { planRecovery, type RecoveryPlan } from "./index.js";
import type { ExecutionAttempt } from "@agent-control-stack/work-items";

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
  recordRecoveryDecision?(input: { attemptId: string; workItemId: string; decision: RecoveryPlan["decision"]; retryAllowed: boolean; reason: string; retryAfterMs?: number; idempotencyKey: string }, options: { via: "domain_service" }): unknown;
  getActiveLeaseForAttempt?(attemptId: string): ReconciliationLease | undefined;
  getValidationRunForAttempt?(attemptId: string): ReconciliationValidationRun | undefined;
  getActiveWorkspaceAllocationForAttempt?(attemptId: string): ReconciliationWorkspaceAllocation | undefined;
  getAttempt?(attemptId: string): Pick<ExecutionAttempt, "attemptNumber" | "status" | "workItemId"> | undefined;
  getActiveWorkspaceAllocationForWorkItem?(workItemId: string): ReconciliationWorkspaceAllocation | undefined;
  /** Existing durable audit primitive; recovery decisions do not add a new event API. */
  recordConnectorRequest?(input: {
    workItemId?: string;
    actor: string;
    source: string;
    route: string;
    toolName: string;
    requestId: string;
    authMethod: string;
    authSubject: string;
    authScopes: string[];
  }): unknown;
}
export interface StartupReconciliationInput {
  activeWorkItemIds: ReadonlySet<string>;
  maxAttempts: number;
  attemptNumberById: Record<string, number>;
  store: ReconciliationStore;
  workspaceManager: ReconciliationWorkspaceManager;
  now?: () => Date;
}

export interface StartupRecoveryPlan {
  attemptId: string;
  workItemId: string;
  workspace: ReconciliationWorkspace;
  plan: RecoveryPlan;
}

/**
 * Startup-only reconciliation: observe orphaned workspaces, inspect the real
 * durable evidence for each one (lease status, independent validation
 * result, workspace-allocation status), plan, persist. It never deletes or
 * resumes anything itself - a disappeared process is not, by itself,
 * evidence that the task failed, so every input to planRecovery() here must
 * come from a store lookup, never from an assumption.
 */
export async function reconcileStartup(input: StartupReconciliationInput): Promise<StartupRecoveryPlan[]> {
  const now = input.now ?? (() => new Date());
  const { orphaned } = await input.workspaceManager.reconcile(input.activeWorkItemIds);
  const plans: StartupRecoveryPlan[] = [];
  for (const workspace of orphaned) {
    if (!workspace.attemptId) continue;
    const attemptId = workspace.attemptId;

    const attempt = input.store.getAttempt?.(attemptId);
    const lease = input.store.getActiveLeaseForAttempt?.(attemptId);
    const leaseActive = lease ? lease.status === "active" : attempt ? attempt.status === "leased" || attempt.status === "running" : false;
    const leaseExpired = lease ? Date.parse(lease.expiresAt) <= now().getTime() : !leaseActive;
    // The current store has no validation lookup yet. Missing validation is
    // deliberately treated as absent, which keeps reconciliation fail-closed.
    const validationRun = input.store.getValidationRunForAttempt?.(attemptId);
    const validationPresent = validationRun !== undefined;
    const validationPassed = validationRun?.passed ?? false;

    // Fail closed on missing evidence: cleanup only counts as complete when
    // the store positively confirms a closed allocation, not merely because
    // no allocation record was found for this attempt.
    const allocation = input.store.getActiveWorkspaceAllocationForAttempt?.(attemptId) ?? input.store.getActiveWorkspaceAllocationForWorkItem?.(workspace.workItemId);
    const cleanupComplete = allocation !== undefined && allocation.status !== "active";

    const plan = planRecovery({
      attemptNumber: input.attemptNumberById[attemptId] ?? attempt?.attemptNumber ?? 1,
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
    if (input.store.recordRecoveryDecision) {
      input.store.recordRecoveryDecision({
        attemptId,
        workItemId: workspace.workItemId,
        decision: plan.decision,
        retryAllowed: plan.retryAllowed,
        reason: plan.reason,
        ...(plan.retryAfterMs === undefined ? {} : { retryAfterMs: plan.retryAfterMs }),
        idempotencyKey: `startup-recovery:${attemptId}`
      }, { via: "domain_service" });
    } else if (input.store.recordConnectorRequest) {
      input.store.recordConnectorRequest({
        workItemId: workspace.workItemId,
        actor: "recovery-service",
        source: "startup-reconciliation",
        route: "recovery.decision",
        toolName: plan.decision,
        requestId: `startup-recovery:${attemptId}`,
        authMethod: "domain_service",
        authSubject: "recovery-service",
        authScopes: ["acs:recovery:write"]
      });
    }
    plans.push({ attemptId, workItemId: workspace.workItemId, workspace, plan });
  }
  return plans;
}
