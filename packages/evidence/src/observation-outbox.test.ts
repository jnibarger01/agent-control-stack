import { describe, expect, it } from "vitest";
import {
  observationalIdentity,
  observationJobStatusSchema,
  OBSERVATION_OUTBOX_MAX_ATTEMPTS,
  OBSERVATION_OUTBOX_MAX_CONCURRENT,
  OBSERVATION_OUTBOX_MAX_PROJECTION_EVENTS,
  OBSERVATION_OUTBOX_MAX_QUEUE,
  OBSERVATION_OUTBOX_TIMEOUT_MS,
  type ObservationOutboxEntry
} from "./observation-outbox.js";
import { JEV_TRACE_QUESTION_SET_VERSION } from "@agent-control-stack/jev-advisor";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";

function entry(): ObservationOutboxEntry {
  const now = new Date().toISOString();
  return {
    observationId: "obs_0123456789abcdef01234567",
    workItemId: "wrk_abc123",
    traceId: "ab".repeat(16),
    questionSetVersion: "jev-trace@1",
    classifierVersion: "jev-advisory-v2",
    attempts: 0,
    maxAttempts: OBSERVATION_OUTBOX_MAX_ATTEMPTS,
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

describe("JEV observation outbox contract", () => {
  it("uses deterministic sha256-derived observational identities", () => {
    const input = {
      traceId: "ab".repeat(16),
      questionSetVersion: "jev-trace@1",
      classifierVersion: "jev-advisory-v2"
    };
    expect(observationalIdentity(input)).toBe(observationalIdentity(input));
    expect(observationalIdentity(input)).toMatch(/^obs_[a-f0-9]{24}$/);
  });

  it("changes identity when any contract dimension changes", () => {
    const base = {
      traceId: "ab".repeat(16),
      questionSetVersion: "jev-trace@1",
      classifierVersion: "jev-advisory-v2"
    };
    expect(observationalIdentity({ ...base, traceId: "cd".repeat(16) })).not.toBe(observationalIdentity(base));
    expect(observationalIdentity({ ...base, questionSetVersion: "jev-trace@2" })).not.toBe(observationalIdentity(base));
    expect(observationalIdentity({ ...base, classifierVersion: "jev-advisory-v3" })).not.toBe(
      observationalIdentity(base)
    );
  });

  it("does not place authority material in a queued job", () => {
    const serialized = JSON.stringify(entry()).toLowerCase();
    expect(serialized).not.toContain("capability");
    expect(serialized).not.toContain("approval_token");
    expect(serialized).not.toContain("lease_token");
  });

  it("accepts only bounded lifecycle statuses", () => {
    for (const status of ["pending", "running", "completed", "failed", "degraded"]) {
      expect(observationJobStatusSchema.parse(status)).toBe(status);
    }
    expect(() => observationJobStatusSchema.parse("authorized")).toThrow();
  });

  it("keeps explicit global bounds", () => {
    expect(OBSERVATION_OUTBOX_MAX_QUEUE).toBe(1000);
    expect(OBSERVATION_OUTBOX_MAX_CONCURRENT).toBe(5);
    expect(OBSERVATION_OUTBOX_MAX_ATTEMPTS).toBe(3);
    expect(OBSERVATION_OUTBOX_TIMEOUT_MS).toBe(30_000);
    expect(OBSERVATION_OUTBOX_MAX_PROJECTION_EVENTS).toBe(1000);
  });
});


describe("JEV trace attribution version", () => {
  it("keeps the work-items default observation version aligned with the JEV constant", () => {
    // work-items must not depend on jev-advisor, so the default it persists is a
    // literal. This guard is the single place that keeps the two in step.
    const store = new SqliteWorkItemStore(":memory:");
    try {
      const persisted = (
        store as unknown as { observationQuestionSetVersion: string }
      ).observationQuestionSetVersion;
      expect(persisted).toBe(JEV_TRACE_QUESTION_SET_VERSION);
    } finally {
      store.close();
    }
  });

  it("distinguishes observations attributed to the previous question set", () => {
    // Backward compatibility is explicit: identity includes the version, so rows
    // written under @1 are never conflated with @2 rows, and both remain readable
    // because each row stores the version it was written with.
    const current = { ...entry(), questionSetVersion: JEV_TRACE_QUESTION_SET_VERSION };
    const previous = { ...current, questionSetVersion: "jev-trace@1" };
    expect(observationalIdentity(current)).not.toBe(observationalIdentity(previous));
    expect(observationalIdentity(current)).toBe(
      observationalIdentity({ ...current, questionSetVersion: JEV_TRACE_QUESTION_SET_VERSION })
    );
  });
});
