import { describe, expect, it } from "vitest";
import { redactText } from "./redact.js";

describe("redactText", () => {
  it("removes common credential shapes and counts them", () => {
    const input = [
      "-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----",
      "aws AKIAABCDEFGHIJKLMNOP",
      "gh ghp_" + "x".repeat(36),
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
});
