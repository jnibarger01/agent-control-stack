/** Sorted-key JSON. Arrays keep order. Undefined object fields are dropped. */
export function canonicalJson(value: unknown): string {
  return stringify(value);
}

function stringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${Array.from(value, (item) => stringify(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stringify(record[key])}`).join(",")}}`;
}

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function envelopeForDigest(event: {
  eventId: string;
  schemaVersion: number;
  runId: string | null;
  missionId: string | null;
  correlationId: string | null;
  parentEventId: string | null;
  eventType: string;
  source: unknown;
  sourceTimestamp: string | null;
  ingestedAt: string;
  trustLevel: string;
  metadata: unknown;
  evidence: { sourceRecordRef: string | null; integrityStatus: string };
}): string {
  return canonicalJson({
    eventId: event.eventId,
    schemaVersion: event.schemaVersion,
    runId: event.runId,
    missionId: event.missionId,
    correlationId: event.correlationId,
    parentEventId: event.parentEventId,
    eventType: event.eventType,
    source: event.source,
    sourceTimestamp: event.sourceTimestamp,
    ingestedAt: event.ingestedAt,
    trustLevel: event.trustLevel,
    metadata: event.metadata,
    evidence: {
      sourceRecordRef: event.evidence.sourceRecordRef,
      integrityStatus: event.evidence.integrityStatus
    }
  });
}
