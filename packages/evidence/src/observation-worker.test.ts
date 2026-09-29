import { describe, expect, it, vi, afterEach } from "vitest";
import type { JevTraceAdvisory } from "@agent-control-stack/jev-advisor";
import type {
  CanonicalTraceEvent,
  CompleteObservationJobInput,
  ObservationCapacity,
  ObservationOutboxEntry
} from "@agent-control-stack/work-items";
import { JEV_CLASSIFIER_VERSION, JEV_TRACE_QUESTION_SET_VERSION } from "@agent-control-stack/jev-advisor";
import { ObservationWorker, type ObservationWorkerStore, type TraceClassifier } from "./observation-worker.js";

const workers: ObservationWorker[] = [];
afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
  vi.unstubAllGlobals();
});

function trace(kind: CanonicalTraceEvent["kind"] = "run.completed", seq = 1): CanonicalTraceEvent {
  return {
    schema_version: "trace-event/1",
    event_id: "01JEV400000000000000000000",
    trace_id: "a".repeat(32),
    span_id: "b".repeat(16),
    source: { system: "acs", component: "work-results", instance: "acs-test", release_sha: "unreleased" },
    class: "authority",
    kind,
    actor: { id: "worker-a", type: "agent" },
    subject: { work_item_id: "wi-1" },
    seq,
    prev_hash: "0".repeat(64),
    ts: "2026-09-28T00:00:00.000Z",
    payload: { outcome: "succeeded" },
    payload_hash: "c".repeat(64)
  };
}

function job(overrides: Partial<ObservationOutboxEntry> = {}): ObservationOutboxEntry {
  return {
    observationId: "obs_" + "1".repeat(24),
    workItemId: "wi-1",
    traceId: "a".repeat(32),
    questionSetVersion: JEV_TRACE_QUESTION_SET_VERSION,
    classifierVersion: JEV_CLASSIFIER_VERSION,
    attempts: 0,
    maxAttempts: 3,
    status: "pending",
    createdAt: "2026-09-28T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
    classifierOutcome: null,
    error: null,
    ...overrides
  };
}

function advisory(options: { degraded?: boolean; failureReason?: string; choice?: string } = {}): JevTraceAdvisory {
  return {
    projection: {} as JevTraceAdvisory["projection"],
    result: {
      classifierVersion: JEV_CLASSIFIER_VERSION,
      model: null,
      latencyMs: 1,
      answers: options.choice
        ? {
            failure_mode: {
              type: "choice",
              choice: options.choice,
              probabilities: { [options.choice]: 1 },
              confidence: 1
            }
          }
        : {},
      signals: {},
      capability: null,
      degraded: options.degraded ?? false,
      ...(options.failureReason ? { failureReason: options.failureReason as "INCOMPATIBLE_MODEL" } : {})
    },
    telemetry: {} as JevTraceAdvisory["telemetry"]
  };
}

class FakeStore implements ObservationWorkerStore {
  readonly jobs: ObservationOutboxEntry[];
  traceEvents: CanonicalTraceEvent[] = [trace()];
  recovered = 0;

  constructor(entries: ObservationOutboxEntry[] = [job()]) {
    this.jobs = entries.map((entry) => ({ ...entry }));
  }

  claimNextObservationJob(now = new Date(), _maxRunning?: number): ObservationOutboxEntry | undefined {
    const current = this.jobs.find((entry) => entry.status === "pending" && entry.attempts < entry.maxAttempts);
    if (!current) return undefined;
    current.status = "running";
    current.attempts += 1;
    current.startedAt = now.toISOString();
    return { ...current };
  }

  retryObservationJob(observationId: string, error: string): ObservationOutboxEntry {
    const current = this.required(observationId);
    current.error = error;
    if (current.attempts >= current.maxAttempts) {
      current.status = "failed";
      current.completedAt = "2026-09-28T00:01:00.000Z";
    } else {
      current.status = "pending";
      current.startedAt = null;
    }
    return { ...current };
  }

