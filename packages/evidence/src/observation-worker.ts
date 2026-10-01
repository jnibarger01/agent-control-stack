import {
  JEV_TRACE_QUESTION_SET_VERSION,
  classifyJevExecutionProgress,
  classifyJevTrace,
  formatJevTelemetry,
  type ExecutionProgressTelemetry,
  type JevTraceAdvisory
} from "@agent-control-stack/jev-advisor";
import type { CanonicalTraceEvent, ObservationOutboxEntry, ObservationStore } from "@agent-control-stack/work-items";
import {
  OBSERVATION_OUTBOX_MAX_CONCURRENT,
  OBSERVATION_OUTBOX_MAX_PROJECTION_EVENTS,
  OBSERVATION_OUTBOX_TIMEOUT_MS,
  type ObservationResult
} from "./observation-outbox.js";

export interface ObservationWorkerConfig {
  enabled: boolean;
  maxConcurrent: number;
  timeoutMs: number;
  maxProjectionEvents: number;
  pollIntervalMs: number;
}

export const DEFAULT_CONFIG: ObservationWorkerConfig = {
  enabled: true,
  maxConcurrent: OBSERVATION_OUTBOX_MAX_CONCURRENT,
  timeoutMs: OBSERVATION_OUTBOX_TIMEOUT_MS,
  maxProjectionEvents: OBSERVATION_OUTBOX_MAX_PROJECTION_EVENTS,
  pollIntervalMs: 1000
};

export interface TraceClassifierResult {
  outcome: string;
  degraded: boolean;
  retryable: boolean;
  telemetryCorrelationId: string | null;
}

export type TraceClassifier = (
  trace: readonly CanonicalTraceEvent[],
  timeoutMs: number,
  context?: { executionId: string; missionObjective?: string }
) => Promise<TraceClassifierResult>;

export interface ObservationWorkerState {
  running: boolean;
  concurrent: number;
  processed: number;
  completed: number;
  failed: number;
  degraded: number;
  retried: number;
  lastPollAt: string | null;
}

export interface ObservationWorkerCapacity {
  queued: number;
  storeRunning: number;
  maxQueued: number;
  concurrent: number;
  maxConcurrent: number;
  saturated: boolean;
}

export interface ObservationWorkerOptions {
  classifier?: TraceClassifier;
  telemetrySink?: (line: string) => void;
  config?: Partial<ObservationWorkerConfig>;
}

const TERMINAL_KINDS = new Set([
  "run.failed",
  "run.completed",
  "promotion.blocked",
  "promotion.completed",
  "replay.diverged"
]);

export class ObservationWorker {
  private readonly store: ObservationStore;
  private readonly config: ObservationWorkerConfig;
  private readonly classifier: TraceClassifier;
  private readonly telemetrySink: (line: string) => void;
  private readonly state: ObservationWorkerState;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private shutdownRequested = false;
  private polling = false;

  constructor(store: ObservationStore, options: ObservationWorkerOptions = {}) {
    this.store = store;
    this.config = { ...DEFAULT_CONFIG, ...options.config };
    validateConfig(this.config);
    this.telemetrySink = options.telemetrySink ?? ((line) => process.stderr.write(line + "\n"));
    this.classifier = options.classifier ?? ((trace, timeoutMs, context) => this.classify(trace, timeoutMs, context));
    this.state = {
      running: false,
      concurrent: 0,
      processed: 0,
      completed: 0,
      failed: 0,
      degraded: 0,
      retried: 0,
      lastPollAt: null
    };
  }

  getState(): Readonly<ObservationWorkerState> {
    return { ...this.state };
  }

  getConfig(): Readonly<ObservationWorkerConfig> {
    return { ...this.config };
  }

  getCapacity(): ObservationWorkerCapacity {
    const capacity = this.store.getObservationCapacity();
    return {
      queued: capacity.queued,
      storeRunning: capacity.running,
      maxQueued: capacity.maxQueued,
      concurrent: this.state.concurrent,
      maxConcurrent: this.config.maxConcurrent,
      saturated: capacity.saturated || this.state.concurrent >= this.config.maxConcurrent
    };
  }

  start(): void {
    if (this.state.running || !this.config.enabled) return;
    this.shutdownRequested = false;
    this.state.running = true;
    void this.poll();
    this.pollTimer = setInterval(() => void this.poll(), this.config.pollIntervalMs);
  }

