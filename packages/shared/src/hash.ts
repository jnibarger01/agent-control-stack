import { createHash } from "node:crypto";

export function stableHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function domainHash(domain: string, value: unknown): string {
  if (!/^[a-z0-9][a-z0-9:._-]{0,127}$/i.test(domain)) {
    throw new TypeError("hash domain must be a bounded non-empty identifier");
  }
  return createHash("sha256").update(`${domain}\n${canonicalJson(value)}`).digest("hex");
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value)) ?? "undefined";
}

function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => (entry === undefined ? null : normalizeJson(entry)));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalizeJson(entry)])
    );
  }
  return value;
}
