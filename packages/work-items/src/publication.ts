import { z } from "zod";
const id = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u);
export const publicationRecordSchema = z.object({
  publicationId: id,
  workItemId: id,
  attemptId: id,
  branch: z.string().min(1).max(256),
  commitSha: z.string().min(7).max(128),
  pullRequestUrl: z.string().url(),
  idempotencyKey: id,
  createdAt: z.string().datetime({ offset: true })
}).strict();
export const recordPublicationInputSchema = publicationRecordSchema.omit({ publicationId: true, createdAt: true }).extend({ now: z.date().optional() }).strict();
export type PublicationRecord = z.infer<typeof publicationRecordSchema>;
export type RecordPublicationInput = z.infer<typeof recordPublicationInputSchema>;
