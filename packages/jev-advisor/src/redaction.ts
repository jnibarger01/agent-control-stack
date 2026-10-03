const MAX_STATE_STRING = 8_192;
const MAX_SERIALIZED_STATE = 12_000;
const MAX_ENTRY_STRING = 1_024;
const MAX_DEPTH = 6;
const MAX_COLLECTION = 32;

const SECRET_KEY =
  /(?:password|passwd|secret|credential|authorization|bearer|api[_-]?key|private[_-]?key|capability[_-]?token|approval[_-]?token|token)/i;
const ARGV_KEY = /^(?:argv|args|command_args)$/i;

const TEXT_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi,
  /\b(?:sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{5,}\b/g,
  /\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*[^\s,;"']{4,}/gi
];

export function redactJevText(value: string, maxLength = MAX_STATE_STRING): string {
  let output = String(value);
  for (const pattern of TEXT_PATTERNS) output = output.replace(pattern, "[REDACTED]");
  return output.slice(0, maxLength);
}
function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return "[TRUNCATED:depth]";
  if (typeof value === "string") return redactJevText(value, MAX_ENTRY_STRING);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.slice(0, MAX_COLLECTION).map((entry) => sanitizeValue(entry, depth + 1));
  if (!value || typeof value !== "object") return String(value).slice(0, MAX_ENTRY_STRING);

  const output: Record<string, unknown> = {};
  for (const [rawKey, entry] of Object.entries(value).slice(0, MAX_COLLECTION)) {
    const key = redactJevText(rawKey, 128);
    if (ARGV_KEY.test(key)) {
      output[key] = "[REDACTED:argv]";
      continue;
    }
    if (SECRET_KEY.test(key)) {
      output[key] = "[REDACTED]";
      continue;
    }
    output[key] = sanitizeValue(entry, depth + 1);
  }
  return output;
}
/**
 * Prepare advisory state before it is sent to Jev.
 * This transformation is deterministic, bounded, and contains no model logic.
 */
export function prepareJevState(state: string | object): string | object {
  if (typeof state === "string") return redactJevText(state);
  const sanitized = sanitizeValue(state, 0);
  const serialized = JSON.stringify(sanitized);
  if (serialized.length <= MAX_SERIALIZED_STATE && sanitized && typeof sanitized === "object") {
    return sanitized as object;
  }
  return redactJevText(serialized, MAX_SERIALIZED_STATE);
}
