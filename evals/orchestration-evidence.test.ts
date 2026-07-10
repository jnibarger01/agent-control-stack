import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertOrchestrationEvidence,
  type OrchestrationEvidence
} from "./orchestration-evidence.js";

const files = [
  "2026-07-09-orchestration-fan-out-synthesize.json",
  "2026-07-09-orchestration-adversarial.json",
  "2026-07-09-orchestration-loop-until-done.json",
  "2026-07-09-orchestration-loop-iteration-cap.json"
] as const;

function load(file: string): OrchestrationEvidence {
  const value: unknown = JSON.parse(readFileSync(new URL(`../runs/${file}`, import.meta.url), "utf8"));
  assertOrchestrationEvidence(value);
  return value;
}

describe("orchestration pattern evidence", () => {
  it("records one completed run per reusable pattern against eval tasks", () => {
    const completed = files.map(load).filter(({ expectedFailure }) => expectedFailure === null);
    expect(new Set(completed.map(({ pattern }) => pattern))).toEqual(
      new Set(["fanOutSynthesize", "adversarial", "loopUntilDone"])
    );
    expect(completed.every(({ taskIds }) => taskIds.length >= 1)).toBe(true);
    expect(completed.every(({ spendLog }) => spendLog.predictedCostUsd > 0 && spendLog.actualCostUsd === 0)).toBe(true);
  });

  it("records the deliberately unbounded loop stopping at its iteration cap", () => {
    const capped = load("2026-07-09-orchestration-loop-iteration-cap.json");
    expect(capped).toMatchObject({
      pattern: "loopUntilDone",
      expectedFailure: "iteration_cap",
      caps: { maxIterations: 2 },
      spendLog: { status: "failed", failureCode: "iteration_cap" }
    });
    expect(capped.spendLog.calls).toHaveLength(4);
  });

  it("rejects result-spend and aggregate-usage tampering", () => {
    const value = JSON.parse(
      readFileSync(new URL("../runs/2026-07-09-orchestration-adversarial.json", import.meta.url), "utf8")
    ) as OrchestrationEvidence;
    (value.result as { spend: { actualCostUsd: number } }).spend.actualCostUsd = 999;
    value.spendLog.usage.inputTokens += 1;
    expect(() => assertOrchestrationEvidence(value)).toThrow();
  });
});
