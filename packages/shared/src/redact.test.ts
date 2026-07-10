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
});
