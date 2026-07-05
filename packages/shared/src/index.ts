import { randomUUID } from "node:crypto";
import { z } from "zod";

export const attributeValueSchema = z.union([z.string(), z.number(), z.boolean()]);
export const attributesSchema = z.record(z.string(), attributeValueSchema);
export const auditEventSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  timeUnixNano: z.string().regex(/^\d+$/),
  attributes: attributesSchema.default({}),
  body: z.record(z.string(), z.unknown()).default({})
});

export type AttributeValue = z.infer<typeof attributeValueSchema>;
export type AuditEvent = z.infer<typeof auditEventSchema>;

const sensitiveKeyPattern = /authorization|password|secret|token|api[-_]?key/i;

export function createId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function nowUnixNano(): string {
  return (BigInt(Date.now()) * 1_000_000n).toString();
}

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

export function createEvent(
  name: string,
  body: Record<string, unknown> = {},
  attributes: Record<string, AttributeValue> = {}
): AuditEvent {
  return auditEventSchema.parse({
    id: createId("evt"),
    name,
    timeUnixNano: nowUnixNano(),
    attributes,
    body: redactValue(body)
  });
}

export class ControlStackError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ControlStackError";
  }
}
