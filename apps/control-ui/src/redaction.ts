/**
 * Display-side secret redaction for Mission Control.
 *
 * The same pattern table drives the server-rendered HTML and the inline client
 * script (serialized via `redactionClientSource`), so both render paths redact
 * identically. This is defense in depth for operator display only; it does not
 * replace keeping secrets out of audit attributes in the first place.
 */

/** [regex source, flags, replacement] applied in order to every displayed string. */
export const SECRET_VALUE_PATTERNS: ReadonlyArray<readonly [string, string, string]> = [
  [String.raw`Bearer\s+[A-Za-z0-9._~+/-]+=*`, "gi", "Bearer [redacted]"],
  [String.raw`\bsk-[A-Za-z0-9_-]{12,}`, "g", "[redacted]"],
  [String.raw`\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}`, "g", "[redacted]"],
  [String.raw`\bxox[abprs]-[A-Za-z0-9-]{10,}`, "g", "[redacted]"],
  [String.raw`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`, "g", "[redacted]"],
  [
    String.raw`([?&](?:token|access_token|refresh_token|key|api_key|apikey|secret|password|sig|signature)=)[^&\s"']+`,
    "gi",
    "$1[redacted]"
  ],
  // Bounded quantifiers, as in packages/shared/src/redact.ts: unbounded adjacent
  // classes gated on "://" / "@" backtrack catastrophically on long non-matches.
  [String.raw`(\b[A-Za-z][A-Za-z0-9+.-]{0,31}://[^\s/:@]{1,256}:)[^\s/@]{1,256}@`, "g", "$1[redacted]@"],
  [String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----`, "g", "[redacted]"],
  [String.raw`\b([A-Z0-9_]*(?:SECRET|TOKEN|API_KEY|PASSWORD)[A-Z0-9_]*=)[^\s&"']+`, "g", "$1[redacted]"]
];

/** Attribute keys whose values are always redacted, whatever their type. */
export const SECRET_KEY_PATTERN = String.raw`token|secret|passw(?:or)?d|authorization|cookie|credential|api[-_]?key|private[-_]?key`;

/** Token-count accounting keys that match SECRET_KEY_PATTERN but are not secrets (same list as packages/shared). */
export const NON_SECRET_KEY_PATTERN = String.raw`^(?:inputTokens|outputTokens|cacheReadInputTokens|cacheCreationInputTokens|maxTokens)$`;

const MAX_REDACTION_DEPTH = 8;

const compiledValuePatterns = SECRET_VALUE_PATTERNS.map(
  ([source, flags, replacement]) => [new RegExp(source, flags), replacement] as const
);
const compiledKeyPattern = new RegExp(SECRET_KEY_PATTERN, "i");
const compiledNonSecretKeyPattern = new RegExp(NON_SECRET_KEY_PATTERN, "i");

export function redactSecrets(value: unknown): string {
  let text = String(value ?? "");
  for (const [pattern, replacement] of compiledValuePatterns) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

export function isSecretAttributeKey(key: string): boolean {
  return compiledKeyPattern.test(key) && !compiledNonSecretKeyPattern.test(key);
}

/** Deep-copies `value`, redacting secret-looking strings and secret-named keys. */
export function redactAttributes(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= MAX_REDACTION_DEPTH) return "[truncated]";
  if (Array.isArray(value)) return value.map((entry) => redactAttributes(entry, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = isSecretAttributeKey(key) && entry != null ? "[redacted]" : redactAttributes(entry, depth + 1);
  }
  return out;
}

/** JSON string of redacted attributes, for single-line display. */
export function redactedAttributesJson(value: unknown): string {
  return JSON.stringify(redactAttributes(value ?? {})) ?? "";
}

function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** Client-script definitions of `redactClient`, `redactAttributesClient`, and `redactedAttributesJsonClient`. */
export function redactionClientSource(): string {
  return `
const redactionValuePatterns = ${scriptSafeJson(SECRET_VALUE_PATTERNS)}.map(function (entry) {
  return [new RegExp(entry[0], entry[1]), entry[2]];
});
const redactionKeyPattern = new RegExp(${scriptSafeJson(SECRET_KEY_PATTERN)}, 'i');
const redactionNonSecretKeyPattern = new RegExp(${scriptSafeJson(NON_SECRET_KEY_PATTERN)}, 'i');
function redactClient(value) {
  let text = String(value ?? '');
  redactionValuePatterns.forEach(function (entry) { text = text.replace(entry[0], entry[1]); });
  return text;
}
function redactAttributesClient(value, depth) {
  const level = depth || 0;
  if (typeof value === 'string') return redactClient(value);
  if (value === null || typeof value !== 'object') return value;
  if (level >= ${MAX_REDACTION_DEPTH}) return '[truncated]';
  if (Array.isArray(value)) return value.map(function (entry) { return redactAttributesClient(entry, level + 1); });
  const out = {};
  Object.keys(value).forEach(function (key) {
    const entry = value[key];
    out[key] = redactionKeyPattern.test(key) && !redactionNonSecretKeyPattern.test(key) && entry != null
      ? '[redacted]'
      : redactAttributesClient(entry, level + 1);
  });
  return out;
}
function redactedAttributesJsonClient(value) {
  return JSON.stringify(redactAttributesClient(value ?? {})) ?? '';
}
`;
}
