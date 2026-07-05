const sensitiveKeyPattern = /authorization|password|secret|token|api[-_]?key/i;
const sensitiveValuePattern = /\bBearer\s+[A-Za-z0-9._~+/-]+=*\b|\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]+\b|[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@/i;

export function redactValue(value: unknown): unknown {
  const seen = new WeakSet<object>();

  function walk(key: string, input: unknown): unknown {
    if (sensitiveKeyPattern.test(key)) {
      return "[redacted]";
    }

    if (Array.isArray(input)) {
      return input.map((entry) => walk("", entry));
    }

    if (input && typeof input === "object") {
      if (seen.has(input)) {
        return "[circular]";
      }
      seen.add(input);
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>).map(([entryKey, entryValue]) => [
          entryKey,
          walk(entryKey, entryValue)
        ])
      );
    }

    if (typeof input === "string" && sensitiveValuePattern.test(input)) {
      return "[redacted]";
    }

    return input;
  }

  return walk("", value);
}
