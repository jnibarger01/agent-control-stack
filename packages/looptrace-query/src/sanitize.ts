import { redactValue } from "@agent-control-stack/shared";

/**
 * Everything that originates in an evidence source is UNTRUSTED DATA.
 * It is redacted, bounded, stripped of control characters, and placed only in the
 * `untrusted` field of an evidence event. It is never interpreted, never executed,
 * and never allowed to influence a verdict (only structured, typed fields do).
 */

export const SANITIZE_LIMITS = {
  maxDepth: 4,
  maxKeys: 32,
  maxArray: 16,
  maxString: 400,
  maxKeyLength: 64
} as const;

// Secret-ish key names (superset of shared redactValue) unless the key clearly names a digest.
const SECRET_KEY =
  /(secret|token|passw|authorization|cookie|credential|private[_-]?key|api[_-]?key|bearer|signature|nonce|session[_-]?key|access[_-]?key|client[_-]?secret)/iu;
const DIGEST_KEY = /(?:_|^)(?:hash|sha256|digest)$|(?:Hash|Sha256|Digest)$/u;

// Instruction-like content that must be flagged (not obeyed). Detection is advisory only.
const INJECTION_PATTERNS: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,40}\b(?:previous|prior|above|earlier|all)\b[^.\n]{0,30}\b(?:instruction|prompt|rule|polic)/iu,
  /\b(?:you are now|new instructions?|system prompt|developer message)\b/iu,
  /<\/?(?:system|assistant|tool|instructions?)>/iu,
  /\b(?:mark|report|return|declare)\b[^.\n]{0,40}\b(?:verified|pass(?:ed)?|success(?:ful)?|healthy)\b/iu,
  /\b(?:call|invoke|run|execute)\b[^.\n]{0,30}\b(?:tool|command|shell|curl|rm\s+-rf)\b/iu
];

function containsInjection(value: unknown, depth: number): boolean {
  if (depth > SANITIZE_LIMITS.maxDepth + 2) return false;
  if (typeof value === "string") return looksLikeInjection(stripControl(value.slice(0, SANITIZE_LIMITS.maxString * 8)));
  if (Array.isArray(value)) return value.slice(0, SANITIZE_LIMITS.maxArray).some((v) => containsInjection(v, depth + 1));
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>)
      .slice(0, SANITIZE_LIMITS.maxKeys)
      .some((v) => containsInjection(v, depth + 1));
  }
  return false;
}

export interface Sanitized {
  value: unknown;
  flags: string[];
}

function stripControl(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    // Collapse C0/C1 controls and bidi/zero-width controls to a space.
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || (code >= 0x200b && code <= 0x200f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) {
      out += " ";
    } else {
      out += ch;
    }
  }
  return out.replace(/ {2,}/gu, " ");
}

export function looksLikeInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((pattern) => pattern.test(text));
}

export function sanitizeUntrusted(input: unknown): Sanitized {
  const flags = new Set<string>();
  // Injection detection runs on the ORIGINAL text: redaction may replace a whole string that also
  // carries an instruction, and that instruction must still be flagged.
  if (containsInjection(input, 0)) flags.add("injection_suspected");
  const pre = redactValue(input);
  if (JSON.stringify(pre) !== JSON.stringify(input)) flags.add("redacted");

  const seen = new WeakSet<object>();
  function walk(key: string, value: unknown, depth: number): unknown {
    if (key && SECRET_KEY.test(key) && !DIGEST_KEY.test(key)) {
      flags.add("redacted");
      return "[redacted]";
    }
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "string") {
      let text = stripControl(value);
      if (looksLikeInjection(text)) flags.add("injection_suspected");
      if (text.length > SANITIZE_LIMITS.maxString) {
        flags.add("truncated");
        text = `${text.slice(0, SANITIZE_LIMITS.maxString)}...[truncated ${text.length - SANITIZE_LIMITS.maxString}]`;
      }
      return text;
    }
    if (typeof value !== "object" || value === undefined) return null;
    if (seen.has(value)) return "[circular]";
    if (depth >= SANITIZE_LIMITS.maxDepth) {
      flags.add("truncated");
      return "[depth-limit]";
    }
    seen.add(value);
    let out: unknown;
    if (Array.isArray(value)) {
      if (value.length > SANITIZE_LIMITS.maxArray) flags.add("truncated");
      out = value.slice(0, SANITIZE_LIMITS.maxArray).map((entry) => walk("", entry, depth + 1));
    } else {
      const entries = Object.entries(value as Record<string, unknown>);
      if (entries.length > SANITIZE_LIMITS.maxKeys) flags.add("truncated");
      const result: Record<string, unknown> = {};
      for (const [k, v] of entries.slice(0, SANITIZE_LIMITS.maxKeys)) {
        const safeKey = stripControl(k).slice(0, SANITIZE_LIMITS.maxKeyLength);
        if (looksLikeInjection(safeKey)) flags.add("injection_suspected");
        result[safeKey] = walk(safeKey, v, depth + 1);
      }
      out = result;
    }
    seen.delete(value);
    return out;
  }

  return { value: walk("", pre, 0), flags: [...flags].sort() };
}

/** Sanitises a flat map of source-supplied attributes (non-objects are dropped). */
export function sanitizeAttributes(input: Record<string, unknown>): { attrs: Record<string, unknown>; flags: string[] } {
  const { value, flags } = sanitizeUntrusted(input);
  const attrs = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return { attrs, flags };
}

/** Free text from a source (summaries, errors) reduced to a bounded, single-line string. */
export function sanitizeText(text: unknown, max: number = SANITIZE_LIMITS.maxString): { text: string; flags: string[] } {
  const raw = typeof text === "string" ? text : "";
  const { value, flags } = sanitizeUntrusted(raw.length > max * 4 ? raw.slice(0, max * 4) : raw);
  let out = typeof value === "string" ? value : "";
  if (out.length > max) out = `${out.slice(0, max)}...[truncated]`;
  return { text: out, flags };
}
