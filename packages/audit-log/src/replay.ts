import { auditEventSchema, type AuditEvent } from "@agent-control-stack/shared";

export function validateAuditReplay(events: AuditEvent[]): AuditEvent[] {
  return events.map((event) => auditEventSchema.parse(event));
}
