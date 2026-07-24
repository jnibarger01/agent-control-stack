import { createHash } from "node:crypto";

export const STRICT_CANONICAL_SHA256_V1_DOMAIN =
  "agent-control-stack/strict-canonical-json/sha256/v1" as const;

export function strictCanonicalJsonV1(value: unknown): string {
  return serializeV1(value, new WeakSet<object>());
}

export function strictCanonicalSha256V1(value: unknown): string {
  return createHash("sha256")
    .update(STRICT_CANONICAL_SHA256_V1_DOMAIN, "utf8")
    .update("\0", "utf8")
    .update(strictCanonicalJsonV1(value), "utf8")
    .digest("hex");
}

function serializeV1(value: unknown, ancestors: WeakSet<object>): string {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "string":
      return encodePrimitiveV1(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError("strict-canonical-v1: non-finite number is unsupported");
      }
      return encodePrimitiveV1(value);
    case "undefined":
      throw new TypeError("strict-canonical-v1: undefined is unsupported");
    case "bigint":
      throw new TypeError("strict-canonical-v1: bigint is unsupported");
    case "symbol":
    case "function":
      throw new TypeError(`strict-canonical-v1: unsupported type ${typeof value}`);
    case "object":
      return Array.isArray(value)
        ? serializeArrayV1(value, ancestors)
        : serializeObjectV1(value, ancestors);
  }

  throw new TypeError(`strict-canonical-v1: unsupported type ${typeof value}`);
}

function serializeArrayV1(value: unknown[], ancestors: WeakSet<object>): string {
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError("strict-canonical-v1: non-plain object is unsupported");
  }
  if (ancestors.has(value)) {
    throw new TypeError("strict-canonical-v1: cyclic input is unsupported");
  }

  for (const key of Reflect.ownKeys(value)) {
    if (key === "length") {
      continue;
    }
    if (typeof key !== "string" || !isArrayIndexV1(key, value.length)) {
      throw new TypeError("strict-canonical-v1: unsupported array property");
    }
  }

  ancestors.add(value);
  try {
    const serialized = new Array<string>(value.length);
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined) {
        throw new TypeError("strict-canonical-v1: undefined array entry is unsupported");
      }
      if (!("value" in descriptor)) {
        throw new TypeError("strict-canonical-v1: unsupported accessor property");
      }
      serialized[index] = serializeV1(descriptor.value, ancestors);
    }
    return `[${serialized.join(",")}]`;
  } finally {
    ancestors.delete(value);
  }
}

function serializeObjectV1(value: object, ancestors: WeakSet<object>): string {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("strict-canonical-v1: non-plain object is unsupported");
  }
  if (ancestors.has(value)) {
    throw new TypeError("strict-canonical-v1: cyclic input is unsupported");
  }

  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key === "symbol")) {
    throw new TypeError("strict-canonical-v1: unsupported symbol property");
  }

  ancestors.add(value);
  try {
    const serialized: string[] = [];
    for (const key of (keys as string[]).sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable) {
        throw new TypeError("strict-canonical-v1: unsupported non-enumerable property");
      }
      if (!("value" in descriptor)) {
        throw new TypeError("strict-canonical-v1: unsupported accessor property");
      }
      serialized.push(`${encodePrimitiveV1(key)}:${serializeV1(descriptor.value, ancestors)}`);
    }
    return `{${serialized.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function encodePrimitiveV1(value: string | number): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) {
    throw new TypeError("strict-canonical-v1: unsupported type");
  }
  return encoded;
}

function isArrayIndexV1(key: string, length: number): boolean {
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < length && String(index) === key;
}
