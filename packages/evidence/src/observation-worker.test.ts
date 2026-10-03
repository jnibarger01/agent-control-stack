import { afterEach, describe, expect, it, vi } from "vitest";
import { JEV_TRACE_QUESTIONS } from "@agent-control-stack/jev-advisor";
import type {
  CanonicalTraceEvent,
  ObservationCapacity,
  ObservationCompletion,
  ObservationOutboxEntry,
  ObservationStore
} from "@agent-control-stack/work-items";
import { ObservationWorker, type TraceClassifier } from "./observation-worker.js";

function event(kind: CanonicalTraceEvent["kind"], seq: number, traceId = "ab".repeat(16)): CanonicalTraceEvent {
  return {
    schema_version: "trace-event/1",
    event_id: "01H" + String(seq).padStart(23, "0"),
    trace_id: traceId,
    span_id: String(seq).padStart(16, "0"),
    source: { system: "acs", component: "tests", instance: "acs-test", release_sha: "unreleased" },
    class: "telemetry",
    kind,
    actor: { id: "system", type: "system" },
    subject: { work_item_id: "wrk_test" },
    seq,
    prev_hash: "0".repeat(64),
    ts: new Date(1_700_000_000_000 + seq).toISOString(),
    payload: {},
    payload_hash: "0".repeat(64)
  };
}

function job(id = "obs_0123456789abcdef01234567"): ObservationOutboxEntry {
  const now = new Date().toISOString();
  return {
    observationId: id,
    workItemId: "wrk_test",
    traceId: "ab".repeat(16),
    questionSetVersion: "jev-trace@1",
    classifierVersion: "jev-advisory-v2",
    attempts: 0,
    maxAttempts: 3,
    status: "pending",
    createdAt: now,
    availableAt: now,
    startedAt: null,
    completedAt: null,
    classifierOutcome: null,
    telemetryCorrelationId: null,
    error: null
  };
}

