/**
 * Jev shadow-mode telemetry. Events are log-only advisory data: they carry
 * probabilities and no state text, secrets, or authority-bearing fields.
 */

import type { JevResult } from "./index.js";

export const JEV_CLASSIFIER_VERSION = "jev-routing-v1" as const;

export type JevTelemetryEvent = {
  classifier: typeof JEV_CLASSIFIER_VERSION;
  consumer: string;
  latency_ms: number;
  signals: Record<string, number>;
  degraded?: true;
  route_before_jev: string | null;
  route_selected: string | null;
  actual_outcome: string | null;
};

export type JevTelemetryInput = {
  /** Jev result to summarize. Probabilities only; state text is never included. */
  result: JevResult;
  /** Consumer identifier supplied by the caller, e.g. "mission-router". */
  consumer: string;
  routeBeforeJev?: string | null;
  routeSelected?: string | null;
  actualOutcome?: string | null;
};

export function buildJevTelemetryEvent(input: JevTelemetryInput): JevTelemetryEvent {
  const { result, consumer } = input;
  const signals: Record<string, number> = {};
  if (!result.degraded) {
    for (const [name, signal] of Object.entries(result.signals)) {
      signals[name] = signal.probability;
    }
  }
  const event: JevTelemetryEvent = {
    classifier: JEV_CLASSIFIER_VERSION,
    consumer,
    latency_ms: result.latencyMs,
    signals,
    route_before_jev: input.routeBeforeJev ?? null,
    route_selected: input.routeSelected ?? null,
    actual_outcome: input.actualOutcome ?? null
  };
  if (result.degraded) event.degraded = true;
  return event;
}

/** JSON one-liner for the log path. */
export function formatJevTelemetry(event: JevTelemetryEvent): string {
  return JSON.stringify(event);
}
