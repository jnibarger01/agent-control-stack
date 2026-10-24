const SENSITIVE_KEY =
  /secret|password|passwd|token|authorization|cookie|api[-_]?key|private[-_]?key|credential|stdout|stderr|^prompt$|env$/i;

const SENSITIVE_VALUE =
  /^(bearer\s+\S+|sk-[a-z0-9]{8,}|-----BEGIN [A-Z ]*PRIVATE)/i;

const JWT = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}/;

const MAX_DEPTH = 6;
const MAX_KEYS = 40;
const MAX_STRING = 240;

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

function redactString(value: string): string {
  if (SENSITIVE_VALUE.test(value) || JWT.test(value)) return "[redacted]";
  if (value.length > MAX_STRING) return `${value.slice(0, MAX_STRING)}…[truncated]`;
  return value;
}

export function containsSensitiveResidue(value: unknown): boolean {
  const text = JSON.stringify(value);
  return /\[redacted\]/.test(text)
    ? /Bearer\s+[A-Za-z0-9._~+/-]+=*|sk-[a-zA-Z0-9]{8,}|-----BEGIN |stdout|\/home\/jacen/.test(
        text.replaceAll("[redacted]", ""),
      )
    : /Bearer\s+[A-Za-z0-9._~+/-]+=*|sk-[a-zA-Z0-9]{8,}|-----BEGIN |\/home\/jacen/.test(text);
}
