import {
  JEV_CLASSIFIER_VERSION,
  JEV_TRACE_QUESTION_SET_VERSION,
  runJevTraceShadow,
  type JevTraceAdvisory
} from "@agent-control-stack/jev-advisor";
import type {
  CanonicalTraceEvent,
  CompleteObservationJobInput,
  ObservationCapacity,
  ObservationOutboxEntry
} from "@agent-control-stack/work-items";
import {
  OBSERVATION_OUTBOX_MAX_CONCURRENT,
  OBSERVATION_OUTBOX_MAX_PROJECTION_EVENTS,
  OBSERVATION_OUTBOX_TIMEOUT_MS
} from "./observation-outbox.js";

const TERMINAL_TRACE_KINDS = new Set([
  "run.failed",
  "run.completed",
  "promotion.blocked",
  "promotion.completed",
  "replay.diverged"
]);

export interface ObservationWorkerStore {
  claimNextObservationJob(now?: Date, maxRunning?: number): ObservationOutboxEntry | undefined;
  retryObservationJob(observationId: string, error: string, now?: Date): ObservationOutboxEntry;
  completeObservationJob(input: CompleteObservationJobInput): ObservationOutboxEntry;
  recoverStaleObservationJobs(staleBefore: Date, now?: Date): number;
  getObservationCapacity(): ObservationCapacity;
  readCanonicalTraceEvents(workItemId: string, traceId: string, maxEvents: number): CanonicalTraceEvent[];
}

export interface ObservationClassifierOptions {
  timeoutMs: number;
  signal: AbortSignal;
  sink: (line: string) => void;
}

export type TraceClassifier = (
  trace: readonly CanonicalTraceEvent[],
  options: ObservationClassifierOptions
) => Promise<JevTraceAdvisory | null>;

export interface ObservationWorkerConfig {
  enabled: boolean;
  maxConcurrent: number;
  timeoutMs: number;
  maxProjectionEvents: number;
  pollIntervalMs: number;
  staleJobMs: number;
}

export const DEFAULT_CONFIG: ObservationWorkerConfig = {
  enabled: true,
  maxConcurrent: OBSERVATION_OUTBOX_MAX_CONCURRENT,
  timeoutMs: OBSERVATION_OUTBOX_TIMEOUT_MS,
  maxProjectionEvents: OBSERVATION_OUTBOX_MAX_PROJECTION_EVENTS,
  pollIntervalMs: 1000,
  staleJobMs: OBSERVATION_OUTBOX_TIMEOUT_MS * 2
};

export interface ObservationWorkerState {
  running: boolean;
  concurrent: number;
  processed: number;
  completed: number;
  failed: number;
  degraded: number;
  retried: number;
  skipped: number;
  lastPollAt: string | null;
}

export interface ObservationWorkerCapacity extends ObservationCapacity {
  concurrent: number;
  maxConcurrent: number;
}

export interface ObservationWorkerOptions {
  config?: Partial<ObservationWorkerConfig>;
  classifier?: TraceClassifier;
  telemetrySink?: (line: string) => void;
  now?: () => Date;
}

export class ObservationWorker {
  private readonly config: ObservationWorkerConfig;
  private readonly classifier: TraceClassifier;
  private readonly telemetrySink: (line: string) => void;
  private readonly now: () => Date;
  private readonly inFlight = new Set<Promise<void>>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private shutdownRequested = false;
  private pollActive = false;
  private state: ObservationWorkerState = {
    running: false,
    concurrent: 0,
    processed: 0,
    completed: 0,
    failed: 0,
    degraded: 0,
    retried: 0,
    skipped: 0,
    lastPollAt: null
  };

  constructor(
    private readonly store: ObservationWorkerStore,
    options: ObservationWorkerOptions = {}
  ) {
    this.config = validateConfig({ ...DEFAULT_CONFIG, ...options.config });
    this.classifier = options.classifier ?? defaultTraceClassifier;
    this.telemetrySink = options.telemetrySink ?? ((line) => process.stderr.write(line + "\n"));
    this.now = options.now ?? (() => new Date());
  }

  getState(): Readonly<ObservationWorkerState> {
    return { ...this.state };
  }

  getConfig(): Readonly<ObservationWorkerConfig> {
    return { ...this.config };
  }

  getCapacity(): ObservationWorkerCapacity {
    const persisted = this.store.getObservationCapacity();
    return {
      ...persisted,
      concurrent: this.state.concurrent,
      maxConcurrent: this.config.maxConcurrent,
      saturated: persisted.saturated || this.state.concurrent >= this.config.maxConcurrent
    };
  }

  start(): void {
    if (this.state.running) return;
    this.shutdownRequested = false;
    this.state.running = true;
    if (!this.config.enabled) return;
    const now = this.now();
    const staleBefore = new Date(now.getTime() - this.config.staleJobMs);
    try {
      this.store.recoverStaleObservationJobs(staleBefore, now);
    } catch {
      this.state.failed += 1;
    }
    void this.poll();
    this.pollTimer = setInterval(() => void this.poll(), this.config.pollIntervalMs);
  }

