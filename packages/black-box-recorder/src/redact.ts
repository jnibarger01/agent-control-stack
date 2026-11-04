const SENSITIVE_KEY =
  /secret|password|passwd|token|authorization|cookie|api[-_]?key|private[-_]?key|credential|stdout|stderr|^prompt$|env$|hmac[-_]?(key|secret)?$|^(seed|passphrase|jwt|session|sid|auth|bearer)$/i;

const SENSITIVE_VALUE = /^(bearer\s+\S+|sk-[a-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE)/i;

const JWT = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}/;

const MAX_DEPTH = 6;
const MAX_KEYS = 40;
const MAX_STRING = 240;
const REDACT_WINDOW = 4096;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[truncated-depth]";
  if (value == null) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_KEYS).map((item) => redact(item, depth + 1));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).slice(0, MAX_KEYS)) {
      const raw = (value as Record<string, unknown>)[key];
      out[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : redact(raw, depth + 1);
    }
    return out;
  }
  return null;
}

/** Redacts a single identity or reference field with the same rules as metadata. Null stays null. */
export function redactField(value: string | null | undefined): string | null {
  if (value == null) return null;
  return redactString(value);
}

// Embedded shapes are replaced in place so the surrounding text stays useful.
// Bare hex/base64 digests are NOT matched by shape (they are indistinguishable from sha256
// hashes the provenance chain must keep); those are covered by key name above.
const EMBEDDED: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[redacted]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]"],
  [/\b(ACS_[A-Z0-9_]+)(["']?\s*[=:]\s*["']?)[^\s"',;}]+/g, "$1$2[redacted]"],
  [/(:\/\/)[^/\s:@]+:[^/\s@]+@/g, "$1[redacted]@"],
  [/\b(set-cookie|cookie)\s*:\s*[^\r\n]+/gi, "$1: [redacted]"],
  [/[\w.-]{1,64}=[^;\s]{1,512}(?=;\s*(?:Path|Domain|Expires|Max-Age|HttpOnly|Secure|SameSite)\b)/gi, "[redacted]"],
  [/\b(?:ghp|gho|ghs|ghu|github_pat)_[A-Za-z0-9_]{16,}/g, "[redacted]"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "[redacted]"],
  [/MC4CAQAwBQYDK2VwBCIEI[A-Za-z0-9+/_=-]{16,}/g, "[redacted]"]
];

export function redactString(value: string): string {
  if (SENSITIVE_VALUE.test(value) || JWT.test(value)) return "[redacted]";
  // Bound regex work (ReDoS): only MAX_STRING chars are ever emitted, so redact a bounded window
  // that is larger than the emitted prefix, then truncate. A secret straddling the cut is redacted first.
  const truncated = value.length > REDACT_WINDOW;
  if (truncated) value = value.slice(0, REDACT_WINDOW);
  for (const [pattern, replacement] of EMBEDDED) value = value.replace(pattern, replacement);
  if (truncated && value.length <= MAX_STRING) return `${value}…[truncated]`;
  if (value.length > MAX_STRING) return `${value.slice(0, MAX_STRING)}…[truncated]`;
  return value;
}

export function containsSensitiveResidue(value: unknown): boolean {
  const text = JSON.stringify(value);
  return /\[redacted\]/.test(text)
    ? /Bearer\s+[A-Za-z0-9._~+/-]+=*|sk-[a-zA-Z0-9_-]{8,}|-----BEGIN |stdout|\/home\/jacen/.test(
        text.replaceAll("[redacted]", "")
      )
    : /Bearer\s+[A-Za-z0-9._~+/-]+=*|sk-[a-zA-Z0-9_-]{8,}|-----BEGIN |\/home\/jacen/.test(text);
}
