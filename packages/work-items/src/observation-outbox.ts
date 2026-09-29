import { createHash } from "node:crypto";
import { z } from "zod";

export const OBSERVATION_OUTBOX_MAX_QUEUE = 1000;
export const OBSERVATION_OUTBOX_MAX_CONCURRENT = 5;
export const OBSERVATION_OUTBOX_MAX_ATTEMPTS = 3;
export const OBSERVATION_OUTBOX_TIMEOUT_MS = 30_000;
export const OBSERVATION_OUTBOX_MAX_PROJECTION_EVENTS = 1000;
export const OBSERVATION_QUESTION_SET_VERSION = "jev-trace@1" as const;
export const OBSERVATION_CLASSIFIER_VERSION = "jev-advisory-v2" as const;

export const observationJobStatusSchema = z.enum(["pending", "running", "completed", "failed", "degraded"]);
export type ObservationJobStatus = z.infer<typeof observationJobStatusSchema>;

export const observationOutboxEntrySchema = z.object({
  observationId: z.string().min(1),
  workItemId: z.string().min(1),
  traceId: z.string().regex(/^[a-f0-9]{32}$/),
  questionSetVersion: z.string().min(1),
  classifierVersion: z.string().min(1),
  attempts: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  status: observationJobStatusSchema,
  createdAt: z.string().datetime({ offset: true }),
  startedAt: z.string().datetime({ offset: true }).nullable(),
  completedAt: z.string().datetime({ offset: true }).nullable(),
  classifierOutcome: z.string().nullable(),
  error: z.string().nullable()
});
export type ObservationOutboxEntry = z.infer<typeof observationOutboxEntrySchema>;

export interface ObservationCapacity {
  queued: number;
  running: number;
  maxQueued: number;
  saturated: boolean;
}

export interface CompleteObservationJobInput {
  observationId: string;
  status: "completed" | "degraded";
  classifierOutcome: string | null;
  error: string | null;
  now?: Date;
}

export interface ObservationSkipReason {
  reason: "queue_saturated" | "trace_unavailable" | "trace_enqueue_failed" | "observation_enqueue_failed";
  workItemId: string;
  traceId: string | null;
  observedAt: string;
  message?: string;
}

export function observationalIdentity(params: {
  traceId: string;
  questionSetVersion: string;
  classifierVersion: string;
}): string {
  const raw = `${params.traceId}::${params.questionSetVersion}::${params.classifierVersion}`;
  return `obs_${createHash("sha256").update(raw).digest("hex").slice(0, 24)}`;
}
