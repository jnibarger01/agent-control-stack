import { ControlStackError } from "@agent-control-stack/shared";

/**
 * How many times a work unit's stale claim may be recovered, and how long to wait between recoveries.
 * Recovery follows confirmed non-execution only; this policy bounds how often that is allowed to repeat.
 */
export interface RecoveryPolicy {
  /** Recoveries allowed per unit. The next stale claim after this many stops the unit as poison work. */
  maxRecoveries: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
}

export const DEFAULT_RECOVERY_POLICY: RecoveryPolicy = {
  maxRecoveries: 3,
  baseBackoffMs: 2_000,
  maxBackoffMs: 60_000
};

/** Hard ceilings so a misconfiguration cannot turn recovery back into an unbounded loop. */
export const RECOVERY_POLICY_LIMITS = { maxRecoveries: 10, maxBackoffMs: 3_600_000 } as const;

export function resolveRecoveryPolicy(partial: Partial<RecoveryPolicy> | undefined): RecoveryPolicy {
  const policy = { ...DEFAULT_RECOVERY_POLICY, ...partial };
  const ok =
    Number.isInteger(policy.maxRecoveries) &&
    policy.maxRecoveries >= 0 &&
    policy.maxRecoveries <= RECOVERY_POLICY_LIMITS.maxRecoveries &&
    Number.isInteger(policy.baseBackoffMs) &&
    policy.baseBackoffMs >= 0 &&
    Number.isInteger(policy.maxBackoffMs) &&
    policy.maxBackoffMs >= policy.baseBackoffMs &&
    policy.maxBackoffMs <= RECOVERY_POLICY_LIMITS.maxBackoffMs;
  if (!ok) throw new ControlStackError("recovery_policy_invalid", "recovery policy is out of bounds");
  return policy;
}

/** Exponential backoff for the n-th recovery of a unit (1-based), capped. */
export function recoveryBackoffMs(sequence: number, policy: RecoveryPolicy): number {
  const exponent = Math.min(Math.max(sequence - 1, 0), 30);
  return Math.min(policy.maxBackoffMs, policy.baseBackoffMs * 2 ** exponent);
}

export type RecoveryOutcome = "rescheduled" | "poisoned";

export interface RecoveryDecision {
  outcome: RecoveryOutcome;
  /** 1-based count of recoveries of this unit, including this one. */
  sequence: number;
  /** ISO instant before which the unit will not be claimed again. Absent when poisoned. */
  retryNotBefore?: string;
  /** True when this call returned an earlier decision for the same released claim and changed nothing. */
  replayed: boolean;
}

export interface WorkUnitEscalation {
  escalationId: number;
  missionId: string;
  unitId: string;
  kind: "poison_work" | "recovery_unsafe";
  detail: unknown;
  createdAt: string;
}
