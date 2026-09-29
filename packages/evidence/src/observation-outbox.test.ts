import { describe, expect, it } from "vitest";
import {
  OBSERVATION_CLASSIFIER_VERSION,
  OBSERVATION_OUTBOX_MAX_ATTEMPTS,
  OBSERVATION_OUTBOX_MAX_CONCURRENT,
  OBSERVATION_OUTBOX_MAX_QUEUE,
  OBSERVATION_QUESTION_SET_VERSION,
  observationOutboxEntrySchema,
  observationalIdentity,
  type ObservationOutboxEntry
} from "./observation-outbox.js";

function entry(): ObservationOutboxEntry {
  return {
    observationId: observationalIdentity({
      traceId: "a".repeat(32),
      questionSetVersion: OBSERVATION_QUESTION_SET_VERSION,
      classifierVersion: OBSERVATION_CLASSIFIER_VERSION
    }),
    workItemId: "wi-observation",
    traceId: "a".repeat(32),
    questionSetVersion: OBSERVATION_QUESTION_SET_VERSION,
    classifierVersion: OBSERVATION_CLASSIFIER_VERSION,
    attempts: 0,
    maxAttempts: OBSERVATION_OUTBOX_MAX_ATTEMPTS,
    status: "pending",
    createdAt: "2026-09-28T00:00:00.000Z",
    startedAt: null,
    completedAt: null,
    classifierOutcome: null,
    error: null
  };
}

describe("JEV-4 observation contract", () => {
  it("re-exports the bounded store contract", () => {
    expect(OBSERVATION_OUTBOX_MAX_QUEUE).toBe(1000);
    expect(OBSERVATION_OUTBOX_MAX_CONCURRENT).toBe(5);
    expect(OBSERVATION_OUTBOX_MAX_ATTEMPTS).toBe(3);
    expect(OBSERVATION_QUESTION_SET_VERSION).toBe("jev-trace@1");
    expect(OBSERVATION_CLASSIFIER_VERSION).toBe("jev-advisory-v2");
  });

  it("uses deterministic collision-resistant observational identity", () => {
    const first = entry().observationId;
    const second = entry().observationId;
    expect(first).toBe(second);
    expect(first).toMatch(/^obs_[a-f0-9]{24}$/);
  });

  it("changes identity when any classifier tuple field changes", () => {
    const baseline = entry().observationId;
    expect(
      observationalIdentity({
        traceId: "b".repeat(32),
        questionSetVersion: OBSERVATION_QUESTION_SET_VERSION,
        classifierVersion: OBSERVATION_CLASSIFIER_VERSION
      })
    ).not.toBe(baseline);
    expect(
      observationalIdentity({
        traceId: "a".repeat(32),
        questionSetVersion: "jev-trace@2",
        classifierVersion: OBSERVATION_CLASSIFIER_VERSION
      })
    ).not.toBe(baseline);
  });

  it("validates the persisted entry shape", () => {
    expect(observationOutboxEntrySchema.parse(entry())).toEqual(entry());
  });

  it("contains no execution authority material", () => {
    const serialized = JSON.stringify(entry());
    expect(serialized).not.toMatch(/capability|approval_token|lease_token|bearer/i);
  });
});
