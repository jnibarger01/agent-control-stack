import { describe, expect, it } from "vitest";
import type { CompletionRequest, CompletionResult, ModelProvider } from "../../harness/model-provider.js";
import { MODEL_IDS } from "../../harness/routing.js";
import {
  buildGraderPayload,
  gradeCandidate,
  parseCriterionGrades,
  type BinaryCriterion
} from "./independent-grader.js";

const rubric: BinaryCriterion[] = [
  { id: "c1", description: "Names the actor", expected: "operator" },
  { id: "c2", description: "Names the action", expected: "read" },
  { id: "c3", description: "Preserves approval", expected: "no bypass" }
];

function receipt(text: string): CompletionResult {
  return {
    text,
    requestedModel: MODEL_IDS.haiku,
    exactModels: [MODEL_IDS.haiku],
    stopReason: "end_turn",
    refused: false,
    costUsd: 0.001,
    durationMs: 1,
    usage: { inputTokens: 10, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    modelUsage: []
  };
}

class CapturingProvider implements ModelProvider {
  request?: CompletionRequest;
  constructor(private readonly text: string) {}
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    this.request = request;
    return receipt(this.text);
  }
}

describe("independent grader", () => {
  it("builds an input boundary with only task, rubric, and candidate output", () => {
    const payload = buildGraderPayload(
      { id: "task-1", input: "Inspect", context: { facts: [] } },
      rubric,
      "Candidate"
    );
    expect(Object.keys(payload)).toEqual(["task", "rubric", "candidateOutput"]);
    expect(JSON.stringify(payload)).not.toContain("makerReasoning");
    expect(JSON.stringify(payload)).not.toContain("selfAssessment");
  });

  it("routes the grader to the cheapest policy model and returns binary results", async () => {
    const provider = new CapturingProvider(
      JSON.stringify({
        criteria: rubric.map(({ id }) => ({ criterionId: id, pass: true, justification: `${id} observed.` }))
      })
    );
    const result = await gradeCandidate({
      provider,
      task: { id: "task-1", input: "Inspect", context: { facts: [] } },
      rubric,
      candidateOutput: "operator read, approval preserved",
      maxBudgetUsd: 0.02,
      timeoutMs: 1_000
    });
    expect(provider.request?.model).toBe(MODEL_IDS.haiku);
    expect(Object.keys(JSON.parse(provider.request!.prompt))).toEqual(["task", "rubric", "candidateOutput"]);
    expect(result.pass).toBe(true);
  });

  it("fails closed on missing, duplicate, extra, or multiline criterion results", () => {
    expect(() => parseCriterionGrades('{"criteria":[]}', rubric)).toThrow("omitted");
    expect(() =>
      parseCriterionGrades(
        JSON.stringify({
          criteria: [
            { criterionId: "c1", pass: true, justification: "ok" },
            { criterionId: "c1", pass: true, justification: "again" },
            { criterionId: "c2", pass: true, justification: "ok" },
            { criterionId: "c3", pass: true, justification: "ok" }
          ]
        }),
        rubric
      )
    ).toThrow("duplicate");
    expect(() =>
      parseCriterionGrades(
        JSON.stringify({
          criteria: rubric.map(({ id }) => ({ criterionId: id, pass: true, justification: "line one\nline two" }))
        }),
        rubric
      )
    ).toThrow("one non-empty line");
  });

  it("accepts JSON fenced by the CLI but still validates the inner object", () => {
    const grades = parseCriterionGrades(
      `\`\`\`json\n${JSON.stringify({
        criteria: rubric.map(({ id }) => ({ criterionId: id, pass: false, justification: `${id} absent.` }))
      })}\n\`\`\``,
      rubric
    );
    expect(grades).toHaveLength(3);
    expect(grades.every((grade) => !grade.pass)).toBe(true);
  });
});
