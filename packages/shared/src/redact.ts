const sensitiveKeyPattern = /authorization|password|secret|token|api[-_]?key/i;
const nonSecretTokenMetricKeyPattern =
  /^(?:inputTokens|outputTokens|cacheReadInputTokens|cacheCreationInputTokens|maxTokens)$/i;
const sensitiveValuePattern =
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*\b|\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]+\b|\bsk-[A-Za-z0-9_-]{20,}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----|[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@|(?:^|\n)[A-Z0-9_]*(?:SECRET|TOKEN|API_KEY|PASSWORD)[A-Z0-9_]*=[^\s]+/i;

export function redactValue(value: unknown, explicitSecrets: readonly string[] = []): unknown {
  const ancestors = new WeakSet<object>();
  const replacements = [...new Set(explicitSecrets.filter((secret) => secret.length > 0))]
    .sort((left, right) => right.length - left.length);

  function walk(key: string, input: unknown): unknown {
    if (isSensitiveKey(key)) {
      return "[redacted]";
    }

    if (input && typeof input === "object") {
      if (ancestors.has(input)) return "[circular]";
      ancestors.add(input);
      const redacted = Array.isArray(input)
        ? input.map((entry) => walk("", entry))
        : Object.fromEntries(
            Object.entries(input as Record<string, unknown>).map(([entryKey, entryValue]) => [
              entryKey,
              walk(entryKey, entryValue)
            ])
          );
      ancestors.delete(input);
      return redacted;
    }

    if (typeof input === "string") {
      const explicitlyRedacted = replacements.reduce(
        (text, secret) => text.replaceAll(secret, "[redacted]"),
        input
      );
      if (sensitiveValuePattern.test(explicitlyRedacted)) return "[redacted]";
      return explicitlyRedacted;
    }

    return input;
  }

  return walk("", value);
}

export function collectSensitiveValues(value: unknown): string[] {
  const values = new Set<string>();
  const seen = new WeakSet<object>();

  function walk(key: string, input: unknown): void {
    if (isSensitiveKey(key)) {
      collectStrings(input, values);
      return;
    }
    if (input && typeof input === "object") {
      if (seen.has(input)) return;
      seen.add(input);
      if (Array.isArray(input)) {
        for (const entry of input) walk("", entry);
      } else {
        for (const [entryKey, entryValue] of Object.entries(input as Record<string, unknown>)) {
          walk(entryKey, entryValue);
        }
      }
    }
  }

  walk("", value);
  return [...values].sort();
}

export function collectSensitiveJsonValuesFromText(text: string): string[] {
  const objectStart = text.indexOf("{");
  const objectEnd = text.lastIndexOf("}");
  if (objectStart < 0 || objectEnd <= objectStart) return [];
  try {
    return collectSensitiveValues(JSON.parse(text.slice(objectStart, objectEnd + 1)) as unknown);
  } catch {
    return [];
  }
}

function isSensitiveKey(key: string): boolean {
  return sensitiveKeyPattern.test(key) && !nonSecretTokenMetricKeyPattern.test(key);
}

function collectStrings(value: unknown, values: Set<string>): void {
  if (typeof value === "string" && value.length > 0) {
    values.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, values);
    return;
  }
  if (value && typeof value === "object") {
    for (const entry of Object.values(value as Record<string, unknown>)) collectStrings(entry, values);
  }
}