  async stop(): Promise<void> {
    this.shutdownRequested = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    const deadline = Date.now() + this.config.timeoutMs;
    while (this.state.concurrent > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    this.state.running = false;
  }

  async runOnce(): Promise<number> {
    const before = this.state.processed;
    await this.poll();
    while (this.state.concurrent > 0) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return this.state.processed - before;
  }

  private async poll(): Promise<void> {
    if (this.shutdownRequested || this.polling || !this.config.enabled) return;
    this.polling = true;
    this.state.lastPollAt = new Date().toISOString();
    try {
      while (!this.shutdownRequested && this.state.concurrent < this.config.maxConcurrent) {
        const job = this.store.claimNextObservation();
        if (!job) break;
        this.state.concurrent += 1;
        this.state.processed += 1;
        void this.processJob(job).finally(() => {
          this.state.concurrent = Math.max(0, this.state.concurrent - 1);
          if (!this.shutdownRequested) void this.poll();
        });
      }
    } finally {
      this.polling = false;
    }
  }

  private async processJob(job: ObservationOutboxEntry): Promise<void> {
    const startedAt = Date.now();
    try {
      const trace = this.store.loadCanonicalTrace(job.workItemId, job.traceId, this.config.maxProjectionEvents);
      if (trace.length === 0) {
        this.finishDegraded(job, "trace_unavailable", startedAt);
        return;
      }
      if (!trace.some((event) => TERMINAL_KINDS.has(event.kind))) {
        this.finishDegraded(job, "trace_incomplete", startedAt);
        return;
      }

      const result = await this.classifier(trace, this.config.timeoutMs, {
        executionId: job.workItemId,
        missionObjective: this.store.loadMissionObjective?.(job.workItemId)
      });
      if (result.retryable) {
        const retryStatus = this.store.retryObservation(job.observationId, result.outcome);
        if (retryStatus === "pending") this.state.retried += 1;
        else this.state.failed += 1;
        return;
      }

      const status = result.degraded ? "degraded" : "completed";
      this.store.completeObservation(job.observationId, {
        status,
        classifierOutcome: result.outcome,
        telemetryCorrelationId: result.telemetryCorrelationId,
        error: result.degraded ? result.outcome : null
      });
      if (status === "completed") this.state.completed += 1;
      else this.state.degraded += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : "observer_error";
      const retryStatus = this.store.retryObservation(job.observationId, message);
      if (retryStatus === "pending") this.state.retried += 1;
      else this.state.failed += 1;
    }
  }

  private finishDegraded(job: ObservationOutboxEntry, reason: string, startedAt: number): ObservationResult {
    const result: ObservationResult = {
      observationId: job.observationId,
      workItemId: job.workItemId,
      traceId: job.traceId,
      status: "degraded",
      classifierOutcome: null,
      telemetryCorrelationId: null,
      attemptsUsed: job.attempts,
      durationMs: Math.max(0, Date.now() - startedAt),
      error: reason
    };
    this.store.completeObservation(job.observationId, {
      status: "degraded",
      classifierOutcome: null,
      telemetryCorrelationId: null,
      error: reason
    });
    this.state.degraded += 1;
    return result;
  }

  private async classify(
    trace: readonly CanonicalTraceEvent[],
    timeoutMs: number,
    context?: { executionId: string; missionObjective?: string }
  ): Promise<TraceClassifierResult> {
    const advisory = await classifyJevTrace(trace, { timeoutMs, enabled: true });
    this.emitTelemetry(advisory);
    if (context?.missionObjective) {
      try {
        const progress = await classifyJevExecutionProgress(
          {
            executionId: context.executionId,
            mission: { objective: context.missionObjective },
            events: trace,
            triggeringBoundary: trace.at(-1)?.kind
          },
          { timeoutMs, enabled: true }
        );
        this.emitProgressTelemetry(progress.telemetry);
      } catch {
        this.emitProgressTelemetry({
          schema_version: "jev-execution-progress-event/1",
          execution_id: context.executionId,
          assessment_timestamp: new Date().toISOString(),
          trajectory_window_size: Math.min(trace.length, 32),
          triggering_event: trace.at(-1)?.kind ?? "unknown",
          progress: "unknown",
          trajectory: "unknown",
          intervention_recommended: null,
          risk_escalation: null,
          completion_confidence: null,
          evidence: [],
          deterministic_signals: { repeated_failed_invocation_count: 0 },
          degraded: true,
          error: "OBSERVER_ERROR",
          latency_ms: 0,
          model: null,
          question_set_version: "jev-execution-progress@1",
          trace_id: trace[0]?.trace_id ?? null,
          work_item_id: context.executionId
        });
      }
    }
    const failure = advisory.result.failureReason;
    return {
      outcome: failure ?? "OK",
      degraded: advisory.result.degraded,
      retryable: failure === "TIMEOUT" || failure === "UNAVAILABLE",
      telemetryCorrelationId: null
    };
  }

  private emitProgressTelemetry(event: ExecutionProgressTelemetry): void {
    try {
      this.telemetrySink(JSON.stringify(event));
    } catch {
      // Progress telemetry is observational only.
    }
  }

  private emitTelemetry(advisory: JevTraceAdvisory): void {
    try {
      this.telemetrySink(formatJevTelemetry(advisory.telemetry));
    } catch {
      // Telemetry is observational only.
    }
  }
}

function validateConfig(config: ObservationWorkerConfig): void {
  if (!Number.isSafeInteger(config.maxConcurrent) || config.maxConcurrent < 1 || config.maxConcurrent > 64) {
    throw new TypeError("invalid observation concurrency");
  }
  if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 300_000) {
    throw new TypeError("invalid observation timeout");
  }
  if (
    !Number.isSafeInteger(config.maxProjectionEvents) ||
    config.maxProjectionEvents < 1 ||
    config.maxProjectionEvents > OBSERVATION_OUTBOX_MAX_PROJECTION_EVENTS
  ) {
    throw new TypeError("invalid observation projection bound");
  }
  if (!Number.isSafeInteger(config.pollIntervalMs) || config.pollIntervalMs < 10 || config.pollIntervalMs > 60_000) {
    throw new TypeError("invalid observation poll interval");
  }
}

export { JEV_TRACE_QUESTION_SET_VERSION };
