import { describe, expect, it } from "vitest";
import { autonomousAuthorityDefinitionSchema } from "./autonomous-authority.js";

const base = {
  executingActorId: "actor",
  scope: [{ kind: "path", id: "/tmp/x", coverage: "exact" }],
  maximumPrivileges: ["fs.read"],
  expiresAt: "2099-01-01T00:00:00.000Z",
  limits: { maxOperations: 1, maxRuntimeMs: 1000, maxParallelOperations: 1, maxAttemptsPerOperation: 1 }
};
const browser = {
  runtime: "browser",
  toolName: "cua",
  allowedOrigins: ["https://app.example"],
  allowedApplications: ["browser"]
};
const parse = (tool: unknown) =>
  autonomousAuthorityDefinitionSchema.safeParse({ ...base, toolClasses: [tool] }).success;

describe("R2: browser runtime in the authority schema", () => {
  it("accepts a scoped browser grant alongside jc and dc", () => {
    expect(
      autonomousAuthorityDefinitionSchema.safeParse({
        ...base,
        toolClasses: [
          browser,
          { runtime: "jace_commander", toolName: "read_file" },
          { runtime: "desktop_commander", toolName: "read_file" }
        ]
      }).success
    ).toBe(true);
  });

  it("requires explicit, exact, non-empty origin and application scope", () => {
    expect(parse({ runtime: "browser", toolName: "cua" })).toBe(false);
    expect(parse({ ...browser, allowedOrigins: [] })).toBe(false);
    expect(parse({ ...browser, allowedApplications: [] })).toBe(false);
    for (const origin of [
      "*",
      "https://*.example",
      "https://app.example/",
      "https://app.example/path",
      "javascript:alert(1)",
      "file:///etc",
      "https://u:p@app.example",
      "ftp://app.example"
    ])
      expect(parse({ ...browser, allowedOrigins: [origin] }), origin).toBe(false);
    expect(parse({ ...browser, allowedOrigins: ["https://app.example", "https://app.example"] })).toBe(false);
    expect(parse({ ...browser, allowedApplications: ["browser", "browser"] })).toBe(false);
  });

  it("is strict: no unknown fields, no other tool name, no browser scope on commander runtimes", () => {
    expect(parse({ ...browser, extra: true })).toBe(false);
    expect(parse({ ...browser, toolName: "anything" })).toBe(false);
    expect(parse({ runtime: "jace_commander", toolName: "read_file", allowedOrigins: ["https://app.example"] })).toBe(
      false
    );
    expect(parse({ runtime: "mcp", toolName: "x" })).toBe(false);
  });

  it("rejects wildcard, glob-like, whitespace and empty application names", () => {
    for (const application of [
      "*",
      "app*",
      "a?p",
      "[ab]",
      "app]",
      "{a,b}",
      "a}",
      " app",
      "my app",
      "app\t",
      "app\n",
      ""
    ])
      expect(parse({ ...browser, allowedApplications: [application] }), JSON.stringify(application)).toBe(false);
    expect(parse({ ...browser, allowedApplications: ["browser", "browser-profile-2", "chrome.work"] })).toBe(true);
  });
});
