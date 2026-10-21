import { createHash } from "node:crypto";

/**
 * Package-local canonical JSON with code-unit key order. `@agent-control-stack/shared` sorts keys with `localeCompare`,
 * which depends on the process locale and ICU build; these hashes are persisted and recomputed by other processes, so
 * they must not. Changing the shared canonicalizer would alter existing audit-chain hashes, so it is deliberately left
 * alone. `undefined`, non-finite numbers, bigint, functions and symbols are refused instead of coerced.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw new TypeError("canonical: non-finite number");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) return `[${value.map((entry) => canonicalize(entry)).join(",")}]`;
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`;
    }
    default:
      throw new TypeError(`canonical: unsupported value of type ${typeof value}`);
  }
}

/** sha256 over a domain-separated canonical form. */
export function outcomeHash(domain: string, value: unknown): string {
  if (!/^[a-z][a-z0-9_.-]{0,63}$/u.test(domain))
    throw new TypeError("outcome hash domain must be a bounded identifier");
  return createHash("sha256")
    .update(`acs.outcome.v1:${domain}\n${canonicalize(value)}`)
    .digest("hex");
}
