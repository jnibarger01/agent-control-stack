import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CompletionRequest, CompletionResult, ModelProvider } from "../harness/model-provider.js";
import { MODEL_IDS } from "../harness/routing.js";
import { runEvals } from "./runner.js";
import { loadEvalTaskCorpus } from "./task-schema.js";

const created: string[] = [];

afterEach(() => {
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
});

class RecordingProvider implements ModelProvider {
  readonly requests: CompletionRequest[] = [];
  private refusedFable = false;

  constructor(private readonly events: string[]) {}

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    this.events.push(`call:${request.model}`);
    this.requests.push(request);
    const grader = request.system.includes("independent binary rubric grader");
    if (!grader && request.model === MODEL_IDS.fable && !this.refusedFable) {
      this.refusedFable = true;
      return this.receipt(request, "", true);
    }
    if (grader) {
      const payload = JSON.parse(request.prompt) as { rubric: Array<{ id: string }> };
      return this.receipt(
        request,
        JSON.stringify({
          criteria: payload.rubric.map(({ id }) => ({
            criterionId: id,
            pass: true,
            justification: `${id} is observable in the scripted candidate.`
          }))
        }),
        false
      );
    }
    const payload = JSON.parse(request.prompt) as { id: string };
    return this.receipt(request, `Candidate for ${payload.id}`, false);
  }

  private receipt(request: CompletionRequest, text: string, refused: boolean): CompletionResult {
    return {
      text,
      requestedModel: request.model,
      exactModels: [`exact:${request.model}`],
      stopReason: refused ? "refusal" : "end_turn",
      refused,
      costUsd: 0.001,
      durationMs: 1,
      usage: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      modelUsage: []
    };
  }
}

describe("full eval runner", () => {
  it("prints prediction first, preserves isolated calls, retries refusal, and writes cost receipts", async () => {
    const tasks = loadEvalTaskCorpus(resolve("evals/tasks"));
    const root = resolve("runs/artifacts");
    mkdirSync(root, { recursive: true });
    const directory = mkdtempSync(join(root, "runner-test-"));
    created.push(directory);
    const outputPath = join(directory, "result.json");
    const events: string[] = [];
    const provider = new RecordingProvider(events);
    const times = ["2026-07-09T22:00:00.000Z", "2026-07-09T22:01:00.000Z"];

    const result = await runEvals({
      tasks,
      provider,
      providerName: "scripted-test",
      pricingDate: "2026-07-09",
      runId: "test-run",
      outputPath,
      maxCallBudgetUsd: 0.05,
      timeoutMs: 1_000,
      now: () => times.shift()!,
      log: (line) => events.push(`log:${line}`)
    });

    expect(events[0]).toMatch(/^log:Predicted cost:/);
    expect(events[1]).toMatch(/^call:/);
    expect(result.taskResults).toHaveLength(10);
    expect(result.actualCostUsd).toBeCloseTo(0.021);
    expect(result.predictedCostUsd).toBeGreaterThan(0);
    expect(result.totals).toMatchObject({ tasks: 10, criteria: 39, passed: 39, score: 1 });

    const refused = result.taskResults.find((task) => task.taskId === "auth-boundary-review")!;
    expect(refused.candidate.attempts.map((attempt) => attempt.requestedModel)).toEqual([
      MODEL_IDS.fable,
      MODEL_IDS.opus
    ]);
    expect(refused.candidate.costUsd).toBeCloseTo(0.002);

    const makerRequests = provider.requests.filter(
      (request) => !request.system.includes("independent binary rubric grader")
    );
    const graderRequests = provider.requests.filter((request) => request.system.includes("independent binary rubric grader"));
    expect(Object.keys(JSON.parse(makerRequests[0]!.prompt))).toEqual(["id", "input", "context"]);
    expect(Object.keys(JSON.parse(graderRequests[0]!.prompt))).toEqual(["task", "rubric", "candidateOutput"]);
    expect(graderRequests.every((request) => !request.prompt.includes("selfAssessment"))).toBe(true);

    const persisted = JSON.parse(readFileSync(outputPath, "utf8")) as typeof result;
    expect(persisted).toEqual(result);
  });
});
