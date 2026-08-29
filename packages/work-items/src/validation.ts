import { z } from "zod";

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
export const validationCheckSchema = z.object({
  checkId: id,
  runId: id,
  name: z.string().min(1).max(256),
  passed: z.boolean(),
  detail: z.string().max(64_000),
  stdout: z.string().max(1_000_000).optional(),
  stderr: z.string().max(1_000_000).optional()
}).strict();
export const validationRunSchema = z.object({
  runId: id,
  attemptId: id,
  workItemId: id,
  passed: z.boolean(),
  idempotencyKey: id,
  createdAt: z.string().datetime({ offset: true }),
  checks: z.array(validationCheckSchema)
}).strict();
export const recordValidationRunInputSchema = validationRunSchema.omit({ runId: true, createdAt: true, checks: true }).extend({
  checks: z.array(validationCheckSchema.omit({ checkId: true, runId: true })),
  now: z.date().optional()
}).strict();
export type ValidationCheckRecord = z.infer<typeof validationCheckSchema>;
export type ValidationRun = z.infer<typeof validationRunSchema>;
export type RecordValidationRunInput = z.infer<typeof recordValidationRunInputSchema>;
