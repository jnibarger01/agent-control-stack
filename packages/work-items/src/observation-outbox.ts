import { createHash } from "node:crypto";
import type { CanonicalTraceEvent } from "./trace-event.js";

export const OBSERVATION_OUTBOX_MAX_QUEUE = 1000;
export const OBSERVATION_OUTBOX_MAX_ATTEMPTS = 3;
export const OBSERVATION_OUTBOX_MAX_PROJECTION_EVENTS = 1000;

export type ObservationJobStatus = "pending" | "running" | "completed" | "failed" | "degraded";

export interface ObservationOutboxEntry {
  observationId: string;
  workItemId: string;
  traceId: string;
  questionSetVersion: string;
  classifierVersion: string;
  attempts: number;
  maxAttempts: number;
  status: ObservationJobStatus;
  createdAt: string;
  availableAt: string;
  startedAt: string | null;
  completedAt: string | null;
  classifierOutcome: string | null;
  telemetryCorrelationId: string | null;
  error: string | null;
}

export interface ObservationCapacity {
  queued: number;
  running: number;
  maxQueued: number;
  saturated: boolean;
}

export interface ObservationCompletion {
  status: "completed" | "failed" | "degraded";
  classifierOutcome: string | null;
  telemetryCorrelationId: string | null;
  error: string | null;
}

export interface ObservationStore {
  claimNextObservation(now?: Date): ObservationOutboxEntry | undefined;
  loadCanonicalTrace(workItemId: string, traceId: string, maxEvents?: number): CanonicalTraceEvent[];
  /** Optional read-only mission context for semantic execution observation. */
  loadMissionObjective?(workItemId: string): string | undefined;
  completeObservation(observationId: string, completion: ObservationCompletion, now?: Date): void;
  retryObservation(observationId: string, error: string, now?: Date): "pending" | "failed";
  getObservationCapacity(): ObservationCapacity;
}

export function observationalIdentity(input: {
  traceId: string;
  questionSetVersion: string;
  classifierVersion: string;
}): string {
  const digest = createHash("sha256")
    .update(input.traceId)
    .update("\0")
    .update(input.questionSetVersion)
    .update("\0")
    .update(input.classifierVersion)
    .digest("hex");
  return "obs_" + digest.slice(0, 24);
}
