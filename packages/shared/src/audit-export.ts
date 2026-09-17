import { DatabaseSync } from "node:sqlite";
import { verifyAuditChain, type AuditChainEvent, type AuditChainVerification } from "./audit-chain.js";

interface AuditEventRow {
  sequence: number;
  id: string;
  name: string;
  time_unix_nano: string;
  attributes: string;
  body: string;
  previous_hash: string;
  event_hash: string;
}

/** One JSON object per line, chain order (ascending sequence). Fields are post-redaction. */
export function formatAuditChainJsonl(events: readonly AuditChainEvent[]): string {
  if (events.length === 0) {
    return "";
  }
  return `${events.map((event) => JSON.stringify(toExportRecord(event))).join("\n")}\n`;
}

export function parseAuditChainJsonl(text: string): AuditChainEvent[] {
  const lines = text.split(/\r?\n/);
  const events: AuditChainEvent[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (line.length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`invalid audit JSONL at line ${index + 1}: not JSON`);
    }
    events.push(parseExportRecord(parsed, index + 1));
  }
  return events;
}

export function verifyAuditChainJsonl(text: string): AuditChainVerification {
  return verifyAuditChain(parseAuditChainJsonl(text));
}

export function readAuditChainEvents(db: DatabaseSync): AuditChainEvent[] {
  const rows = db.prepare("SELECT * FROM audit_events ORDER BY sequence ASC").all() as unknown as AuditEventRow[];
  return rows.map(rowToAuditEvent);
}

export function exportAuditChainJsonlFromDatabaseFile(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return formatAuditChainJsonl(readAuditChainEvents(db));
  } finally {
    db.close();
  }
}

export function verifyAuditChainFromDatabaseFile(path: string): AuditChainVerification {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return verifyAuditChain(readAuditChainEvents(db));
  } finally {
    db.close();
  }
}

function toExportRecord(event: AuditChainEvent): Record<string, unknown> {
  return {
    sequence: event.sequence,
    id: event.id,
    name: event.name,
    timeUnixNano: event.timeUnixNano,
    attributes: event.attributes,
    body: event.body,
    previousHash: event.previousHash,
    eventHash: event.eventHash
  };
}

function parseExportRecord(value: unknown, line: number): AuditChainEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid audit JSONL at line ${line}: expected object`);
  }
  const record = value as Record<string, unknown>;
  const sequence = record.sequence;
  if (!Number.isInteger(sequence) || (sequence as number) < 1) {
    throw new Error(`invalid audit JSONL at line ${line}: sequence must be a positive integer`);
  }
  return {
    sequence: sequence as number,
    id: requireNonEmptyString(record.id, "id", line),
    name: requireNonEmptyString(record.name, "name", line),
    timeUnixNano: requireUnixNano(record.timeUnixNano, line),
    attributes: requireAttributes(record.attributes, line),
    body: requireBody(record.body, line),
    previousHash: requireHash(record.previousHash, "previousHash", line),
    eventHash: requireHash(record.eventHash, "eventHash", line)
  };
}

function requireNonEmptyString(value: unknown, field: string, line: number): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`invalid audit JSONL at line ${line}: ${field} must be a non-empty string`);
  }
  return value;
}

function requireUnixNano(value: unknown, line: number): string {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error(`invalid audit JSONL at line ${line}: timeUnixNano must be a decimal digit string`);
  }
  return value;
}

function requireHash(value: unknown, field: string, line: number): string {
  if (typeof value !== "string") {
    throw new Error(`invalid audit JSONL at line ${line}: ${field} must be a string`);
  }
  // Genesis previousHash is ""; event hashes are sha256 hex.
  if (value.length === 0) {
    return value;
  }
  if (!/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error(`invalid audit JSONL at line ${line}: ${field} must be sha256 hex or empty`);
  }
  return value.toLowerCase();
}

function requireAttributes(value: unknown, line: number): AuditChainEvent["attributes"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid audit JSONL at line ${line}: attributes must be an object`);
  }
  const attributes: AuditChainEvent["attributes"] = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== "string" && typeof entry !== "number" && typeof entry !== "boolean") {
      throw new Error(`invalid audit JSONL at line ${line}: attributes.${key} must be string|number|boolean`);
    }
    attributes[key] = entry;
  }
  return attributes;
}

function requireBody(value: unknown, line: number): AuditChainEvent["body"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`invalid audit JSONL at line ${line}: body must be an object`);
  }
  return value as AuditChainEvent["body"];
}

function rowToAuditEvent(row: AuditEventRow): AuditChainEvent {
  return {
    sequence: row.sequence,
    id: row.id,
    name: row.name,
    timeUnixNano: row.time_unix_nano,
    attributes: JSON.parse(row.attributes) as AuditChainEvent["attributes"],
    body: JSON.parse(row.body) as AuditChainEvent["body"],
    previousHash: row.previous_hash,
    eventHash: row.event_hash
  };
}