  async stop(): Promise<void> {
    this.shutdownRequested = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    await Promise.allSettled([...this.inFlight]);
    this.state.running = false;
  }

  async pollNow(): Promise<void> {
    await this.poll();
    await Promise.allSettled([...this.inFlight]);
  }

  private async poll(): Promise<void> {
    if (this.shutdownRequested || !this.config.enabled || this.pollActive) return;
    this.pollActive = true;
    try {
      this.state.lastPollAt = this.now().toISOString();
      const available = Math.max(0, this.config.maxConcurrent - this.state.concurrent);
      const claimed: ObservationOutboxEntry[] = [];
      for (let index = 0; index < available; index += 1) {
        if (this.shutdownRequested) break;
        const job = this.store.claimNextObservationJob(this.now(), this.config.maxConcurrent);
        if (!job) break;
        claimed.push(job);
        this.state.concurrent += 1;
        this.state.processed += 1;
      }
      for (const job of claimed) {
        const task = this.processJob(job)
          .catch(() => {
            this.state.failed += 1;
          })
          .finally(() => {
            this.state.concurrent = Math.max(0, this.state.concurrent - 1);
            this.inFlight.delete(task);
          });
        this.inFlight.add(task);
      }
    } catch {
      this.state.failed += 1;
    } finally {
      this.pollActive = false;
    }
  }

  private async processJob(job: ObservationOutboxEntry): Promise<void> {
    const startedAt = Date.now();
    if (job.questionSetVersion !== JEV_TRACE_QUESTION_SET_VERSION || job.classifierVersion !== JEV_CLASSIFIER_VERSION) {
      this.store.completeObservationJob({
        observationId: job.observationId,
        status: "degraded",
        classifierOutcome: "VERSION_MISMATCH",
        error: "observation_version_mismatch",
        now: this.now()
      });
      this.state.degraded += 1;
      return;
    }

    let trace: CanonicalTraceEvent[];
    try {
      trace = this.store.readCanonicalTraceEvents(job.workItemId, job.traceId, this.config.maxProjectionEvents);
    } catch {
      this.retry(job, "trace_unavailable");
      return;
    }
    if (trace.length === 0 || !trace.some((event) => TERMINAL_TRACE_KINDS.has(event.kind))) {
      this.retry(job, "trace_incomplete");
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const advisory = await raceAbort(
        this.classifier(trace, {
          timeoutMs: this.config.timeoutMs,
          signal: controller.signal,
          sink: this.telemetrySink
        }),
        controller.signal
      );
      if (!advisory) {
        this.retry(job, "observer_error");
        return;
      }
      const outcome = classifierOutcome(advisory);
      const status = advisory.result.degraded ? "degraded" : "completed";
      this.store.completeObservationJob({
        observationId: job.observationId,
        status,
        classifierOutcome: outcome,
        error: advisory.result.degraded ? (advisory.result.failureReason ?? "NO_ADVICE") : null,
        now: this.now()
      });
      if (status === "degraded") this.state.degraded += 1;
      else this.state.completed += 1;
    } catch (error) {
      this.retry(job, controller.signal.aborted || error instanceof AbortError ? "timeout" : "observer_error");
    } finally {
      clearTimeout(timer);
      void startedAt;
    }
  }

  private retry(job: ObservationOutboxEntry, error: string): void {
    const updated = this.store.retryObservationJob(job.observationId, error, this.now());
    if (updated.status === "failed") this.state.failed += 1;
    else this.state.retried += 1;
  }
}

async function defaultTraceClassifier(
  trace: readonly CanonicalTraceEvent[],
  options: ObservationClassifierOptions
): Promise<JevTraceAdvisory | null> {
  if (options.signal.aborted) throw new AbortError();
  const advisory = await runJevTraceShadow(trace, {
    enabled: true,
    timeoutMs: options.timeoutMs,
    sink: options.sink
  });
  if (options.signal.aborted) throw new AbortError();
  return advisory;
}

function classifierOutcome(advisory: JevTraceAdvisory): string {
  if (advisory.result.degraded) return advisory.result.failureReason ?? "NO_ADVICE";
  const failureMode = advisory.result.answers.failure_mode;
  if (failureMode?.type === "choice") return failureMode.choice;
  return "observed";
}

async function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new AbortError();
  return await Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(new AbortError()), { once: true });
    })
  ]);
}

class AbortError extends Error {
  constructor() {
    super("observation timed out");
    this.name = "AbortError";
  }
}

function validateConfig(config: ObservationWorkerConfig): ObservationWorkerConfig {
  const positive = [
    config.maxConcurrent,
    config.timeoutMs,
    config.maxProjectionEvents,
    config.pollIntervalMs,
    config.staleJobMs
  ];
  if (positive.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new TypeError("observation worker configuration must use positive integers");
  }
  return config;
}