  completeObservationJob(input: CompleteObservationJobInput): ObservationOutboxEntry {
    const current = this.required(input.observationId);
    current.status = input.status;
    current.classifierOutcome = input.classifierOutcome;
    current.error = input.error;
    current.completedAt = (input.now ?? new Date()).toISOString();
    return { ...current };
  }

  recoverStaleObservationJobs(): number {
    this.recovered += 1;
    return 0;
  }

  getObservationCapacity(): ObservationCapacity {
    const queued = this.jobs.filter((entry) => entry.status === "pending").length;
    const running = this.jobs.filter((entry) => entry.status === "running").length;
    return { queued, running, maxQueued: 1000, saturated: false };
  }

  readCanonicalTraceEvents(): CanonicalTraceEvent[] {
    return this.traceEvents.map((event) => ({ ...event }));
  }

  private required(id: string): ObservationOutboxEntry {
    const current = this.jobs.find((entry) => entry.observationId === id);
    if (!current) throw new Error("missing fake observation");
    return current;
  }
}

function makeWorker(store: FakeStore, classifier?: TraceClassifier, config: Record<string, number | boolean> = {}) {
  const worker = new ObservationWorker(store, {
    ...(classifier ? { classifier } : {}),
    config: {
      enabled: true,
      pollIntervalMs: 10_000,
      timeoutMs: 100,
      staleJobMs: 200,
      ...config
    }
  });
  workers.push(worker);
  return worker;
}

