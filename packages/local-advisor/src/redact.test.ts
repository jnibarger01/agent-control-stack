import { describe, expect, it } from "vitest";
import { redactText } from "./redact.js";

describe("redactText", () => {
  it("removes common credential shapes and counts them", () => {
    const input = [
      "-----BEGIN RSA " + "PRIVATE KEY-----\nMIIB\n-----END RSA " + "PRIVATE KEY-----",
      "aws " + "AKIA" + "ABCDEFGHIJKLMNOP",
      "gh " + "ghp" + "_" + "x".repeat(36),
      "Authorization: Bearer abcdefghijklmnopqrstuv",
      "password=hunter22secret",
      "api_key: 'supersecretvalue'"
    ].join("\n");
    const result = redactText(input);
    expect(result.text).not.toMatch(/AKIA|ghp_x|hunter22|supersecretvalue|MIIB/u);
    expect(result.counts.private_key).toBe(1);
    expect(result.counts.aws_access_key).toBe(1);
    expect(result.counts.github_token).toBe(1);
  });

  it("leaves ordinary code and text untouched", () => {
    const text = "export function add(a: number, b: number) { return a + b; }";
    expect(redactText(text)).toEqual({ text, counts: {} });
  });

  // Fixtures are assembled at runtime so secret scanners do not flag the test source.
  const cases: readonly { name: string; input: string; secret: string; count: string }[] = [
    { name: "DB URL with password", input: "postgres" + "://admin:" + "s3cr3tPass" + "@db.internal:5432/app", secret: "s3cr3tPass", count: "url_password" },
    {
      name: "JWT",
      input: "jwt " + "eyJ" + "hbGciOiJIUzI1NiJ9" + "." + "eyJzdWIiOiIxMjM0NTY3ODkwIn0" + "." + "SflKxwRJSMeKKF2QT4fwpM",
      secret: "SflKxwRJSMeKKF2QT4fwpM",
      count: "jwt"
    },
    { name: "Google AIza key", input: "key " + "AIza" + "Sy" + "A".repeat(33), secret: "Sy" + "A".repeat(33), count: "google_api_key" },
    { name: "github_pat_ token", input: "github" + "_pat_" + "11ABCDEFG" + "0".repeat(20), secret: "11ABCDEFG", count: "github_pat" },
    { name: "Authorization: Basic", input: "Authorization: " + "Basic " + "dXNlcjpwYXNzd29yZA==", secret: "dXNlcjpwYXNzd29yZA", count: "basic_auth" },
    { name: "quoted password with spaces", input: "password = " + '"has space ' + 'secret"', secret: "has space", count: "quoted_assignment" },
    { name: "glpat- token", input: "gl" + "pat-" + "abcdefghij1234567890", secret: "abcdefghij1234567890", count: "gitlab_token" },
    { name: "npm_ token", input: "npm" + "_" + "a1".repeat(18), secret: "a1".repeat(18), count: "npm_token" },
    {
      name: "private key with no END line",
      input: "-----BEGIN OPENSSH " + "PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAA\ntruncated",
      secret: "b3BlbnNzaC1rZXktdjEAAAA",
      count: "private_key"
    },
    { name: "/home/<user>/.ssh path", input: "cat /home/" + "jdoe/.ssh/id_ed25519", secret: "jdoe", count: "home_path" },
    {
      name: "full xoxe. token",
      input: "refresh " + "xoxe" + ".xoxp-" + "1-Mi0yLTEyMzQ1Njc4OTAx",
      secret: "Mi0yLTEyMzQ1Njc4OTAx",
      count: "slack_refresh_token"
    }
  ];

  for (const testCase of cases) {
    it(`redacts ${testCase.name}`, () => {
      const result = redactText(testCase.input);
      expect(result.text).not.toContain(testCase.secret);
      expect(result.counts[testCase.count]).toBeGreaterThanOrEqual(1);
    });
  }
});
