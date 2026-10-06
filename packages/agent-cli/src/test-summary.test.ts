import { describe, expect, it } from "vitest";
import { summarizeTestFailure, truncateAtWord } from "./test-summary.js";

const failed = (output: string) => summarizeTestFailure(output, "failed");

describe("summarizeTestFailure", () => {
  it("skips hook banners and keeps the host of upgrade links instead of cutting a URL", () => {
    const result = failed(
      [
        "hook: SessionStart Completed",
        "ERROR: You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 9:58 AM."
      ].join("\n")
    );
    expect(result.kind).toBe("usage_limit");
    expect(result.summary).not.toMatch(/hook:|https?:|ERROR/u);
    expect(result.summary).toContain("usage limit");
    expect(result.summary).toContain("9:58 AM");
  });

  it("joins a reset time printed on its own line", () => {
    const result = failed(
      "Provider said: HTTP 429: The usage limit has been reached\n\n\nLimit resets at 09:58 (in 1h 14m)."
    );
    expect(result).toEqual({
      kind: "usage_limit",
      summary: "Provider said: HTTP 429: The usage limit has been reached. Limit resets at 09:58 (in 1h 14m)."
    });
  });

  it("reads Antigravity's quota error and ignores its JSON duplicate", () => {
    const result = failed(
      'error: Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 76h10m26s.\nAGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED"}'
    );
    expect(result.kind).toBe("usage_limit");
    expect(result.summary).toMatch(/^Individual quota reached/u);
    expect(result.summary).not.toContain("AGY_ERROR");
  });

  it("uses a sole structured diagnostic and ignores partial assistant text", () => {
    const diagnostic = 'AGY_ERROR: {"canonical_status":"RESOURCE_EXHAUSTED","http_status":429}';
    expect(failed(diagnostic).kind).toBe("usage_limit");
    expect(failed(`Here is a partial answer\n${diagnostic}`).summary).toContain("RESOURCE_EXHAUSTED");
    expect(failed('AGY_ERROR: {"message":"Authentication failed","http_status":401}').kind).toBe("auth");
  });

  it("never exposes structured metadata or malformed records", () => {
    expect(failed('AGY_ERROR: {"message":"Model failed","token":"do-not-expose","stack":"private-path"}').summary).toBe(
      "Model failed"
    );
    expect(failed('AGY_ERROR: {"message":"token=do-not-expose"}').summary).not.toContain("do-not-expose");
    expect(failed("AGY_ERROR: {invalid secret=do-not-expose").summary).toBe(
      "Antigravity returned an unreadable error diagnostic."
    );
    expect(failed("AGY_ERROR: []").kind).toBe("error");
  });

  it("classifies sign-in failures and strips the provider URL path", () => {
    expect(failed("error: cline requires re-authentication.")).toEqual({
      kind: "auth",
      summary: "cline requires re-authentication."
    });
    const goose = failed(
      "Ran into this error: Authentication error: Authentication failed for https://api.router.tetrate.ai/v1/chat/completions. Status: 401 Unauthorized."
    );
    expect(goose.kind).toBe("auth");
    expect(goose.summary).toBe(
      "Authentication error: Authentication failed for api.router.tetrate.ai. Status: 401 Unauthorized."
    );
  });

  it("never shows a stack frame or file path", () => {
    const result = failed(
      [
        "IneligibleTierError: Gemini Code Assist for individuals is no longer supported.",
        "    at throwIneligibleOrProjectIdError (file:///home/u/.cellar/gemini-cli/lib/node_modules/x.js:12:9)"
      ].join("\n")
    );
    expect(result.kind).toBe("ineligible");
    expect(result.summary).not.toMatch(/\bat \w|file:/u);
  });

  it("covers timeouts, silence and unclassified errors", () => {
    expect(summarizeTestFailure("anything", "timed_out").kind).toBe("timeout");
    expect(summarizeTestFailure("anything", "cancelled").kind).toBe("cancelled");
    expect(failed("\n  \n").kind).toBe("no_reply");
    expect(failed("starting\nsomething exploded: Error code 7\nbye")).toEqual({
      kind: "error",
      summary: "something exploded: Error code 7"
    });
  });

  it("truncates on a word boundary with an ellipsis", () => {
    const cut = truncateAtWord("alpha ".repeat(60), 40);
    expect(cut.length).toBeLessThanOrEqual(40);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut).not.toMatch(/alph…$/u);
  });
});
