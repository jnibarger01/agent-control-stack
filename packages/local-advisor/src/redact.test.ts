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

  // Hardening cases from the R/V redaction harness, rebuilt with runtime fixtures.
  const pw = fill(14);
  const hardening: readonly { name: string; input: string; secret: string }[] = [
    { name: "JSON password key", input: cat('{"pass', 'word": "', pw, '"}'), secret: pw },
    { name: "JSON access_token key", input: cat('{"access', '_token":"', pw, '"}'), secret: pw },
    { name: "percent-encoded password=", input: cat("user=a&pass", "word%3D", pw), secret: pw },
    { name: "percent-encoded token:", input: cat("tok", "en%3a", pw), secret: pw },
    { name: "client_secret assignment", input: cat("client", "_secret=", pw), secret: pw },
    { name: "passphrase assignment", input: cat("pass", "phrase=", pw), secret: pw },
    { name: "YAML value on the next line", input: cat("pass", "word:\n  ", pw), secret: pw },
    { name: "short assignment value", input: cat("pass", "word=", fill(5)), secret: fill(5) },
    { name: "upper-case key", input: cat("PASS", "WORD=", pw), secret: pw },
    {
      name: "lower-case basic auth",
      input: cat("authorization: ", "bas", "ic ", b64(cat("u:", pw))),
      secret: b64(cat("u:", pw)).slice(0, 16)
    },
    {
      name: "upper-case BASIC auth",
      input: cat("Authorization: ", "BAS", "IC ", b64(cat("u:", pw))),
      secret: b64(cat("u:", pw)).slice(0, 16)
    },
    { name: "lower-case bearer", input: cat("authorization: ", "bea", "rer ", fill(22)), secret: fill(22) },
    { name: "bearer under 16 chars", input: cat("Authorization: ", "Bea", "rer ", fill(15)), secret: fill(15) },
    { name: "url_password with empty username", input: cat("redis", "://:", pw, "@db:6379"), secret: pw },
    { name: "url_password containing @", input: cat("postgres", "://admin:", "p@", pw, "@db/app"), secret: pw },
    { name: "url_password with upper-case scheme", input: cat("POSTGRES", "://admin:", pw, "@db/app"), secret: pw },
    {
      name: "url_password url-encoded",
      input: cat("postgres", "://admin:", fill(4), "%40", pw, "@db/app"),
      secret: pw
    },
    { name: "npm token of exactly 36", input: cat("np", "m_", fill(36)), secret: fill(36) },
    { name: "npm token longer than 36", input: cat("np", "m_", fill(37)), secret: fill(36) },
    { name: "upper-case NPM_ prefix", input: cat("NP", "M_", fill(36)), secret: fill(36) },
    { name: "C:\\Users\\<u> home path", input: cat("C:\\Users\\", "jdoe", "\\x"), secret: "jdoe" },
    { name: "/Users/<u> home path", input: cat("/Users/", "jdoe", "/x"), secret: "jdoe" },
    { name: "/root home path", input: cat("/ro", "ot/.ssh/id_rsa"), secret: cat("/ro", "ot/.ssh") },
    { name: "lower-case PEM header", input: cat("-----begin rsa ", "private ", "key-----\n", pw), secret: pw },
    { name: "PEM with no type", input: cat(pem(""), "\n", pw), secret: pw },
    { name: "aws key in lower case", input: cat("ak", "ia", fill(16).toLowerCase()), secret: fill(16).toLowerCase() },
    {
      name: "aws key embedded in a word",
      input: cat("x", "AK", "IA", fill(16).toUpperCase()),
      secret: fill(16).toUpperCase()
    },
    { name: "upper-case GHP_ prefix", input: cat("GH", "P_", fill(36)), secret: fill(36) },
    { name: "35-char ghs_ token", input: cat("gh", "s_", fill(35)), secret: fill(35) },
    { name: "github token wrapped across lines", input: cat("gh", "p_", fill(18), "\n", fill(18)), secret: fill(18) },
    { name: "upper-case XOXB- token", input: cat("XO", "XB-", "1234567890-", fill(12)), secret: fill(12) },
    { name: "upper-case GLPAT- token", input: cat("GL", "PAT-", fill(20)), secret: fill(20) },
    { name: "upper-case SK- key", input: cat("S", "K-", fill(26)), secret: fill(26) },
    {
      name: "JWT with a short signature",
      input: ((t) => cat(t.split(".").slice(0, 2).join("."), ".", fill(7)))(jwt()),
      secret: jwt().split(".")[1]!
    },
    {
      name: "base64 wrapped across lines",
      input: b64(cat("gh", "p_", fill(36))).replace(/(.{20})/gu, "$1\n"),
      secret: b64(cat("gh", "p_", fill(36))).slice(0, 20)
    },
    {
      name: "base64 wrapped with CRLF",
      input: b64(cat("gh", "p_", fill(36))).replace(/(.{16})/gu, "$1\r\n"),
      secret: b64(cat("gh", "p_", fill(36))).slice(16, 32)
    },
    {
      name: "base64-wrapped github token",
      input: b64(cat("gh", "p_", fill(36))),
      secret: b64(cat("gh", "p_", fill(36)))
    },
    { name: "zero-width split github token", input: cat("gh", "p_", fill(10), "\u200b", fill(26)), secret: fill(26) },
    {
      name: "full-width AWS prefix",
      input: cat(String.fromCodePoint(0xff21, 0xff2b, 0xff29, 0xff21), fill(16).toUpperCase()),
      secret: fill(16).toUpperCase()
    }
  ];

  for (const testCase of hardening) {
    it(`redacts ${testCase.name}`, () => {
      expect(redactText(testCase.input).text).not.toContain(testCase.secret);
    });
  }

  it("keeps ordinary prose and code that merely mentions credential words", () => {
    const text = "Rotate the token after review. const base = new URL(input); /usr/local/bin is not a home path.";
    expect(redactText(text)).toEqual({ text, counts: {} });
  });

  it.each([
    ["long letter run", () => "a".repeat(200_000)],
    ["scheme-like run without @", () => "Ab3+".repeat(50_000)],
    ["unterminated quoted value", () => cat("pass", 'word = "', "a b ".repeat(50_000))],
    ["repeated key words", () => "token".repeat(40_000)],
    ["url with no @", () => cat("postgres", "://a:", "b".repeat(200_000))],
    ["jwt-like run without dots", () => cat("ey", "J-").repeat(50_000)],
    ["scheme-like run of jwt prefixes", () => cat("ey", "J_").repeat(50_000)],
    ["long base64 run", () => "QUJD".repeat(50_000)]
  ])("stays linear on adversarial input: %s", (_name, build) => {
    const input = build();
    const started = performance.now();
    redactText(input);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("redacts a 64 KiB jwt-like run without quadratic backtracking", () => {
    const input = cat("ey", "J-").repeat(16_384);
    const started = performance.now();
    redactText(input);
    // Was ~2.5 s before jwt matching was anchored to the start of a token run and taken in a single pass.
    expect(performance.now() - started).toBeLessThan(250);
  });

  describe("jwt with an oversized segment", () => {
    // A 5 KB payload segment: a per-segment length cap once let such a token leak whole.
    const bigJwt = () =>
      [
        b64url(JSON.stringify({ alg: "HS256", typ: "JWT" })),
        b64url(JSON.stringify({ sub: fill(5_000) })),
        fill(22)
      ].join(".");
    const contexts: [string, (t: string) => string][] = [
      ["bare", (t) => t],
      ["JSON id_token", (t) => cat('{"id', '_token":"', t, '"}')],
      ["Cookie session=", (t) => cat("Cookie: session=", t, "; Path=/")],
      ["?access_token=", (t) => cat("https://example.test/cb?access", "_token=", t, "&state=1")]
    ];
    it.each(contexts)("redacts every segment in full: %s", (_name, wrap) => {
      const token = bigJwt();
      const [header, payload, signature] = token.split(".") as [string, string, string];
      const { text } = redactText(wrap(token));
      for (const segment of [header, payload, signature]) expect(text).not.toContain(segment.slice(-24));
      expect(text).not.toContain(payload.slice(4_096, 4_120));
      expect(text).toMatch(/\[REDACTED:(?:jwt|assignment)\]/u);
    });
  });

  it("redacts a jwt that directly follows a hyphen", () => {
    const token = jwt();
    const { text, counts } = redactText(cat("id-", token));
    expect(text).toBe("id-[REDACTED:jwt]");
    expect(counts.jwt).toBe(1);
  });

  it("redacts the full assignment value, not just a prefix", () => {
    const value = fill(600);
    for (const input of [cat("pass", "word=", value), cat('{"pass', 'word": "', value, '"}')]) {
      const { text } = redactText(input);
      expect(text).not.toContain(value.slice(-32));
      expect(text).toContain("[REDACTED:assignment]");
    }
  });

  it("redacts both of two jwts glued together without a separator", () => {
    const first = jwt();
    const second = [b64url(JSON.stringify({ alg: "none" })), b64url(JSON.stringify({ sub: fill(12) })), fill(30)].join(
      "."
    );
    const { text, counts } = redactText(cat(first, second));
    expect(text).toBe("[REDACTED:jwt][REDACTED:jwt]");
    expect(counts.jwt).toBe(2);
  });
});
