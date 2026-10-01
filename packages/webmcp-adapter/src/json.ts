/**
 * JSON value boundary.
 *
 * CDP is driven with `returnByValue: true`, so everything crossing the browser
 * boundary must be a JSON value. `assertJsonValue` proves that before any value
 * is hashed, persisted, or returned to an MCP caller.
 */
import { WebMcpError, WebMcpErrorCode } from "./contracts.js";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 32) return false;
  if (value === null) return true;
  const type = typeof value;
  if (type === "string") return (value as string).length <= 262_144;
  if (type === "boolean") return true;
  if (type === "number") return Number.isFinite(value as number);
  if (Array.isArray(value)) return value.length <= 4_096 && value.every((item) => isJsonValue(item, depth + 1));
  if (type === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    return keys.length <= 4_096 && keys.every((key) => isJsonValue(record[key], depth + 1));
  }
  return false;
}

export function assertJsonValue(value: unknown, what = "value"): JsonValue {
  if (!isJsonValue(value)) {
    throw new WebMcpError(WebMcpErrorCode.ResultInvalid, `${what} must be a JSON value`);
  }
  return value;
}
