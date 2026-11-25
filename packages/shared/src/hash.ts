import { createHash } from "node:crypto";

export function stableHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

// v1 is frozen byte-for-byte (docs/migrations/canonical-hash.md).
// prettier-ignore
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

/*
 * Canonical JSON v2. Specified in docs/migrations/canonical-hash.md.
 * v1 above is unchanged. v2 is locale-independent, orders keys by code point,
 * and throws on any value it cannot encode exactly (fail closed) instead of
 * silently normalizing it.
 */

/** Versioned prefix hashed before the canonical JSON, so v1 and v2 digests never collide. */
export const CANONICAL_V2_PREFIX = "acs-canonical-json/v2\n";

const SHORT_ESCAPES: Readonly<Record<number, string>> = {
  0x08: "\\b",
  0x09: "\\t",
  0x0a: "\\n",
  0x0c: "\\f",
  0x0d: "\\r"
};

export function stableHashV2(value: unknown): string {
  return createHash("sha256")
    .update(CANONICAL_V2_PREFIX + canonicalJsonV2(value), "utf8")
    .digest("hex");
}

export function domainHashV2(domain: string, value: unknown): string {
  if (!/^[a-z0-9][a-z0-9:._-]{0,127}$/i.test(domain)) {
    throw new TypeError("hash domain must be a bounded non-empty identifier");
  }
  return createHash("sha256")
    .update(`${CANONICAL_V2_PREFIX}${domain}\n${canonicalJsonV2(value)}`, "utf8")
    .digest("hex");
}

/** Throws TypeError for values outside the v2 domain. Top-level `undefined` is rejected. */
export function canonicalJsonV2(value: unknown): string {
  if (value === undefined) throw new TypeError("canonical v2 has no encoding for undefined");
  return encodeV2(value, "$");
}

function encodeV2(value: unknown, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return quoteV2(value, path);
    case "number":
      if (!Number.isSafeInteger(value)) {
        throw new TypeError(`canonical v2 accepts only safe integers at ${path}`);
      }
      return String(value);
    case "object":
      return Array.isArray(value) ? encodeArrayV2(value, path) : encodeObjectV2(value, path);
    default:
      throw new TypeError(`canonical v2 cannot encode ${typeof value} at ${path}`);
  }
}

function encodeArrayV2(value: unknown[], path: string): string {
  const entries = Array.from(value, (entry, index) =>
    // Holes and undefined entries become null, as in v1.
    entry === undefined ? "null" : encodeV2(entry, `${path}[${index}]`)
  );
  return `[${entries.join(",")}]`;
}

function encodeObjectV2(value: object, path: string): string {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`canonical v2 encodes only plain objects at ${path}`);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort(compareCodePoints);
  const members = keys.map(
    (key) => `${quoteV2(key, `${path}.<key>`)}:${encodeV2(record[key], `${path}.${JSON.stringify(key)}`)}`
  );
  return `{${members.join(",")}}`;
}

/** Ordered by Unicode code point. Not UTF-16 code unit order, which differs above U+FFFF. */
function compareCodePoints(left: string, right: string): number {
  const a = left[Symbol.iterator]();
  const b = right[Symbol.iterator]();
  for (;;) {
    const x = a.next();
    const y = b.next();
    if (x.done || y.done) return x.done === y.done ? 0 : x.done ? -1 : 1;
    const delta = x.value.codePointAt(0)! - y.value.codePointAt(0)!;
    if (delta !== 0) return delta;
  }
}

/** JSON string encoding, matching ECMAScript QuoteJSONString for well-formed text. */
function quoteV2(text: string, path: string): string {
  let out = '"';
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) {
      throw new TypeError(`canonical v2 requires well-formed Unicode at ${path}`);
    }
    if (character === '"') out += '\\"';
    else if (character === "\\") out += "\\\\";
    else if (code < 0x20) out += SHORT_ESCAPES[code] ?? `\\u${code.toString(16).padStart(4, "0")}`;
    else out += character;
  }
  return `${out}"`;
}
