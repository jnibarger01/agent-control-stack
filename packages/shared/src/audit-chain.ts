import type { AuditEvent } from "./schema.js";
import { stableHash } from "./hash.js";

export interface AuditChainEvent extends AuditEvent {
  sequence: number;
  previousHash: string;
  eventHash: string;
}

export interface AuditChainFailure {
  sequence: number;
  reason: "previous_hash_mismatch" | "event_hash_mismatch";
  expected: string;
  actual: string;
}

export type AuditChainVerification =
  | { ok: true; eventCount: number; headHash: string }
  | { ok: false; eventCount: number; headHash: string; failure: AuditChainFailure };

export function auditEventHash(event: Omit<AuditChainEvent, "eventHash">): string {
  return stableHash({
    sequence: event.sequence,
    id: event.id,
    name: event.name,
    timeUnixNano: event.timeUnixNano,
    attributes: event.attributes,
    body: event.body,
    previousHash: event.previousHash
  });
}

export function verifyAuditChain(events: AuditChainEvent[]): AuditChainVerification {
  let previousHash = "";

  for (const event of events) {
    if (event.previousHash !== previousHash) {
      return {
        ok: false,
        eventCount: events.length,
        headHash: previousHash,
        failure: {
          sequence: event.sequence,
          reason: "previous_hash_mismatch",
          expected: previousHash,
          actual: event.previousHash
        }
      };
    }

    const expectedHash = auditEventHash(event);
    if (event.eventHash !== expectedHash) {
      return {
        ok: false,
        eventCount: events.length,
        headHash: previousHash,
        failure: {
          sequence: event.sequence,
          reason: "event_hash_mismatch",
          expected: expectedHash,
          actual: event.eventHash
        }
      };
    }

    previousHash = event.eventHash;
  }

  return { ok: true, eventCount: events.length, headHash: previousHash };
}
