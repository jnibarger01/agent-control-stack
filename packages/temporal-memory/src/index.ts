import { stableHash } from "@agent-control-stack/shared";
import { createEvent, createId, type AuditEvent } from "@agent-control-stack/shared";
import { z } from "zod";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const timestampSchema = z.string().datetime({ offset: true }).max(64);

export const memorySourceTypeSchema = z.enum(["audit_event", "file", "user_message", "tool_result"]);

export const memoryRecordSchema = z
  .object({
    id: z.string().min(1),
    claim: z.string().min(1),
    sourceType: memorySourceTypeSchema,
    sourceId: z.string().min(1),
    sourceHash: hashSchema,
    validFrom: timestampSchema,
    validUntil: timestampSchema.optional(),
    confidence: z.number().min(0).max(1),
    tags: z.array(z.string().min(1)).max(64),
    invalidatedAt: timestampSchema.optional()
  })
  .strict();

const legacyMemoryRecordSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  content: z.string().min(1),
  validFrom: z.string().min(1),
  tags: z.array(z.string()).default([])
});

export const createMemoryRecordSchema = memoryRecordSchema
  .omit({ id: true, invalidatedAt: true })
  .extend({ validFrom: timestampSchema.optional() })
  .strict();

export type MemorySourceType = z.infer<typeof memorySourceTypeSchema>;
export type MemoryRecord = z.infer<typeof memoryRecordSchema>;
export type CreateMemoryRecord = z.infer<typeof createMemoryRecordSchema>;

export interface MemorySource {
  sourceType: MemorySourceType;
  sourceId: string;
  sourceHash: string;
}

export interface MemoryCitation {
  sourceType: MemorySourceType;
  sourceId: string;
  sourceHash: string;
}

export interface MemorySearchResult extends MemoryRecord {
  citation: MemoryCitation;
  conflicted: boolean;
}

export interface MemoryDatabase {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
  };
}

export function memoryRecordedEvent(input: unknown): AuditEvent {
  const parsed = createMemoryRecordSchema.parse(input);
  const record: MemoryRecord = {
    id: createId("mem"),
    ...parsed,
    validFrom: parsed.validFrom ?? new Date().toISOString()
  };
  return createEvent("memory.written", record, {
    "memory.sourceType": record.sourceType,
    "memory.sourceId": record.sourceId
  });
}

export function projectMemories(events: AuditEvent[]): Array<MemoryRecord | z.infer<typeof legacyMemoryRecordSchema>> {
  const records: Array<MemoryRecord | z.infer<typeof legacyMemoryRecordSchema>> = [];
  for (const event of events) {
    if (event.name !== "memory.written" && event.name !== "memory.recorded") continue;
    const current = memoryRecordSchema.safeParse(event.body);
    if (current.success) {
      records.push(current.data);
      continue;
    }
    const legacy = legacyMemoryRecordSchema.safeParse(event.body);
    if (legacy.success) records.push(legacy.data);
  }
  return records
    .sort((left, right) => left.validFrom.localeCompare(right.validFrom));
}

export function memoryCitation(record: MemoryRecord): MemoryCitation {
  return { sourceType: record.sourceType, sourceId: record.sourceId, sourceHash: record.sourceHash };
}

export function sourceHash(source: unknown): string {
  return stableHash(source);
}

export function verifyMemorySource(record: MemoryRecord, source: unknown): boolean {
  return record.sourceHash === sourceHash(source);
}

export function writeMemoryFromAuditEvent(db: MemoryDatabase, event: AuditEvent, input: {
  claim: string;
  confidence: number;
  tags?: string[];
  validFrom?: string;
  validUntil?: string;
}): MemoryRecord {
  return writeMemory(db, {
    claim: input.claim,
    sourceType: "audit_event",
    sourceId: event.id,
    sourceHash: sourceHash(event),
    confidence: input.confidence,
    tags: input.tags ?? [],
    validFrom: input.validFrom ?? new Date(Number(BigInt(event.timeUnixNano) / 1_000_000n)).toISOString(),
    validUntil: input.validUntil
  });
}

export function writeMemory(db: MemoryDatabase, input: CreateMemoryRecord): MemoryRecord {
  const record = memoryRecordSchema.parse({ id: createId("mem"), ...input, validFrom: input.validFrom ?? new Date().toISOString() });
  db.prepare(
    `INSERT INTO memory_records
      (id, claim, source_type, source_id, source_hash, valid_from, valid_until, confidence, tags_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    record.id,
    record.claim,
    record.sourceType,
    record.sourceId,
    record.sourceHash,
    record.validFrom,
    record.validUntil ?? null,
    record.confidence,
    JSON.stringify(record.tags),
    new Date().toISOString()
  );
  return record;
}

export function searchMemory(db: MemoryDatabase, query: string, options: { asOf?: string; tags?: string[]; limit?: number } = {}): MemorySearchResult[] {
  const normalizedQuery = query.trim();
  const limit = options.limit ?? 50;
  if (limit < 1 || limit > 500) throw new Error("memory search limit must be between 1 and 500");
  const asOf = options.asOf ?? new Date().toISOString();
  const tagFilters = (options.tags ?? []).filter(Boolean);
  const rows = db
    .prepare(
      `SELECT * FROM memory_records
       WHERE invalidated_at IS NULL AND valid_from <= ? AND (valid_until IS NULL OR valid_until > ?)
         AND (lower(claim) LIKE lower(?) OR lower(source_id) LIKE lower(?) OR lower(tags_json) LIKE lower(?))
       ORDER BY valid_from DESC LIMIT ?`
    )
    .all(asOf, asOf, `%${normalizedQuery}%`, `%${normalizedQuery}%`, `%${normalizedQuery}%`, limit) as Array<Record<string, unknown>>;
  const records = rows.map(rowToMemoryRecord).filter((record) => tagFilters.every((tag) => record.tags.includes(tag)));
  return records.map((record) => ({
    ...record,
    citation: memoryCitation(record),
    conflicted: records.some((other) => other.claim === record.claim && other.sourceHash !== record.sourceHash)
  }));
}

export function invalidateMemory(db: MemoryDatabase, id: string, at = new Date().toISOString()): MemoryRecord {
  const current = db.prepare(`SELECT * FROM memory_records WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!current) throw new Error(`memory record not found: ${id}`);
  const record = rowToMemoryRecord(current);
  if (record.invalidatedAt) return record;
  db.prepare(`UPDATE memory_records SET valid_until = ?, invalidated_at = ? WHERE id = ?`).run(at, at, id);
  return { ...record, validUntil: at, invalidatedAt: at };
}

function rowToMemoryRecord(row: Record<string, unknown>): MemoryRecord {
  return memoryRecordSchema.parse({
    id: row.id,
    claim: row.claim,
    sourceType: row.source_type,
    sourceId: row.source_id,
    sourceHash: row.source_hash,
    validFrom: row.valid_from,
    ...(row.valid_until ? { validUntil: row.valid_until } : {}),
    confidence: row.confidence,
    tags: JSON.parse(String(row.tags_json)),
    ...(row.invalidated_at ? { invalidatedAt: row.invalidated_at } : {})
  });
}