describe("JEV-4 observation worker", () => {
  it("recovers stale persisted jobs at start and stops cleanly", async () => {
    const store = new FakeStore([]);
    const worker = makeWorker(store, vi.fn());
    worker.start();
    expect(store.recovered).toBe(1);
    expect(worker.getState().running).toBe(true);
    await worker.stop();
    expect(worker.getState().running).toBe(false);
  });

  it("does not decrement concurrency when no job is available", async () => {
    const worker = makeWorker(new FakeStore([]), vi.fn());
    await worker.pollNow();
    expect(worker.getState().concurrent).toBe(0);
    expect(worker.getState().processed).toBe(0);
  });

  it("classifies only canonical terminal trace evidence and completes the job", async () => {
    const store = new FakeStore();
    const classifier = vi.fn(async (events: readonly CanonicalTraceEvent[]) => {
      expect(events).toHaveLength(1);
      expect(events[0]?.schema_version).toBe("trace-event/1");
      expect(events[0]?.kind).toBe("run.completed");
      return advisory({ choice: "healthy" });
    });
    const worker = makeWorker(store, classifier);
    await worker.pollNow();
    expect(classifier).toHaveBeenCalledTimes(1);
    expect(store.jobs[0]).toMatchObject({ status: "completed", classifierOutcome: "healthy" });
    expect(worker.getState()).toMatchObject({ completed: 1, concurrent: 0 });
  });

  it("records current Noul-only incompatibility as degraded instead of retrying", async () => {
    const store = new FakeStore();
    const classifier = vi.fn().mockResolvedValue(advisory({ degraded: true, failureReason: "INCOMPATIBLE_MODEL" }));
    const worker = makeWorker(store, classifier);
    await worker.pollNow();
    expect(store.jobs[0]).toMatchObject({
      status: "degraded",
      classifierOutcome: "INCOMPATIBLE_MODEL",
      error: "INCOMPATIBLE_MODEL"
    });
    expect(worker.getState().retried).toBe(0);
  });

  it("retries an incomplete canonical trace without invoking Jev", async () => {
    const store = new FakeStore();
    store.traceEvents = [trace("run.started")];
    const classifier = vi.fn();
    const worker = makeWorker(store, classifier);
    await worker.pollNow();
    expect(classifier).not.toHaveBeenCalled();
    expect(store.jobs[0]).toMatchObject({ status: "pending", error: "trace_incomplete", attempts: 1 });
    expect(worker.getState().retried).toBe(1);
  });

  it("retries a classifier failure without altering persisted authority data", async () => {
    const store = new FakeStore();
    const classifier = vi.fn().mockRejectedValue(new Error("offline"));
    const worker = makeWorker(store, classifier);
    await worker.pollNow();
    expect(store.jobs[0]).toMatchObject({ status: "pending", error: "observer_error", attempts: 1 });
    expect(worker.getState().failed).toBe(0);
    expect(worker.getState().retried).toBe(1);
  });

  it("aborts and retries a classifier that exceeds the observation timeout", async () => {
    const store = new FakeStore();
    const classifier: TraceClassifier = (_events, options) =>
      new Promise((_resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    const worker = makeWorker(store, classifier, { timeoutMs: 10 });
    await worker.pollNow();
    expect(store.jobs[0]).toMatchObject({ status: "pending", error: "timeout", attempts: 1 });
  });

  it("degrades version-drifted jobs without running the classifier", async () => {
    const store = new FakeStore([job({ questionSetVersion: "jev-trace@0" })]);
    const classifier = vi.fn();
    const worker = makeWorker(store, classifier);
    await worker.pollNow();
    expect(classifier).not.toHaveBeenCalled();
    expect(store.jobs[0]).toMatchObject({
      status: "degraded",
      classifierOutcome: "VERSION_MISMATCH",
      error: "observation_version_mismatch"
    });
  });

  it("never exceeds configured in-process concurrency", async () => {
    const store = new FakeStore([
      job({ observationId: "obs_" + "1".repeat(24) }),
      job({ observationId: "obs_" + "2".repeat(24) }),
      job({ observationId: "obs_" + "3".repeat(24) })
    ]);
    const resolvers: Array<() => void> = [];
    const classifier: TraceClassifier = () =>
      new Promise((resolve) => {
        resolvers.push(() => resolve(advisory({ choice: "healthy" })));
      });
    const worker = makeWorker(store, classifier, { maxConcurrent: 2, timeoutMs: 5000 });
    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(worker.getState().concurrent).toBe(2);
    expect(store.jobs.filter((entry) => entry.status === "running")).toHaveLength(2);
    expect(store.jobs.filter((entry) => entry.status === "pending")).toHaveLength(1);
    resolvers.forEach((resolve) => resolve());
    await worker.stop();
    expect(worker.getState().concurrent).toBe(0);
  });

  it("uses the real Jev trace shadow path without a network call on the current Noul-only capability", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const store = new FakeStore();
    const worker = new ObservationWorker(store, {
      telemetrySink: () => {
        throw new Error("sink offline");
      },
      config: { pollIntervalMs: 10_000, timeoutMs: 100 }
    });
    workers.push(worker);
    await worker.pollNow();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(store.jobs[0]).toMatchObject({
      status: "degraded",
      classifierOutcome: "INCOMPATIBLE_MODEL"
    });
  });

  it("contains store claim failures inside the observational worker", async () => {
    class ClaimFailureStore extends FakeStore {
      override claimNextObservationJob(): ObservationOutboxEntry | undefined {
        throw new Error("database temporarily unavailable");
      }
    }
    const worker = makeWorker(new ClaimFailureStore([]), vi.fn());
    await expect(worker.pollNow()).resolves.toBeUndefined();
    expect(worker.getState()).toMatchObject({ failed: 1, concurrent: 0, processed: 0 });
  });

  it("contains stale-recovery failures and keeps startup non-authoritative", async () => {
    class RecoveryFailureStore extends FakeStore {
      override recoverStaleObservationJobs(): number {
        throw new Error("recovery unavailable");
      }
    }
    const worker = makeWorker(new RecoveryFailureStore([]), vi.fn());
    expect(() => worker.start()).not.toThrow();
    expect(worker.getState()).toMatchObject({ running: true, failed: 1 });
  });
});
