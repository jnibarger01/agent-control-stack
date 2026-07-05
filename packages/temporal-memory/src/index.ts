import { createEvent, createId, type AuditEvent } from "@agent-control-stack/shared";
import { z } from "zod";

export const memoryRecordSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  content: z.string().min(1),
  validFrom: z.string().min(1),
  tags: z.array(z.string()).default([])
});

export const createMemoryRecordSchema = memoryRecordSchema.omit({ id: true, validFrom: true }).extend({
  validFrom: z.string().min(1).optional()
});

export type MemoryRecord = z.infer<typeof memoryRecordSchema>;

export function memoryRecordedEvent(input: unknown): AuditEvent {
  const parsed = createMemoryRecordSchema.parse(input);
  const record: MemoryRecord = {
    id: createId("mem"),
    source: parsed.source,
    content: parsed.content,
    validFrom: parsed.validFrom ?? new Date().toISOString(),
    tags: parsed.tags
  };

  return createEvent("memory.recorded", record, { "memory.source": record.source });
}

export function projectMemories(events: AuditEvent[]): MemoryRecord[] {
  return events
    .filter((event) => event.name === "memory.recorded")
    .map((event) => memoryRecordSchema.safeParse(event.body))
    .filter((result) => result.success)
    .map((result) => result.data)
    .sort((left, right) => left.validFrom.localeCompare(right.validFrom));
}
