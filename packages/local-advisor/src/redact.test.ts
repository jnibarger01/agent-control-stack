import { describe, expect, it } from "vitest";
import { redactText } from "./redact.js";

// Every credential-shaped fixture is assembled at runtime so no secret-looking literal ever lands in source or history.
const cat = (...parts: string[]) => parts.join("");
const ALPHABET = "Qx7Lm2Rt9Kp4VwZc";
const fill = (n: number) => Array.from({ length: n }, (_, i) => ALPHABET[(i * 5 + 3) % ALPHABET.length]).join("");
const b64 = (text: string) => Buffer.from(text, "utf8").toString("base64");
const b64url = (text: string) => Buffer.from(text, "utf8").toString("base64url");
const jwt = () =>
  [b64url(JSON.stringify({ alg: "HS256", typ: "JWT" })), b64url(JSON.stringify({ sub: "fixture" })), fill(22)].join(
    "."
  );
const pem = (kind: string) => cat("-----BEGIN ", kind, "PRIVATE ", "KEY-----");
const pemEnd = (kind: string) => cat("-----END ", kind, "PRIVATE ", "KEY-----");

describe("redactText", () => {
  it("removes common credential shapes and counts them", () => {
    const keyBody = fill(12);
    const aws = cat("AK", "IA", fill(16).toUpperCase());
    const gh = cat("gh", "p_", fill(36));
    const bearer = fill(22);
    const pw = fill(14);
    const apiKey = fill(16);
    const input = [
      cat(pem("RSA "), "\n", keyBody, "\n", pemEnd("RSA ")),
      cat("aws ", aws),
      cat("gh ", gh),
      cat("Authorization: ", "Bea", "rer ", bearer),
      cat("pass", "word=", pw),
      cat("api", "_key: '", apiKey, "'")
    ].join("\n");
    const result = redactText(input);
    for (const secret of [keyBody, aws, gh, bearer, pw, apiKey]) expect(result.text).not.toContain(secret);
    expect(result.counts.private_key).toBe(1);
    expect(result.counts.aws_access_key).toBe(1);
    expect(result.counts.github_token).toBe(1);
  });

  it("leaves ordinary code and text untouched", () => {
    const text = "export function add(a: number, b: number) { return a + b; }";
    expect(redactText(text)).toEqual({ text, counts: {} });
  });

  const cases: readonly { name: string; input: () => [string, string]; count: string }[] = [
    {
      name: "DB URL with password",
      count: "url_password",
      input: () => ((s) => [cat("postgres", "://admin:", s, "@db.internal:5432/app"), s])(fill(12))
    },
    { name: "JWT", count: "jwt", input: () => ((t) => [cat("jwt ", t), t])(jwt()) },
    {
      name: "Google AIza key",
      count: "google_api_key",
      input: () => ((s) => [cat("key ", "AI", "za", s), s])(fill(35))
    },
    { name: "github_pat_ token", count: "github_pat", input: () => ((s) => [cat("github", "_pat_", s), s])(fill(40)) },
    {
      name: "Authorization: Basic",
      count: "basic_auth",
      input: () =>
        ((s) => [cat("Authorization: ", "Bas", "ic ", s), s.replace(/=+$/u, "")])(b64(cat("user:", fill(10))))
    },
    {
      name: "quoted password with spaces",
      count: "quoted_assignment",
      input: () => ((s) => [cat("pass", 'word = "', s, '"'), s])(cat(fill(6), " ", fill(8)))
    },
    { name: "glpat- token", count: "gitlab_token", input: () => ((s) => [cat("gl", "pat-", s), s])(fill(20)) },
    { name: "npm_ token", count: "npm_token", input: () => ((s) => [cat("np", "m_", s), s])(fill(36)) },
    {
      name: "private key with no END line",
      count: "private_key",
      input: () => ((s) => [cat(pem("OPENSSH "), "\n", s, "\ntruncated"), s])(fill(24))
    },
    {
      name: "/home/<user>/.ssh path",
      count: "home_path",
      input: () => [cat("cat /home/", "jdoe", "/.ssh/id_ed25519"), "jdoe"]
    },
    {
      name: "full xoxe. token",
      count: "slack_refresh_token",
      input: () => ((s) => [cat("refresh ", "xo", "xe.", "xo", "xp-1-", s), s])(fill(20))
    }
  ];

  for (const testCase of cases) {
    it(`redacts ${testCase.name}`, () => {
      const [input, secret] = testCase.input();
      const result = redactText(input);
      expect(result.text).not.toContain(secret);
      expect(result.counts[testCase.count]).toBeGreaterThanOrEqual(1);
    });
  }
});
