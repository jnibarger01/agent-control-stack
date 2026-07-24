import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeCliProvider, buildClaudeCliArgs, claudeCliSubprocessEnv, parseClaudeCliResult } from "./claude-cli-provider.js";
import { ModelProviderError, type CompletionRequest } from "./model-provider.js";

const request: CompletionRequest = {
  model: "claude-haiku-4-5",
  system: "Grade one response.",
  prompt: "Return JSON.",
  maxBudgetUsd: 0.02,
  timeoutMs: 30_000,
  jsonSchema: { type: "object" }
};

describe("claudeCliSubprocessEnv", () => {
  it("passes through only the allowlisted keys, dropping everything else including secrets", () => {
    const source = {
      HOME: "/home/tester",
      PATH: "/usr/bin",
      SHELL: "/bin/bash",
      TMPDIR: "/tmp",
      USER: "tester",
      ANTHROPIC_API_KEY: "sk-test-key",
      HTTPS_PROXY: "https://proxy.internal:8443",
      HTTP_PROXY: "http://proxy.internal:8080",
      NO_PROXY: "localhost,127.0.0.1",
      NODE_EXTRA_CA_CERTS: "/etc/ssl/internal-ca.pem",
      SSL_CERT_FILE: "/etc/ssl/internal-ca.pem",
      AWS_SECRET_ACCESS_KEY: "leaked-secret",
      GITHUB_TOKEN: "leaked-token",
      DATABASE_URL: "postgres://leaked"
    };
    const filtered = claudeCliSubprocessEnv(source);
    expect(filtered).toEqual({
      HOME: "/home/tester",
      PATH: "/usr/bin",
      SHELL: "/bin/bash",
      TMPDIR: "/tmp",
      USER: "tester",
      ANTHROPIC_API_KEY: "sk-test-key",
      HTTPS_PROXY: "https://proxy.internal:8443",
      HTTP_PROXY: "http://proxy.internal:8080",
      NO_PROXY: "localhost,127.0.0.1",
      NODE_EXTRA_CA_CERTS: "/etc/ssl/internal-ca.pem",
      SSL_CERT_FILE: "/etc/ssl/internal-ca.pem"
    });
    expect(filtered).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expect(filtered).not.toHaveProperty("GITHUB_TOKEN");
    expect(filtered).not.toHaveProperty("DATABASE_URL");
  });

  it("omits allowlisted keys that are unset rather than passing undefined", () => {
    const filtered = claudeCliSubprocessEnv({ HOME: "/home/tester" });
    expect(filtered).toEqual({ HOME: "/home/tester" });
    expect(Object.keys(filtered)).not.toContain("ANTHROPIC_API_KEY");
  });
});

describe("ClaudeCliProvider spawn env", () => {
  let scriptDir: string | undefined;

  afterEach(() => {
    if (scriptDir) rmSync(scriptDir, { recursive: true, force: true });
    scriptDir = undefined;
  });

  it("never exposes a planted secret env var to the spawned claude process", async () => {
    scriptDir = mkdtempSync(join(tmpdir(), "claude-cli-env-test-"));
    const scriptPath = join(scriptDir, "fake-claude.mjs");
    writeFileSync(
      scriptPath,
      [
        "#!/usr/bin/env node",
        "const result = {",
        "  type: 'result', subtype: 'success', is_error: false,",
        "  result: JSON.stringify(process.env),",
        "  stop_reason: 'end_turn', duration_ms: 1, total_cost_usd: 0,",
        "  usage: { input_tokens: 1, output_tokens: 1 }",
        "};",
        "process.stdout.write(JSON.stringify(result));"
      ].join("\n"),
      "utf8"
    );
    chmodSync(scriptPath, 0o755);

    const plantedEnv = { ...process.env, TOTALLY_FAKE_SECRET: "should-never-reach-child" };
    const originalEnv = process.env;
    process.env = plantedEnv as NodeJS.ProcessEnv;
    try {
      const providerWithScript = new ClaudeCliProvider({ binary: scriptPath, cwd: scriptDir });
      const result = await providerWithScript.complete(request);
      const childEnv = JSON.parse(result.text) as Record<string, string>;
      expect(childEnv.TOTALLY_FAKE_SECRET).toBeUndefined();
      expect(Object.keys(childEnv).sort()).toEqual(
        [...new Set(Object.keys(childEnv))].filter((key) =>
          (
            [
              "HOME",
              "PATH",
              "SHELL",
              "TMPDIR",
              "USER",
              "ANTHROPIC_API_KEY",
              "HTTPS_PROXY",
              "HTTP_PROXY",
              "NO_PROXY",
              "NODE_EXTRA_CA_CERTS",
              "SSL_CERT_FILE"
            ] as string[]
          ).includes(key)
        ).sort()
      );
    } finally {
      process.env = originalEnv;
    }
  });
});

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
