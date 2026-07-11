import { describe, expect, it } from "vitest";
import { buildClaudeCliArgs, parseClaudeCliResult } from "./claude-cli-provider.js";
import { ModelProviderError, type CompletionRequest } from "./model-provider.js";

const request: CompletionRequest = {
  model: "claude-haiku-4-5",
  system: "Grade one response.",
  prompt: "Return JSON.",
  maxBudgetUsd: 0.02,
  timeoutMs: 30_000,
  jsonSchema: { type: "object" }
};

describe("ClaudeCliProvider", () => {
  it("builds a tool-less, non-persistent, budget-capped invocation", () => {
    const args = buildClaudeCliArgs(request);
    expect(args).toContain("--safe-mode");
    expect(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2)).toEqual(["--tools", ""]);
    expect(args.slice(args.indexOf("--permission-mode"), args.indexOf("--permission-mode") + 2)).toEqual([
      "--permission-mode",
      "plan"
    ]);
    expect(args).toContain("--no-session-persistence");
    expect(args.slice(args.indexOf("--max-budget-usd"), args.indexOf("--max-budget-usd") + 2)).toEqual([
      "--max-budget-usd",
      "0.02"
    ]);
    expect(args.at(-2)).toBe("--json-schema");
  });

  it("parses exact model, token, cost, and stop receipts", () => {
    const result = parseClaudeCliResult(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "{\"ok\":true}",
        stop_reason: "end_turn",
        duration_ms: 4518,
        total_cost_usd: 0.011543,
        usage: { input_tokens: 9, output_tokens: 350 },
        modelUsage: {
          "claude-haiku-4-5-20251001": {
            inputTokens: 530,
            outputTokens: 12,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            costUSD: 0.00059
          },
          "claude-haiku-4-5": {
            inputTokens: 9,
            outputTokens: 350,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 4597,
            costUSD: 0.010953
          }
        }
      }),
      request.model
    );

    expect(result.exactModels).toEqual(["claude-haiku-4-5", "claude-haiku-4-5-20251001"]);
    expect(result.usage).toEqual({
      inputTokens: 539,
      outputTokens: 362,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 4597
    });
    expect(result.costUsd).toBeCloseTo(0.011543);
    expect(result.refused).toBe(false);
  });

  it("marks classifier refusals without treating them as process errors", () => {
    const result = parseClaudeCliResult(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "",
        stop_reason: "refusal",
        duration_ms: 10,
        total_cost_usd: 0,
        usage: { input_tokens: 1, output_tokens: 0 }
      }),
      "claude-fable-5"
    );
    expect(result.refused).toBe(true);
    expect(result.stopReason).toBe("refusal");
  });

  it("fails closed on malformed success payloads", () => {
    expect(() => parseClaudeCliResult('{"type":"result","subtype":"success"}', request.model)).toThrow(
      ModelProviderError
    );
  });

  it("classifies structured budget failures without exposing prompt text", () => {
    try {
      parseClaudeCliResult(
        JSON.stringify({
          type: "result",
          subtype: "error",
          is_error: true,
          result: "budget reached",
          stop_reason: null,
          duration_ms: 1,
          total_cost_usd: 0.05,
          terminal_reason: "budget_exceeded"
        }),
        request.model
      );
      throw new Error("expected parse failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ModelProviderError);
      expect((error as ModelProviderError).kind).toBe("budget");
      expect((error as Error).message).not.toContain("Return JSON");
    }
  });

  it("classifies minimal non-success envelopes before requiring success fields", () => {
    try {
      parseClaudeCliResult(
        JSON.stringify({ type: "result", subtype: "error_max_budget_usd", is_error: true }),
        request.model
      );
      throw new Error("expected parse failure");
    } catch (error) {
      expect((error as ModelProviderError).kind).toBe("budget");
      expect((error as Error).message).toContain("error_max_budget_usd");
    }
  });

  it("keeps provider error messages free of task prompts", () => {
    const error = new ModelProviderError("process", "Claude CLI exited with code 1 (stderr content suppressed)", 1);
    expect(error.message).not.toContain(request.prompt);
    expect(error.message).not.toContain(request.system);
  });
});
