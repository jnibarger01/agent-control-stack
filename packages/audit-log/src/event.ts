import type { AuditChainEvent } from "@agent-control-stack/shared";

export type StoredAuditEvent = AuditChainEvent;

export interface EventRow {
  sequence: number;
  id: string;
  name: string;
  time_unix_nano: string;
  attributes: string;
  body: string;
  previous_hash: string;
  event_hash: string;
}

export function rowToEvent(row: EventRow): StoredAuditEvent {
  return {
    sequence: row.sequence,
    id: row.id,
    name: row.name,
    timeUnixNano: row.time_unix_nano,
    attributes: JSON.parse(row.attributes) as StoredAuditEvent["attributes"],
    body: JSON.parse(row.body) as StoredAuditEvent["body"],
    previousHash: row.previous_hash,
    eventHash: row.event_hash
  };
}
