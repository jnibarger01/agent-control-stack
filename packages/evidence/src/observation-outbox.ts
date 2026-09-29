import { z } from "zod";
export {
  observationalIdentity,
  OBSERVATION_OUTBOX_MAX_ATTEMPTS,
  OBSERVATION_OUTBOX_MAX_PROJECTION_EVENTS,
  OBSERVATION_OUTBOX_MAX_QUEUE
} from "@agent-control-stack/work-items";
export type {
  ObservationCapacity,
  ObservationCompletion,
  ObservationJobStatus,
  ObservationOutboxEntry,
  ObservationStore
} from "@agent-control-stack/work-items";

export const OBSERVATION_OUTBOX_MAX_CONCURRENT = 5;
export const OBSERVATION_OUTBOX_TIMEOUT_MS = 30_000;

export const observationJobStatusSchema = z.enum(["pending", "running", "completed", "failed", "degraded"]);

export interface ObservationResult {
  observationId: string;
  workItemId: string;
  traceId: string;
  status: "completed" | "failed" | "degraded";
  classifierOutcome: string | null;
  telemetryCorrelationId: string | null;
  attemptsUsed: number;
  durationMs: number;
  error: string | null;
}

export interface ObservationSkipReason {
  reason: "queue_saturated" | "trace_unavailable" | "trace_incomplete" | "trace_malformed";
  workItemId: string;
  traceId: string;
  observedAt: string;
}
