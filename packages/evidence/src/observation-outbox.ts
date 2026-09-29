export {
  OBSERVATION_CLASSIFIER_VERSION,
  OBSERVATION_OUTBOX_MAX_ATTEMPTS,
  OBSERVATION_OUTBOX_MAX_CONCURRENT,
  OBSERVATION_OUTBOX_MAX_PROJECTION_EVENTS,
  OBSERVATION_OUTBOX_MAX_QUEUE,
  OBSERVATION_OUTBOX_TIMEOUT_MS,
  OBSERVATION_QUESTION_SET_VERSION,
  observationJobStatusSchema,
  observationOutboxEntrySchema,
  observationalIdentity,
  type CompleteObservationJobInput,
  type ObservationCapacity,
  type ObservationJobStatus,
  type ObservationOutboxEntry,
  type ObservationSkipReason
} from "@agent-control-stack/work-items";

export interface ObservationResult {
  observationId: string;
  workItemId: string;
  traceId: string;
  status: "completed" | "failed" | "degraded";
  classifierOutcome: string | null;
  attemptsUsed: number;
  durationMs: number;
  error: string | null;
}
