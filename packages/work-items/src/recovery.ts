import { z } from "zod";

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
export const recoveryDecisionSchema = z.enum(["resumable", "retryable", "validation_pending", "cleanup_pending", "terminal_failed"]);
export const recordRecoveryDecisionInputSchema = z.object({
  attemptId: id,
  workItemId: id,
  decision: recoveryDecisionSchema,
  retryAllowed: z.boolean(),
  reason: z.string().min(1).max(2_000),
  retryAfterMs: z.number().int().nonnegative().optional(),
  idempotencyKey: id,
  now: z.date().optional()
}).strict();
export const recoveryRecordSchema = z.object({
  recordId: id,
  attemptId: id,
  workItemId: id,
  decision: recoveryDecisionSchema,
  retryAllowed: z.boolean(),
  reason: z.string(),
  retryAfterMs: z.number().int().nonnegative().optional(),
  idempotencyKey: id,
  createdAt: z.string().datetime({ offset: true })
}).strict();
export type RecordRecoveryDecisionInput = z.infer<typeof recordRecoveryDecisionInputSchema>;
export type RecoveryRecord = z.infer<typeof recoveryRecordSchema>;
