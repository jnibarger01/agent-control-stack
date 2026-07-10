import { describe, expect, it } from "vitest";
import { calculateTotals, type EvalTaskResult } from "./result-schema.js";

function task(passes: boolean[]): EvalTaskResult {
  return {
    taskId: "task",
    taskClass: "bulk_worker",
    predictedCostUsd: 0.1,
    actualCostUsd: 0.1,
    candidate: {
      requestedModel: "model",
      exactModels: ["model-version"],
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      costUsd: 0.05,
      output: "candidate",
      attempts: []
    },
    grade: {
      requestedModel: "grader",
      exactModels: ["grader-version"],
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      costUsd: 0.05,
      pass: passes.every(Boolean),
      criteria: passes.map((pass, index) => ({
        criterionId: `c${index}`,
        pass,
        justification: pass ? "Observed." : "Absent."
      }))
    },
    score: passes.filter(Boolean).length / passes.length
  };
}

describe("eval result totals", () => {
  it("computes task, criterion, passed, and normalized score totals", () => {
    expect(calculateTotals([task([true, false]), task([true, true])])).toEqual({
      tasks: 2,
      criteria: 4,
      passed: 3,
      score: 0.75
    });
  });

  it("defines an empty run score as zero", () => {
    expect(calculateTotals([])).toEqual({ tasks: 0, criteria: 0, passed: 0, score: 0 });
  });
});
