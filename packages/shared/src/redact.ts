const sensitiveKeyPattern = /authorization|password|secret|token|api[-_]?key/i;

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

    return input;
  }

  return walk("", value);
}
