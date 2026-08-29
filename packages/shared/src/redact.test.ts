import { describe, expect, it } from "vitest";
import { createEvent } from "./index.js";
import { collectSensitiveJsonValuesFromText, collectSensitiveValues, redactValue } from "./redact.js";

describe("audit redaction", () => {
  it("redacts sensitive body values and attributes before events are stored", () => {
    const event = createEvent(
      "policy.decided",
      {
        output: "Authorization: Bearer abcdefghijklmnop",
        nested: { apiKey: "should-not-persist" }
      },
      {
        "http.authorization": "Bearer abcdefghijklmnop",
        safe: "ok"
      }
    );

    expect(event.body.output).toBe("[redacted]");
    expect(event.body.nested).toMatchObject({ apiKey: "[redacted]" });
    expect(event.attributes["http.authorization"]).toBe("[redacted]");
    expect(event.attributes.safe).toBe("ok");
  });

  it("collects task-supplied secrets and redacts them inside persisted prose", () => {
    const taskPayload = {
      operation: "fetch",
      token: "secret-token",
      password: "hunter2",
      nested: { apiKey: "sample-api-key" }
    };
    const secrets = collectSensitiveValues(taskPayload);
    expect(secrets).toEqual(["hunter2", "sample-api-key", "secret-token"]);
    expect(
      redactValue(
        { observed: "Replaced secret-token and hunter2; sample-api-key was also removed." },
        secrets
      )
    ).toEqual({ observed: "Replaced [redacted] and [redacted]; [redacted] was also removed." });
  });

  it("extracts sensitive values from embedded JSON followed by punctuation", () => {
    expect(
      collectSensitiveJsonValuesFromText(
        'Rewrite safely: {"operation":"fetch","token":"secret-token","password":"hunter2"}.'
      )
    ).toEqual(["hunter2", "secret-token"]);
  });

  it("preserves token accounting fields and repeated non-cyclic references", () => {
    const usage = { inputTokens: 10, outputTokens: 4, cacheReadInputTokens: 2, cacheCreationInputTokens: 3 };
    expect(redactValue({ maxTokens: 100, first: usage, second: usage })).toEqual({
      maxTokens: 100,
      first: usage,
      second: usage
    });
  });

  it("still terminates actual object cycles", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(redactValue(cyclic)).toEqual({ self: "[circular]" });
  });

  it("redacts a long, non-matching string in linear time instead of hanging on catastrophic regex backtracking", () => {
    // A large non-matching string (e.g. captured command stdout with no
    // ":"/"@" anywhere) previously drove the URL-credentials pattern's
    // twin unbounded quantifiers into quadratic-to-exponential
    // backtracking. This must stay fast regardless of input size.
    const huge = "x".repeat(2_000_000);
    const start = Date.now();
    const result = redactValue(huge);
    expect(Date.now() - start).toBeLessThan(2_000);
    expect(result).toBe(huge);
  });

  it("still redacts a real URL credential and a Bearer token after bounding the redaction pattern's quantifiers", () => {
    expect(redactValue("connect to https://user:pass@example.com/path")).toBe("[redacted]");
    expect(redactValue("Authorization: Bearer sk-abcDEF1234567890abcdefghijklmnop")).toBe("[redacted]");
  });
});
