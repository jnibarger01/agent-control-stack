import { createHash, randomBytes } from "node:crypto";

export function sha256Ref(text: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/** Deterministic JSON (sorted keys) so the same logical input always hashes the same way. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(",")}}`;
}

export function randomNonce(): string {
  return randomBytes(12).toString("hex");
}

/**
 * Nonce-bounded wrapper for untrusted text. The random nonce means a payload cannot predict the closing marker, and
 * any literal marker-like sequence inside the content is defanged.
 */
export function fenceUntrusted(text: string, nonce: string): string {
  const defanged = text.replace(/<{3}/gu, "< < <");
  return `<<<UNTRUSTED nonce=${nonce}>>>\n${defanged}\n<<<END_UNTRUSTED nonce=${nonce}>>>`;
}
