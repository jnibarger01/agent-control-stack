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

describe("browser grant scope: lookalike hosts and application names (S1)", () => {
  it("rejects trailing-dot, non-ASCII and punycode-equivalent raw Unicode origins", () => {
    for (const origin of [
      "https://app.example.",
      "https://app.example.:8443",
      "https://bücher.example",
      "https://аpp.example",
      "https://APP.example",
      "https://app.example:443"
    ])
      expect(parse({ ...browser, allowedOrigins: [origin] }), origin).toBe(false);
    for (const origin of ["https://app.example:8443", "http://127.0.0.1:3000", "https://xn--bcher-kva.example"])
      expect(parse({ ...browser, allowedOrigins: [origin] }), origin).toBe(true);
  });

  it("rejects non-ASCII (Unicode lookalike) application names and keeps rejecting globs", () => {
    for (const application of [
      "Сhrome",
      "Chrome\u200b",
      "Ｃhrome",
      "Chrome*",
      "Chr?me",
      "[Cc]hrome",
      "{a,b}",
      "My App"
    ])
      expect(parse({ ...browser, allowedApplications: [application] }), application).toBe(false);
    for (const application of ["Chrome", "Google-Chrome.app", "com.google.Chrome"])
      expect(parse({ ...browser, allowedApplications: [application] }), application).toBe(true);
  });
});
