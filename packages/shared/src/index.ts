import { randomUUID } from "node:crypto";
import { auditEventSchema, type AttributeValue, type AuditEvent } from "./schema.js";
import { redactValue } from "./redact.js";

export * from "./hash.js";
export * from "./audit-chain.js";
export * from "./database-health.js";
export * from "./database-backup-policy.js";
export * from "./database-operations.js";
export * from "./migration.js";
export * from "./redact.js";
export * from "./schema.js";
export * from "./strict-canonical-v1.js";

export function createId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function nowUnixNano(): string {
  return (BigInt(Date.now()) * 1_000_000n).toString();
}

export function createEvent(
  name: string,
  body: Record<string, unknown> = {},
  attributes: Record<string, AttributeValue> = {}
): AuditEvent {
  const redactedAttributes = redactValue(attributes) as Record<string, AttributeValue>;
  return auditEventSchema.parse({
    id: createId("evt"),
    name,
    timeUnixNano: nowUnixNano(),
    attributes: redactedAttributes,
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
