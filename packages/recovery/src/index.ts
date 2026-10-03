export type RecoveryDecision = "resumable" | "retryable" | "validation_pending" | "cleanup_pending" | "terminal_failed";
export type RecoveryFailureClass =
  | "engine_timeout"
  | "process_gone"
  | "validation_failed"
  | "policy_failure"
  | "approval_failure"
  | "integrity_failure"
  | "fencing_violation"
  | "unknown";

export interface RecoveryInput {
  attemptNumber: number;
  maxAttempts: number;
  attemptStatus:
    "pending" | "leased" | "running" | "interrupted" | "succeeded" | "failed" | "cancelled" | "unknown" | "quarantined";
  processAlive: boolean;
  leaseActive: boolean;
  leaseExpired: boolean;
  workspacePresent: boolean;
  validationPresent: boolean;
  validationPassed: boolean;
  cleanupComplete: boolean;
  failureClass?: RecoveryFailureClass;
  /** Trusted custody evidence; process loss alone must never imply not_started. */
  executionDisposition?: "not_started" | "executed" | "unknown";
}

export interface RecoveryPlan {
  decision: RecoveryDecision;
  retryAllowed: boolean;
  reason: string;
  retryAfterMs?: number;
}

const NEVER_RETRY: ReadonlySet<RecoveryFailureClass> = new Set([
  "policy_failure",
  "approval_failure",
  "integrity_failure",
  "fencing_violation"
]);

/** Pure, fail-closed crash/retry decision logic. It performs no mutation. */
export function planRecovery(input: RecoveryInput): RecoveryPlan {
  if (input.validationPresent) {
    if (!input.validationPassed)
      return { decision: "terminal_failed", retryAllowed: false, reason: "independent validation failed" };
    if (!input.cleanupComplete || input.workspacePresent)
      return {
        decision: "cleanup_pending",
        retryAllowed: false,
        reason: "validated attempt still owns cleanup resources"
      };
    return {
      decision: "validation_pending",
      retryAllowed: false,
      reason: "validated evidence exists but terminal persistence requires reconciliation"
    };
  }
  if (
    input.processAlive &&
    input.leaseActive &&
    !input.leaseExpired &&
    ["leased", "running"].includes(input.attemptStatus) &&
    !NEVER_RETRY.has(input.failureClass ?? "unknown")
  ) {
    return { decision: "resumable", retryAllowed: false, reason: "authoritative process and lease are still active" };
  }
  const failureClass = input.failureClass ?? "unknown";
  if (NEVER_RETRY.has(failureClass) || ["cancelled", "quarantined"].includes(input.attemptStatus)) {
    return {
      decision: "terminal_failed",
      retryAllowed: false,
      reason: `non-retryable failure class or terminal state: ${failureClass}`
    };
  }
  if (input.leaseActive && !input.leaseExpired) {
    return {
      decision: "validation_pending",
      retryAllowed: false,
      reason: "live authority must be fenced before recovery"
    };
  }
  if (input.attemptStatus === "succeeded" || input.executionDisposition !== "not_started") {
    return {
      decision: "validation_pending",
      retryAllowed: false,
      reason: "execution outcome requires independent reconciliation; process loss is not non-execution evidence"
    };
  }
  if (input.processAlive || input.attemptStatus !== "pending") {
    return {
      decision: "validation_pending",
      retryAllowed: false,
      reason: "non-execution evidence conflicts with process or attempt state"
    };
  }
  if (input.workspacePresent || !input.cleanupComplete) {
    return {
      decision: "cleanup_pending",
      retryAllowed: false,
      reason: "confirmed unstarted attempt still owns cleanup resources"
    };
  }
  const retryAllowed =
    ["engine_timeout", "process_gone"].includes(failureClass) &&
    Number.isInteger(input.attemptNumber) &&
    input.attemptNumber > 0 &&
    Number.isInteger(input.maxAttempts) &&
    input.maxAttempts <= 64 &&
    input.attemptNumber < input.maxAttempts;
  if (retryAllowed) {
    return {
      decision: "retryable",
      retryAllowed: true,
      reason: `bounded retry allowed for confirmed non-execution (${failureClass})`,
      retryAfterMs: Math.min(60_000, 1_000 * 2 ** Math.max(0, input.attemptNumber - 1))
    };
  }
  return {
    decision: "terminal_failed",
    retryAllowed: false,
    reason: "maximum attempts exhausted or failure class unknown"
  };
}

export * from "./startup.js";
