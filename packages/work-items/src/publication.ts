import { z } from "zod";
const id = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u);
export const publicationRecordSchema = z
  .object({
    publicationId: id,
    workItemId: id,
    attemptId: id,
    branch: z.string().min(1).max(256),
    commitSha: z.string().min(7).max(128),
    pullRequestUrl: z.string().url(),
    idempotencyKey: id,
    createdAt: z.string().datetime({ offset: true })
  })
  .strict();
export const recordPublicationInputSchema = publicationRecordSchema
  .omit({ publicationId: true, createdAt: true })
  .extend({ now: z.date().optional() })
  .strict();
export type PublicationRecord = z.infer<typeof publicationRecordSchema>;
export type RecordPublicationInput = z.infer<typeof recordPublicationInputSchema>;

export const publicationBlockStageSchema = z.enum([
  "validation",
  "lease_entry",
  "plan_authorization",
  "branch_binding",
  "workspace_branch",
  "workspace_staging",
  "commit",
  "lease_pre_push",
  "push",
  "lease_post_push",
  "pull_request",
  "lease_post_pr",
  "record",
  "unknown"
]);
export const publicationBlockExternalStateSchema = z.enum(["none", "branch_pushed", "pull_request_created", "unknown"]);
export const recordPublicationBlockedInputSchema = z
  .object({
    workItemId: id,
    attemptId: id,
    stage: publicationBlockStageSchema,
    reasonCode: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-z0-9][a-z0-9._-]*$/u),
    externalState: publicationBlockExternalStateSchema,
    now: z.date().optional()
  })
  .strict();
export type PublicationBlockStage = z.infer<typeof publicationBlockStageSchema>;
export type PublicationBlockExternalState = z.infer<typeof publicationBlockExternalStateSchema>;
export type RecordPublicationBlockedInput = z.infer<typeof recordPublicationBlockedInputSchema>;
export interface PublicationBlockedRecord extends Omit<RecordPublicationBlockedInput, "now"> {
  recordedAt: string;
}
