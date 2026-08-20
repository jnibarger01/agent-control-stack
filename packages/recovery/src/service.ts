import { type RecoveryPlan } from "./index.js";
import { reconcileStartup, type StartupRecoveryPlan, type StartupReconciliationInput } from "./startup.js";
import { ControlStackError } from "@agent-control-stack/shared";
import type { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import type { ExecutionAttempt } from "@agent-control-stack/work-items";
import type { WorkspaceManager } from "@agent-control-stack/workspace-manager";

/**
 * Recovery execution service.
 *
 * Wraps the pure `reconcileStartup()` decision function with the actual
 * execution of those decisions: lease-aware cleanup for cleanup_pending,
 * and automatic retry-attempt creation for retryable decisions.
 *
 * This is the authoritative startup reconciliation path. It is deliberately
 * thin: it does not reimplement the decision logic, it executes what the
 * decision function already decided.
 */
export interface RecoveryExecutionServiceOptions {
  /** SQLite-backed work-item store. */
  store: SqliteWorkItemStore;
  /** Workspace manager with proven reconcile() + teardown() paths. */
  workspaceManager: WorkspaceManager;
  /** Maximum attempts per work item for retry decisions. */
  maxAttempts: number;
  /** Optional clock for deterministic testing. */
  now?: () => Date;
}

export interface RecoveryExecutionResult {
  /** Recovery decisions persisted for orphaned attempts. */
  plans: StartupRecoveryPlan[];
  /** Retry attempts that were automatically created. */
  retryAttemptsCreated: number;
  /** Lease-aware workspace cleanups that were executed. */
  cleanupsExecuted: number;
}

/**
 * Execute startup reconciliation and act on the decisions.
 *
 * Fail-closed behavior:
 * - If workspace reconciliation itself fails, no recovery decisions are
 *   executed and the error is surfaced.
 * - If a retry-attempt creation fails, that specific attempt is recorded
 *   as a failure and execution continues for the remaining orphans.
 * - If a cleanup execution fails, the error is surfaced (cleanup is
 *   authoritative state mutation and must not be silently skipped).
 */
export async function executeStartupReconciliation(
  input: StartupReconciliationInput,
  options: RecoveryExecutionServiceOptions
): Promise<RecoveryExecutionResult> {
  const plans = await reconcileStartup(input);

  let retryAttemptsCreated = 0;
  let cleanupsExecuted = 0;

  for (const recovery of plans) {
    const { plan, attemptId, workItemId } = recovery;
    if (plan.decision === "retryable") {
      try {
        await executeLeaseAwareCleanup(options.store, options.workspaceManager, attemptId);
        await createRetryAttemptForRecoveryPlan(
          options.store,
          recovery,
          options.now
        );
        retryAttemptsCreated += 1;
      } catch (error) {
        await recordRecoveryExecutionFailure(
          options.store,
          attemptId,
          workItemId,
          "retry_attempt_creation_failed",
          String(error)
        );
      }
    } else if (plan.decision === "cleanup_pending") {
      try {
        await executeLeaseAwareCleanup(
          options.store,
          options.workspaceManager,
          attemptId
        );
        cleanupsExecuted += 1;
      } catch (error) {
        await recordRecoveryExecutionFailure(
          options.store,
          attemptId,
          workItemId,
          "cleanup_execution_failed",
          String(error)
        );
        throw error; // cleanup is authoritative; fail closed
      }
    }
    // resumable, validation_pending, terminal_failed: no automatic action
  }

  return { plans, retryAttemptsCreated, cleanupsExecuted };
}

/**
 * Create an automatic retry attempt for a retryable recovery decision.
 *
 * Uses the existing retry/clone semantics: retries the original work item
 * (creating a new work item with lineage), then creates a fresh attempt
 * for that retry work item.
 */
async function createRetryAttemptForRecoveryPlan(
  store: SqliteWorkItemStore,
  recovery: StartupRecoveryPlan,
  now?: () => Date
): Promise<ExecutionAttempt> {
  const { attemptId, workItemId, plan } = recovery;

  if (!attemptId || !workItemId) {
    throw new ControlStackError(
      "recovery_retry_missing_identity",
      `cannot create retry attempt: missing attempt/work item identity`
    );
  }

  // Retrieve the original attempt to carry planHash/inputHash forward.
  const attempt = store.getAttempt(attemptId);
  if (!attempt) {
    throw new ControlStackError(
      "recovery_retry_missing_attempt",
      `cannot create retry attempt: attempt ${attemptId} not found`
    );
  }

  if (attempt.workItemId !== workItemId) {
    throw new ControlStackError("recovery_retry_identity_mismatch", "recovery workspace and attempt identities disagree");
  }
  // Retrieve the original work item through the existing work-item store API.
  const workItem = store.get(attempt.workItemId);
  if (!workItem) {
    throw new ControlStackError(
      "recovery_retry_missing_work_item",
      `cannot create retry attempt for ${workItemId}: work item not found`
    );
  }

  // A repeated startup pass reuses persisted retry lineage instead of
  // creating another retry for the same orphan.
  const existingRetry = store.list().find(
    (candidate) => candidate.sourceWorkItemId === workItem.id && candidate.lineageType === "retry"
  );
  if (existingRetry) {
    return store.createAttempt(
      { workItemId: existingRetry.id, planHash: attempt.planHash, inputHash: attempt.inputHash, now: now ? now() : new Date() },
      { via: "domain_service" }
    );
  }

  // Retry the work item (creates a new work item with retry lineage).
  const retryWorkItem = store.retryWorkItem(workItem.id, {
    actor: "recovery-service",
    reason: plan.reason,
  });

  // Create the attempt for the retry work item, carrying forward
  // the planHash and inputHash from the original attempt.
  const newAttempt = store.createAttempt(
    {
      workItemId: retryWorkItem.id,
      planHash: attempt.planHash,
      inputHash: attempt.inputHash,
      now: now ? now() : new Date(),
    },
    { via: "domain_service" }
  );

  return newAttempt;
}

/**
 * Execute lease-aware cleanup for a cleanup_pending recovery decision.
 *
 * Uses the workspace manager's teardown path, which already enforces
 * fencing via leaseId, workerId, and fencingEpoch.
 */
async function executeLeaseAwareCleanup(
  store: SqliteWorkItemStore,
  workspaceManager: WorkspaceManager,
  attemptId: string
): Promise<void> {
  const attempt = store.getAttempt(attemptId);
  if (!attempt) throw new ControlStackError("recovery_cleanup_missing_attempt", `attempt ${attemptId} not found`);
  const workItem = store.get(attempt.workItemId);
  if (!workItem) throw new ControlStackError("recovery_cleanup_missing_work_item", `work item ${attempt.workItemId} not found`);
  const allocation = store.getActiveWorkspaceAllocationForWorkItem(workItem.id);
  if (!allocation) {
    // No active allocation means nothing to clean up. This is not an error.
    return;
  }

  await workspaceManager.teardown(allocation.workItemId);
}

/**
 * Record a recovery execution failure for observability.
 *
 * Persist execution failure through the existing recovery decision/audit path.
 */
async function recordRecoveryExecutionFailure(
  store: SqliteWorkItemStore,
  attemptId: string,
  workItemId: string,
  errorCode: string,
  message: string
): Promise<void> {
  const recoveryStore = store as unknown as {
    recordRecoveryDecision?: (input: {
      attemptId: string;
      workItemId: string;
      decision: RecoveryPlan["decision"];
      retryAllowed: boolean;
      reason: string;
      idempotencyKey: string;
    }, options: { via: "domain_service" }) => unknown;
  };
  if (recoveryStore.recordRecoveryDecision) {
    recoveryStore.recordRecoveryDecision(
      {
        attemptId,
        workItemId,
        decision: "terminal_failed",
        retryAllowed: false,
        reason: `${errorCode}: ${message}`.slice(0, 2_000),
        idempotencyKey: `startup-recovery-execution:${attemptId}:${errorCode}`
      },
      { via: "domain_service" }
    );
    return;
  }
  store.recordConnectorRequest({
    workItemId,
    actor: "recovery-service",
    source: "startup-reconciliation",
    route: "recovery.execution_failed",
    toolName: errorCode,
    requestId: `startup-recovery-execution:${attemptId}:${errorCode}`,
    authMethod: "domain_service",
    authSubject: "recovery-service",
    authScopes: ["acs:recovery:write", message.slice(0, 200)]
  });
}
