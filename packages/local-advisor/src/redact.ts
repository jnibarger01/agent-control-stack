/**
 * Best-effort credential redaction applied to evidence BEFORE it is hashed, sent to a model, or recorded.
 * Redaction is defense in depth; callers must still avoid sending secrets in evidence.
 *
 * Input is NFKC-normalized and stripped of invisible format characters first, so full-width or zero-width
 * variants cannot slip a credential past the ASCII patterns. Base64 blobs that decode to a credential are
 * redacted as a whole.
 */
// Every quantifier that can run over a near-total character class is bounded: unbounded adjacent quantifiers
// gated on a literal that a long input never contains backtrack quadratically (see packages/shared/src/redact.ts).
// The key suffix is matched atomically (lookahead + backreference): its class is disjoint from what follows, so
// backtracking into it can never help and only costs time on long word runs.
const KEY = String.raw`(?:api[_-]?key|secret|token|passphrase|passw(?:or)?d|auth)(?=([\w-]{0,64}))\2`;

const PATTERNS: readonly { readonly name: string; readonly pattern: RegExp; readonly replace: string }[] = [
  {
    name: "private_key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/giu,
    replace: "[REDACTED:private_key]"
  },
  { name: "aws_access_key", pattern: /(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Z])/giu, replace: "[REDACTED:aws_key]" },
  { name: "github_pat", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/giu, replace: "[REDACTED:github_token]" },
  {
    // A token wrapped across lines is still one token.
    name: "github_token",
    pattern: /\bgh[pousr]_(?=(?:[A-Za-z0-9]|\r?\n){20,})(?:[A-Za-z0-9]|\r?\n(?=[A-Za-z0-9]))+/giu,
    replace: "[REDACTED:github_token]"
  },
  { name: "slack_refresh_token", pattern: /\bxoxe\.xox[a-z]-[A-Za-z0-9-]{10,}/giu, replace: "[REDACTED:slack_token]" },
  { name: "slack_token", pattern: /\bxox[a-z]-[A-Za-z0-9-]{10,}/giu, replace: "[REDACTED:slack_token]" },
  { name: "gitlab_token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}/giu, replace: "[REDACTED:gitlab_token]" },
  { name: "npm_token", pattern: /\bnpm_[A-Za-z0-9]{36,}/giu, replace: "[REDACTED:npm_token]" },
  { name: "google_api_key", pattern: /\bAIza[0-9A-Za-z_-]{35}/gu, replace: "[REDACTED:google_api_key]" },
  {
    // The signature segment may be short or truncated; header and payload alone are enough to redact.
    name: "jwt",
    // Starts only at the beginning of a token run and bounds every segment, so a long run of segment characters with
    // no '.' (e.g. "eyJ-" repeated) is scanned once instead of once per "eyJ" (quadratic backtracking).
    pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{0,4096}/gu,
    replace: "[REDACTED:jwt]"
  },
  {
    // The username may be empty and the password may itself contain '@', so match up to the last '@'.
    name: "url_password",
    pattern: /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]{0,31}:\/\/[^\s:/@]{0,256}:)[^\s/?#]{1,256}@/giu,
    replace: "$1[REDACTED:url_password]@"
  },
  { name: "basic_auth", pattern: /\b(Basic)\s+[A-Za-z0-9+/]{8,}=*/giu, replace: "$1 [REDACTED:basic_auth]" },
  { name: "bearer", pattern: /\b(Bearer)\s+[A-Za-z0-9._~+/-]{8,}=*/giu, replace: "$1 [REDACTED:bearer]" },
  { name: "provider_key", pattern: /\b(?:sk|pk)-[A-Za-z0-9_-]{20,}/giu, replace: "[REDACTED:api_key]" },
  {
    // Keys may be JSON-quoted ({"password": "..."}); quoted values may contain spaces.
    name: "quoted_assignment",
    pattern: new RegExp(String.raw`(${KEY}["']?[ \t]{0,16}(?:[:=]|%3[ad])\s{0,16})(["'])[^"'\n]{1,256}\3`, "giu"),
    replace: "$1$3[REDACTED:assignment]$3"
  },
  {
    // `%3D` / `%3A` cover percent-encoded query strings and form bodies (password%3D...).
    name: "assignment",
    pattern: new RegExp(String.raw`(${KEY}["']?[ \t]{0,16}(?:[:=]|%3[ad])\s{0,16})(["']?)[^\s"',;]{4,256}\3`, "giu"),
    replace: "$1$3[REDACTED:assignment]$3"
  },
  { name: "home_path", pattern: /(?:\/home|\/Users)\/[^/\s]+/gu, replace: "~" },
  { name: "home_path", pattern: /\b[A-Za-z]:\\Users\\[^\\\s]+/giu, replace: "~" },
  { name: "home_path", pattern: /(?<![\w.~-])\/root(?=\/|\s|$)/gu, replace: "~" }
];

