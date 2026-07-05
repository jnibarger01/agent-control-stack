import { describe, expect, it } from "vitest";
import { createEvent } from "./index.js";


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
});
