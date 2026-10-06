/**
 * Route shadow port (ADR 0025, shadow stage).
 *
 * A shadow observer sees the same eligible candidate set the authoritative router saw, after the decision is
 * persisted, and reports what it would have recommended. This module is plain data: it imports nothing from
 * Jev, and decideAuthoritativeRoute never reads an observer's result back. The observer runs off the decision
 * path, bounded by a timeout, and every failure is recorded rather than thrown.
 */
import type { RecordRouteShadowObservationInput } from "@agent-control-stack/work-items";

export interface RouteShadowCandidate {
  id: string;
  role?: string;
  kind?: string;
  capabilities: string[];
}

export interface RouteShadowInput {
  decisionId: string;
  workItemId: string;
  missionId?: string;
  operationType: string;
  requiredCapabilities: string[];
  lane?: "jc" | "dc";
  /** The authoritative decision, already persisted. Observers must not be able to change it. */
  authoritative: Readonly<{ executorId: string; source: "nimble" | "deterministic_fallback" }>;
  candidates: readonly Readonly<RouteShadowCandidate>[];
  signal: AbortSignal;
}

export type RouteShadowReport = Omit<RecordRouteShadowObservationInput, "decisionId" | "now">;

export type RouteShadowObserver = (input: RouteShadowInput) => Promise<RouteShadowReport>;

export interface RouteShadowRecorder {
  recordRouteShadowObservation(input: RecordRouteShadowObservationInput, options: { via: "domain_service" }): unknown;
}

export interface RouteShadowOptions {
  observer: RouteShadowObserver;
  recorder: RouteShadowRecorder;
  /** Default 1500ms. A timeout is recorded as `timeout`. */
  timeoutMs?: number;
  /**
   * Receives the in-flight shadow promise so a process can drain it on shutdown and tests can await it.
   * The promise never rejects. The decision never awaits it.
   */
  track?: (settled: Promise<void>) => void;
}

export const DEFAULT_ROUTE_SHADOW_TIMEOUT_MS = 1500;

export function startRouteShadow(options: RouteShadowOptions, input: Omit<RouteShadowInput, "signal">): void {
  const settled = runRouteShadow(options, input);
  try {
    options.track?.(settled);
  } catch {
    // A tracker is never part of the routing path.
  }
}

async function runRouteShadow(options: RouteShadowOptions, input: Omit<RouteShadowInput, "signal">): Promise<void> {
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_ROUTE_SHADOW_TIMEOUT_MS;
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let report: RouteShadowReport;
  try {
    const timeout = new Promise<RouteShadowReport>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ status: "timeout", failureReason: "shadow_timeout" });
      }, timeoutMs);
    });
    // Snapshot-and-freeze what the observer sees so it cannot mutate the routing context.
    const frozen = Object.freeze({
      ...input,
      candidates: Object.freeze(input.candidates.map((candidate) => Object.freeze({ ...candidate }))),
      authoritative: Object.freeze({ ...input.authoritative }),
      signal: controller.signal
    });
    report = await Promise.race([Promise.resolve().then(() => options.observer(frozen)), timeout]);
  } catch {
    report = { status: "error", failureReason: "observer_threw" };
  } finally {
    if (timer) clearTimeout(timer);
  }
  try {
    options.recorder.recordRouteShadowObservation(
      { ...report, latencyMs: report.latencyMs ?? Math.max(0, Date.now() - startedAt), decisionId: input.decisionId },
      { via: "domain_service" }
    );
  } catch {
    // Recording is best effort. A failed shadow write never affects the persisted route.
  }
}
