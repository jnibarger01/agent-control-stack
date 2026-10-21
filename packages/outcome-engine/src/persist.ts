import { redactValue } from "@agent-control-stack/shared";
import { canonicalize, outcomeHash } from "./canonical.js";

/**
 * The audit store runs `redactValue` over every body before it is written, so a string that looks like a token comes
 * back as "[redacted]" and any hash computed over the unredacted form would stop matching. Every record is therefore
 * brought to its one persisted form BEFORE hashing, and write time asserts that the store's redaction is a no-op on it.
 */
export function safeText(value: string): string {
  return redactValue(value) === value
    ? value
    : `[unrepresentable:${outcomeHash("unrepresentable", value).slice(0, 12)}]`;
}

/** Replaces every string leaf the store would redact with a stable placeholder. Keys are never rewritten. */
export function sanitizeDeep<T>(value: T): T {
  if (typeof value === "string") return safeText(value) as T;
  if (Array.isArray(value)) return value.map((entry) => sanitizeDeep(entry)) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, sanitizeDeep(entry)])) as T;
  }
  return value;
}

/** True when the audit store's redaction would leave `body` unchanged, so recomputed hashes match the stored form. */
export function isRepresentable(body: unknown): boolean {
  return canonicalize(redactValue(body)) === canonicalize(body);
}

export function assertRepresentable(body: unknown, what: string): void {
  if (!isRepresentable(body)) {
    throw new Error(
      `${what} contains a value or key the audit store would redact; refusing to persist a record whose hashes could not be recomputed`
    );
  }
}
