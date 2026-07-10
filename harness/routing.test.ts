import { describe, expect, it } from "vitest";
import {
  DEESCALATION_AGREEMENT_RUNS,
  GENERAL_AVAILABILITY,
  MODEL_IDS,
  MODEL_REGISTRY,
  route,
  type ModelId,
  type TaskClass
} from "./routing.js";

describe("route", () => {
  it.each<[TaskClass, ModelId]>([
    ["orchestration", MODEL_IDS.fable],
    ["planning", MODEL_IDS.fable],
    ["refusal_sensitive_frontier", MODEL_IDS.fable],
    ["hard_subtask", MODEL_IDS.opus],
    ["bulk_worker", MODEL_IDS.sonnet],
    ["grader", MODEL_IDS.haiku],
    ["classifier", MODEL_IDS.haiku]
  ])("routes %s to its default model", (taskClass, expected) => {
    expect(route(taskClass, 0, null)).toBe(expected);
  });

  it("keeps limited Mythos out of default availability", () => {
    expect(GENERAL_AVAILABILITY).not.toContain(MODEL_IDS.mythos);
    expect(MODEL_REGISTRY[MODEL_IDS.mythos].availability).toBe("limited");
    expect(route("hard_subtask", 0, null)).toBe(MODEL_IDS.opus);
  });

  it("uses Mythos as the hard fallback only when access is explicit", () => {
    const availableModelIds = [...GENERAL_AVAILABILITY, MODEL_IDS.mythos];

    expect(route("hard_subtask", 0, { kind: "availability", availableModelIds })).toBe(MODEL_IDS.mythos);
  });

  it("escalates after two consecutive verifier failures, not one", () => {
    expect(route("bulk_worker", 1, { kind: "verifier_failure" })).toBe(MODEL_IDS.sonnet);
    expect(route("bulk_worker", 2, { kind: "verifier_failure" })).toBe(MODEL_IDS.fable);
  });

  it("escalates grader disagreement immediately", () => {
    expect(route("grader", 0, { kind: "grader_disagreement" })).toBe(MODEL_IDS.sonnet);
  });

  it("falls back from a Fable refusal to the strongest available non-Fable route", () => {
    expect(route("planning", 1, { kind: "refusal", modelId: MODEL_IDS.fable })).toBe(MODEL_IDS.opus);

    const availableModelIds = [...GENERAL_AVAILABILITY, MODEL_IDS.mythos];
    expect(
      route("refusal_sensitive_frontier", 1, {
        kind: "refusal",
        modelId: MODEL_IDS.fable,
        availableModelIds
      })
    ).toBe(MODEL_IDS.mythos);
  });

  it("returns an escalated class to its base route after N agreement runs", () => {
    expect(
      route("bulk_worker", 0, {
        kind: "agreement",
        agreementRuns: DEESCALATION_AGREEMENT_RUNS - 1,
        currentModelId: MODEL_IDS.fable
      })
    ).toBe(MODEL_IDS.fable);

    expect(
      route("bulk_worker", 0, {
        kind: "agreement",
        agreementRuns: DEESCALATION_AGREEMENT_RUNS,
        currentModelId: MODEL_IDS.fable
      })
    ).toBe(MODEL_IDS.sonnet);
  });

  it("uses a stable fallback order independent of availability input order", () => {
    const first = route("orchestration", 0, {
      kind: "availability",
      availableModelIds: [MODEL_IDS.haiku, MODEL_IDS.opus]
    });
    const second = route("orchestration", 0, {
      kind: "availability",
      availableModelIds: [MODEL_IDS.opus, MODEL_IDS.haiku]
    });

    expect(first).toBe(MODEL_IDS.opus);
    expect(second).toBe(first);
  });

  it("fails closed for invalid attempts, task classes, and empty availability", () => {
    expect(() => route("bulk_worker", -1, null)).toThrow("attempt");
    expect(() => route("unknown" as TaskClass, 0, null)).toThrow("task class");
    expect(() =>
      route("bulk_worker", 0, { kind: "availability", availableModelIds: [] })
    ).toThrow("available model");
  });
});
