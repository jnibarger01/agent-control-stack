export type RecoveryDecision = "resumable" | "retryable" | "validation_pending" | "cleanup_pending" | "terminal_failed";
export type RecoveryFailureClass = "engine_timeout" | "process_gone" | "validation_failed" | "policy_failure" | "approval_failure" | "integrity_failure" | "fencing_violation" | "unknown";

export interface RecoveryInput {
  attemptNumber: number;
  maxAttempts: number;
  attemptStatus: "pending" | "leased" | "running" | "interrupted" | "succeeded" | "failed" | "cancelled" | "unknown" | "quarantined";
  processAlive: boolean;
  leaseActive: boolean;
  leaseExpired: boolean;
  workspacePresent: boolean;
  validationPresent: boolean;
  validationPassed: boolean;
  cleanupComplete: boolean;
  failureClass?: RecoveryFailureClass;
}

export interface RecoveryPlan {
  decision: RecoveryDecision;
  retryAllowed: boolean;
  reason: string;
  retryAfterMs?: number;
}

const NEVER_RETRY: ReadonlySet<RecoveryFailureClass> = new Set(["policy_failure", "approval_failure", "integrity_failure", "fencing_violation"]);

/** Pure, fail-closed crash/retry decision logic. It performs no mutation. */
export function planRecovery(input: RecoveryInput): RecoveryPlan {
  if (input.validationPresent) {
    if (!input.validationPassed) return { decision: "terminal_failed", retryAllowed: false, reason: "independent validation failed" };
    if (!input.cleanupComplete || input.workspacePresent) return { decision: "cleanup_pending", retryAllowed: false, reason: "validated attempt still owns cleanup resources" };
    return { decision: "validation_pending", retryAllowed: false, reason: "validated evidence exists but terminal persistence requires reconciliation" };
  }
  if (input.processAlive && input.leaseActive && !input.leaseExpired) {
    return { decision: "resumable", retryAllowed: false, reason: "authoritative process and lease are still active" };
  }
  const failureClass = input.failureClass ?? "unknown";
  const retryAllowed = !NEVER_RETRY.has(failureClass) && input.attemptNumber < input.maxAttempts;
  if (retryAllowed) {
    return { decision: "retryable", retryAllowed: true, reason: `bounded retry allowed for ${failureClass}`, retryAfterMs: 1_000 * 2 ** Math.max(0, input.attemptNumber - 1) };
  }
  if (input.workspacePresent && (!input.leaseActive || input.leaseExpired)) {
    return { decision: "cleanup_pending", retryAllowed: false, reason: "stale or expired authority still has a workspace" };
  }
  return { decision: "terminal_failed", retryAllowed: false, reason: NEVER_RETRY.has(failureClass) ? `non-retryable failure class: ${failureClass}` : "maximum attempts exhausted or failure class unknown" };
}

export * from "./startup.js";