const INVISIBLE = /[\u00AD\u200B-\u200F\u2060-\u2064\uFEFF]/gu;
// A blob may be wrapped across lines (PEM/MIME style); lines are rejoined before decoding.
const BASE64_BLOB = /[A-Za-z0-9+/_-]{16,}(?:\r?\n[A-Za-z0-9+/_-]+)*={0,2}/gu;
const MIN_BASE64_CHARS = 24;

export interface RedactionResult {
  readonly text: string;
  /** Count of replacements per pattern name, so telemetry can say "1 secret redacted" without the secret. */
  readonly counts: Readonly<Record<string, number>>;
}

function applyPatterns(input: string, counts: Record<string, number>): string {
  let text = input;
  for (const { name, pattern, replace } of PATTERNS) {
    const matches = text.match(pattern)?.length ?? 0;
    if (matches > 0) {
      counts[name] = (counts[name] ?? 0) + matches;
      text = text.replace(pattern, replace);
    }
  }
  return text;
}

/** Cheap gate: decoded text without any credential marker cannot match a pattern, so skip the full pattern pass. */
const CREDENTIAL_HINT =
  /-----BEGIN|AKIA|ASIA|gh[pousr]_|github_pat_|xox|glpat-|npm_|AIza|eyJ|:\/\/|basic|bearer|sk-|pk-|api|secret|token|pass|auth|\/home|\/Users|\\Users|\/root/iu;

/** True when `blob` decodes to printable text that itself contains a credential. */
function decodeBase64(blob: string): string {
  return Buffer.from(
    blob
      .replace(/[\r\n]/gu, "")
      .replace(/-/gu, "+")
      .replace(/_/gu, "/"),
    "base64"
  ).toString("utf8");
}

function base64HidesSecret(blob: string): boolean {
  // Probe a short aligned prefix first: a huge binary blob is rejected without decoding all of it.
  if (blob.length > 4096) {
    const probe = decodeBase64(blob.replace(/[\r\n]/gu, "").slice(0, 4096));
    if (probe.includes("\uFFFD") || probe.replace(/[^\x20-\x7E\t\r\n]/gu, "").length / probe.length < 0.95)
      return false;
  }
  const decoded = decodeBase64(blob);
  if (decoded.length < 8 || decoded.includes("\uFFFD")) return false;
  const printable = decoded.replace(/[^\x20-\x7E\t\r\n]/gu, "").length;
  if (printable / decoded.length < 0.95) return false;
  if (!CREDENTIAL_HINT.test(decoded.normalize("NFKC"))) return false;
  return applyPatterns(decoded.normalize("NFKC"), {}) !== decoded.normalize("NFKC");
}

export function redactText(input: string): RedactionResult {
  const counts: Record<string, number> = {};
  let text = applyPatterns(input.normalize("NFKC").replace(INVISIBLE, ""), counts);
  text = text.replace(BASE64_BLOB, (blob) => {
    if (blob.replace(/[\r\n=]/gu, "").length < MIN_BASE64_CHARS || !base64HidesSecret(blob)) return blob;
    counts.base64_secret = (counts.base64_secret ?? 0) + 1;
    return "[REDACTED:base64_secret]";
  });
  return { text, counts };
}
