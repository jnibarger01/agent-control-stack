import { z } from "zod";

const identifierSchema = z.string().min(1).max(128);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const timestampSchema = z.string().datetime({ offset: true }).max(64);

export const schedulerFiringStatusSchema = z.enum(["claimed", "completed", "failed"]);

export const schedulerFiringSchema = z
  .object({
    firingId: identifierSchema,
    scheduleId: identifierSchema,
    scheduledFiringTime: timestampSchema,
    idempotencyKey: hashSchema,
    status: schedulerFiringStatusSchema,
    workItemId: identifierSchema.optional(),
    claimedAt: timestampSchema,
    completedAt: timestampSchema.optional()
  })
  .strict();

export const claimSchedulerFiringInputSchema = z
  .object({
    scheduleId: identifierSchema,
    scheduledFiringTime: z.date(),
    idempotencyKey: hashSchema,
    /** A 'claimed' firing older than this is treated as abandoned by whatever process claimed it and may be reclaimed. */
    staleClaimMs: z
      .number()
      .int()
      .positive()
      .max(60 * 60 * 1_000)
      .optional(),
    now: z.date().optional()
  })
  .strict();

export type SchedulerFiringStatus = z.infer<typeof schedulerFiringStatusSchema>;
export type SchedulerFiring = z.infer<typeof schedulerFiringSchema>;
export type ClaimSchedulerFiringInput = z.infer<typeof claimSchedulerFiringInputSchema>;

/**
 * What claimSchedulerFiring hands back to the caller so it knows whether to
 * do any work at all - see packages/work-items's store implementation for
 * the transactional claim/reclaim logic this describes.
 */
export interface SchedulerFiringClaim {
  firing: SchedulerFiring;
  /** True only when this call is the one that should now create the work item (a fresh claim or a reclaim of an abandoned one). */
  owned: boolean;
}
