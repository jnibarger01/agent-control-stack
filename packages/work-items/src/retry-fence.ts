import { ControlStackError } from "@agent-control-stack/shared";
import { z } from "zod";

/**
 * Retry fence: the rule that decides when an execution's side effects may be retried or replaced.
 *
 * An attempt HOLDS the fence while it is live (`running`, `leased`, `cancellation_requested`) or
 * uncertain (`unknown`, `quarantined`) and has no verified cleanup evidence row. A held fence refuses:
 * - a replacement attempt on the same work item (`createAttempt`, so every claim path);
 * - a retry of the work item (`retryWorkItem`).
 * The fence is derived from durable rows. It needs no stored flag, so it survives restart, and a
 * missing or unrecorded scope leaves it held.
 *
 * Failed, cancelled and succeeded outcomes do not hold the fence. Those outcomes carry an accepted
 * result, and their replay is governed by the existing retry lineage rules.
 */

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const timestampSchema = z.string().datetime({ offset: true }).max(64);

export const LIVE_ATTEMPT_STATUSES = ["running", "leased", "cancellation_requested"] as const;
export const UNCERTAIN_ATTEMPT_STATUSES = ["unknown", "quarantined"] as const;
export const FENCE_HOLDING_ATTEMPT_STATUSES = [...LIVE_ATTEMPT_STATUSES, ...UNCERTAIN_ATTEMPT_STATUSES] as const;

/** Records the execution unit ACS observed for an attempt, bound to its current lease and epoch. */
export const recordExecutionScopeInputSchema = z
  .object({
    attemptId: identifier,
    workItemId: identifier,
    leaseId: identifier,
    fencingEpoch: z.number().int().positive(),
    unitName: z.string().min(1).max(256),
    now: z.date().optional()
  })
  .strict();

/** Verified cleanup of that unit. Only the `verified` verdict is storable. */
export const recordVerifiedCleanupInputSchema = z
  .object({
    attemptId: identifier,
    workItemId: identifier,
    leaseId: identifier,
    fencingEpoch: z.number().int().positive(),
    unitName: z.string().min(1).max(256),
    verdict: z.literal("verified"),
    evidenceHash: hashSchema,
    effectsDisposition: z.enum(["no_external_effects", "reconciled"]),
    effectsEvidenceHash: hashSchema,
    observedAt: timestampSchema,
    now: z.date().optional()
  })
  .strict();

export type RecordExecutionScopeInput = z.input<typeof recordExecutionScopeInputSchema>;
export type RecordVerifiedCleanupInput = z.input<typeof recordVerifiedCleanupInputSchema>;

export interface AttemptExecutionScope {
  attemptId: string;
  workItemId: string;
  leaseId: string;
  fencingEpoch: number;
  unitName: string;
  recordedAt: string;
}

export interface AttemptCleanupEvidence {
  attemptId: string;
  workItemId: string;
  leaseId: string;
  fencingEpoch: number;
  unitName: string;
  verdict: "verified";
  evidenceHash: string;
  effectsDisposition: "no_external_effects" | "reconciled";
  effectsEvidenceHash: string;
  observedAt: string;
  recordedAt: string;
}

/**
 * SQL that finds one attempt of a work item that holds the fence. The `NOT EXISTS` clause is the
 * release: verified cleanup evidence for the attempt releases it.
 */
export const UNPROVEN_EXECUTION_SQL = `
  SELECT attempt.attempt_id AS attemptId
  FROM execution_attempts AS attempt
  WHERE attempt.work_item_id = ?
    AND attempt.status IN (${FENCE_HOLDING_ATTEMPT_STATUSES.map(() => "?").join(", ")})
    AND NOT EXISTS (
      SELECT 1 FROM attempt_cleanup_evidence AS evidence WHERE evidence.attempt_id = attempt.attempt_id
    )
  LIMIT 1`;

export type RetryFenceMode = "off" | "enforce";

/** ACS_RETRY_FENCE: unset, empty or "off" is off; "enforce" enforces; anything else is refused, never guessed. */
export function retryFenceModeFromEnvironment(env: NodeJS.ProcessEnv = process.env): RetryFenceMode {
  const value = env.ACS_RETRY_FENCE?.trim() ?? "";
  if (value === "" || value === "off") return "off";
  if (value === "enforce") return "enforce";
  throw new ControlStackError("invalid_configuration", "ACS_RETRY_FENCE must be off or enforce");
}

export function unprovenExecutionError(attemptId: string): ControlStackError {
  return new ControlStackError(
    "execution_fence_held",
    `attempt ${attemptId} has unproven execution; replacement attempts and retries are refused until verified cleanup is recorded for it`
  );
}

export function retryInFlightError(sourceWorkItemId: string): ControlStackError {
  return new ControlStackError(
    "retry_already_in_flight",
    `a retry of ${sourceWorkItemId} is still in flight; only one retry may be in flight at a time`
  );
}
