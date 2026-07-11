import type { CompletionRequest, CompletionResult, ModelProvider } from "../harness/model-provider.js";

/**
 * Deterministic test-only provider. Runs using this provider are labeled
 * `fixture-test-only` and are never baseline evidence.
 */
export class FixtureProvider implements ModelProvider {
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const text = request.system.includes("independent binary rubric grader")
      ? gradeFixture(request.prompt)
      : makeFixture(request.prompt);
    return {
      text,
      requestedModel: request.model,
      exactModels: [`fixture:${request.model}`],
      stopReason: "end_turn",
      refused: false,
      costUsd: 0,
      durationMs: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      modelUsage: []
    };
  }
}

function makeFixture(prompt: string): string {
  const value = JSON.parse(prompt) as { id?: unknown };
  return `Fixture-only candidate for ${String(value.id ?? "unknown")}; not baseline evidence.`;
}

function gradeFixture(prompt: string): string {
  const value = JSON.parse(prompt) as { rubric?: Array<{ id?: unknown }> };
  const criteria = (value.rubric ?? []).map(({ id }) => ({
    criterionId: String(id),
    pass: true,
    justification: "Fixture-only plumbing pass; not baseline evidence."
  }));
  return JSON.stringify({ criteria });
}