class FakeStore implements ObservationStore {
  readonly jobs: ObservationOutboxEntry[];
  trace: CanonicalTraceEvent[];
  completions: Array<{ id: string; completion: ObservationCompletion }> = [];
  constructor(jobs: ObservationOutboxEntry[] = [job()], trace: CanonicalTraceEvent[] = [event("run.completed", 1)]) {
    this.jobs = jobs;
    this.trace = trace;
  }
  claimNextObservation(): ObservationOutboxEntry | undefined {
    const pending = this.jobs.find(
      (candidate) => candidate.status === "pending" && candidate.attempts < candidate.maxAttempts
    );
    if (!pending) return undefined;
    pending.status = "running";
    pending.attempts += 1;
    pending.startedAt = new Date().toISOString();
    return { ...pending };
  }
  loadCanonicalTrace(): CanonicalTraceEvent[] {
    return this.trace.map((item) => ({ ...item }));
  }
  completeObservation(id: string, completion: ObservationCompletion): void {
    const found = this.jobs.find((candidate) => candidate.observationId === id);
    if (found) {
      found.status = completion.status;
      found.completedAt = new Date().toISOString();
      found.classifierOutcome = completion.classifierOutcome;
      found.telemetryCorrelationId = completion.telemetryCorrelationId;
      found.error = completion.error;
    }
    this.completions.push({ id, completion });
  }
  retryObservation(id: string, error: string): "pending" | "failed" {
    const found = this.jobs.find((candidate) => candidate.observationId === id);
    if (!found) return "failed";
    found.error = error;
    found.status = found.attempts >= found.maxAttempts ? "failed" : "pending";
    return found.status;
  }
  getObservationCapacity(): ObservationCapacity {
    const queued = this.jobs.filter((candidate) => candidate.status === "pending").length;
    const running = this.jobs.filter((candidate) => candidate.status === "running").length;
    return { queued, running, maxQueued: 1000, saturated: queued + running >= 1000 };
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("JEV observation worker", () => {
  it("persists the emitted trace correlation for a configured typed observation", async () => {
    vi.stubEnv(
      "ACS_JEV_CAPABILITY_PROFILE",
      JSON.stringify({
        promptVersion: "typed-test",
        supportsNoul: true,
        supportsChoice: true,
        supportsScore: true,
        fingerprint: "test-engine"
      })
    );
    const answers = Object.fromEntries(
      Object.entries(JEV_TRACE_QUESTIONS).map(([name, question]) => {
        if (question.type === "noul") return [name, { type: "noul", noul: 0.5 }];
        const options = Object.keys(question.criteria);
        const probabilities = Object.fromEntries(options.map((option, index) => [option, index === 0 ? 1 : 0]));
        return [
          name,
          question.type === "choice"
            ? { type: "choice", choice: options[0], probabilities, confidence: 1 }
            : { type: "score", score: 0, probabilities, confidence: 1 }
        ];
      })
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ model: "typed-test", answers })))
    );
    const store = new FakeStore();
    const lines: string[] = [];
    const worker = new ObservationWorker(store, { telemetrySink: (line) => lines.push(line) });
    await worker.runOnce();
    expect(store.jobs[0]).toMatchObject({
      status: "completed",
      classifierOutcome: "OK",
      telemetryCorrelationId: job().traceId
    });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ correlation: { trace_id: job().traceId }, degraded: false });
  });

  it("is inert when disabled", async () => {
    const store = new FakeStore();
    const classifier = vi.fn();
    const worker = new ObservationWorker(store, { classifier, config: { enabled: false } });
    expect(await worker.runOnce()).toBe(0);
    expect(store.jobs[0]?.status).toBe("pending");
    expect(classifier).not.toHaveBeenCalled();
  });

  it("classifies a terminal canonical trace and completes the job", async () => {
    const store = new FakeStore();
    const classifier = vi.fn<TraceClassifier>().mockResolvedValue({
      outcome: "OK",
      degraded: false,
      retryable: false,
      telemetryCorrelationId: "tel_1"
    });
    const worker = new ObservationWorker(store, { classifier });
    expect(await worker.runOnce()).toBe(1);
    expect(classifier).toHaveBeenCalledTimes(1);
    expect(store.jobs[0]).toMatchObject({
      status: "completed",
      classifierOutcome: "OK",
      telemetryCorrelationId: "tel_1"
    });
  });

  it("degrades without a classifier call when canonical trace is unavailable", async () => {
    const store = new FakeStore([job()], []);
    const classifier = vi.fn<TraceClassifier>();
    const worker = new ObservationWorker(store, { classifier });
    await worker.runOnce();
    expect(classifier).not.toHaveBeenCalled();
    expect(store.jobs[0]).toMatchObject({ status: "degraded", error: "trace_unavailable" });
  });

  it("degrades incomplete non-terminal traces without inventing an outcome", async () => {
    const store = new FakeStore([job()], [event("run.started", 1), event("tool.call.finished", 2)]);
    const classifier = vi.fn<TraceClassifier>();
    const worker = new ObservationWorker(store, { classifier });
    await worker.runOnce();
    expect(classifier).not.toHaveBeenCalled();
    expect(store.jobs[0]).toMatchObject({ status: "degraded", error: "trace_incomplete", classifierOutcome: null });
  });

  it("retries transport-style failures and stops at max attempts", async () => {
    const store = new FakeStore();
    const classifier = vi.fn<TraceClassifier>().mockResolvedValue({
      outcome: "UNAVAILABLE",
      degraded: true,
      retryable: true,
      telemetryCorrelationId: null
    });
    const worker = new ObservationWorker(store, { classifier });
    await worker.runOnce();
    expect(classifier).toHaveBeenCalledTimes(3);
    expect(store.jobs[0]?.status).toBe("failed");
    expect(worker.getState()).toMatchObject({ retried: 2, failed: 1 });
  });

  it("does not retry an incompatible runtime", async () => {
    const store = new FakeStore();
    const classifier = vi.fn<TraceClassifier>().mockResolvedValue({
      outcome: "INCOMPATIBLE_MODEL",
      degraded: true,
      retryable: false,
      telemetryCorrelationId: null
    });
    const worker = new ObservationWorker(store, { classifier });
    await worker.runOnce();
    expect(classifier).toHaveBeenCalledTimes(1);
    expect(store.jobs[0]).toMatchObject({ status: "degraded", classifierOutcome: "INCOMPATIBLE_MODEL" });
  });

  it("keeps telemetry sink failure non-authoritative", async () => {
    const store = new FakeStore();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const worker = new ObservationWorker(store, {
      telemetrySink: () => {
        throw new Error("sink down");
      }
    });
    await worker.runOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(store.jobs[0]?.status).toBe("degraded");
    expect(store.jobs[0]?.classifierOutcome).toBe("INCOMPATIBLE_MODEL");
    expect(store.jobs[0]?.telemetryCorrelationId).toBe(job().traceId);
  });

  it("uses the current Noul-only capability profile without a Choice/Score network call", async () => {
    const store = new FakeStore();
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const worker = new ObservationWorker(store, { telemetrySink: () => undefined });
    await worker.runOnce();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(store.jobs[0]?.classifierOutcome).toBe("INCOMPATIBLE_MODEL");
  });

  it("never exceeds configured concurrent observations", async () => {
    const jobs = [job("obs_" + "1".repeat(24)), job("obs_" + "2".repeat(24)), job("obs_" + "3".repeat(24))];
    const store = new FakeStore(jobs);
    const resolvers: Array<() => void> = [];
    const classifier: TraceClassifier = () =>
      new Promise((resolve) => {
        resolvers.push(() =>
          resolve({ outcome: "OK", degraded: false, retryable: false, telemetryCorrelationId: null })
        );
      });
    const worker = new ObservationWorker(store, { classifier, config: { maxConcurrent: 2, pollIntervalMs: 20 } });
    worker.start();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(worker.getState().concurrent).toBe(2);
    expect(resolvers).toHaveLength(2);
    resolvers.splice(0).forEach((resolve) => resolve());
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(worker.getState().concurrent).toBeLessThanOrEqual(2);
    resolvers.splice(0).forEach((resolve) => resolve());
    await worker.stop();
  });

  it("reports queue and execution capacity independently", () => {
    const store = new FakeStore([job(), job("obs_" + "9".repeat(24))]);
    const worker = new ObservationWorker(store, { config: { maxConcurrent: 2 } });
    expect(worker.getCapacity()).toMatchObject({
      queued: 2,
      maxQueued: 1000,
      concurrent: 0,
      maxConcurrent: 2,
      saturated: false
    });
  });
});
