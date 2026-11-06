import { describe, expect, test } from "vitest";
import { redact, redactString } from "./redact.js";

// Every value below is synthetic. SYNTH marks the part that must never survive redaction.
const SHAPES: Record<string, string> = {
  "embedded bearer header": "curl -H 'Authorization: Bearer SYNTHtok_abcdef123456' https://x.example",
  "ACS_* env assignment": "ACS_GATEWAY_TOKEN=SYNTHacs_0123456789abcdef0123456789",
  "ACS_* json member": '{"ACS_OAUTH_CLIENT_SECRET":"SYNTHsecretvalue123456"}',
  "credentialed url": "https://alice:SYNTHpw123@host.example/path",
  "cookie with attributes": "session=SYNTHcookie1234567890; Path=/; HttpOnly",
  "set-cookie header": "Set-Cookie: sid=SYNTHcookie1234567890",
  "ed25519 pkcs8 base64": "MC4CAQAwBQYDK2VwBCIEIFAKESYNTHkeymaterial0123456789abcdef",
  "github token": "ghp_SYNTH0123456789abcdefghijklmnopqrst",
  "inline pem": "key: -----BEGIN PRIVATE KEY-----\nSYNTHbody\n-----END PRIVATE KEY-----"
};

describe("recorder redaction: embedded secret shapes never reach output", () => {
  for (const [name, value] of Object.entries(SHAPES)) {
    test(`${name} under a neutral key, nested key and array`, () => {
      const out = JSON.stringify(redact({ note: value, detail: { text: value }, list: [value] }));
      expect(out).not.toContain("SYNTH");
      expect(redactString(value)).not.toContain("SYNTH");
    });
  }

  test("key material is redacted by key name (hmac key, seed, passphrase, jwt, session, auth)", () => {
    for (const key of ["hmacKey", "hmac_secret", "seed", "passphrase", "jwt", "session", "sid", "auth", "bearer"]) {
      const out = JSON.stringify(redact({ [key]: "SYNTHvalue123456789" }));
      expect(out, key).not.toContain("SYNTH");
    }
  });

  test("pathological long inputs stay linear-time", () => {
    const started = Date.now();
    for (const filler of ["x", "a=", "a=b;", " ", "-----BEGIN PRIVATE KEY-----"]) redactString(filler.repeat(200_000));
    expect(Date.now() - started).toBeLessThan(1500);
  });

  test("a secret straddling the truncation boundary is redacted before truncating", () => {
    const out = redactString(`${"p".repeat(232)} Bearer SYNTHtok_abcdef123456 ${"q".repeat(500)}`);
    expect(out).not.toContain("SYNTH");
    expect(out).not.toContain("tok_abc");
  });

  test("does not over-redact: ids, hashes and public signatures survive", () => {
    const sha = "0123456789abcdef".repeat(4);
    const out = redact({
      sessionId: "sess-42",
      sha256: sha,
      signature: "c2lnbmF0dXJl",
      url: "https://host.example/a?b=1",
      note: "Bearer of news"
    }) as Record<string, unknown>;
    expect(out.sessionId).toBe("sess-42");
    expect(out.sha256).toBe(sha);
    expect(out.signature).toBe("c2lnbmF0dXJl");
    expect(out.url).toBe("https://host.example/a?b=1");
  });
});
