import { envelopeForDigest, sha256Hex } from "./canonical.js";
import { redact } from "./redact.js";
import type { Finding, IngestDraft, IngestResult, RecorderEvent, RunAnnotation } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";

export class RecorderStore {
  readonly events = new Map<string, RecorderEvent>();
  readonly byProducer = new Map<string, string>();
  readonly conflicts: Array<{
    producerKey: string;
    existingEventId: string;
    rejectedSha256: string;
    ingestedAt: string;
  }> = [];
  readonly annotations = new Map<string, RunAnnotation>();
  readonly findings: Finding[] = [];

  annotate(runId: string, annotation: RunAnnotation) {
    const prev = this.annotations.get(runId) ?? {};
    this.annotations.set(runId, { ...prev, ...annotation });
  }

  async ingest(draft: IngestDraft): Promise<IngestResult> {
    const metadata = redact(draft.metadata ?? {}) as Record<string, unknown>;
    const source = {
      component: draft.component,
      instanceId: draft.instanceId ?? null,
      releaseId: draft.releaseId ?? null,
      producerEventId: draft.producerEventId,
      identityRef: draft.identityRef ?? null,
    };
    const producerKey = `${draft.component}\0${draft.producerEventId}`;
    const eventId = `rec_${(await sha256Hex(producerKey)).slice(0, 24)}`;
    const partial = {
      eventId,
      schemaVersion: SCHEMA_VERSION,
      runId: draft.runId,
      missionId: draft.missionId,
      correlationId: draft.correlationId,
      parentEventId: draft.parentEventId,
      eventType: draft.eventType,
      source,
      sourceTimestamp: draft.sourceTimestamp,
      ingestedAt: draft.ingestedAt,
      trustLevel: draft.trustLevel,
      metadata,
      evidence: {
        sourceRecordRef: draft.sourceRecordRef ?? null,
        integrityStatus: trustIntegrity(draft.trustLevel),
      },
    };
    const payloadSha256 = await sha256Hex(envelopeForDigest(partial));
    const event: RecorderEvent = {
      ...partial,
      evidence: { ...partial.evidence, payloadSha256 },
    };

    const existingId = this.byProducer.get(producerKey);
    if (existingId) {
      const existing = this.events.get(existingId);
      if (!existing) throw new Error("producer index pointed at a missing event");
      if (existing.evidence.payloadSha256 === payloadSha256) {
        return { status: "duplicate", event: existing };
      }
      this.conflicts.push({
        producerKey,
        existingEventId: existing.eventId,
        rejectedSha256: payloadSha256,
        ingestedAt: draft.ingestedAt,
      });
      return { status: "conflict", event: existing, rejectedSha256: payloadSha256 };
    }

    this.events.set(event.eventId, event);
    this.byProducer.set(producerKey, event.eventId);
    return { status: "created", event };
  }

  eventsFor(runId: string): RecorderEvent[] {
    return [...this.events.values()].filter((event) => event.runId === runId);
  }
}

function trustIntegrity(trust: IngestDraft["trustLevel"]): RecorderEvent["evidence"]["integrityStatus"] {
  if (trust === "unknown" || trust === "untrusted_claim") return "unverifiable";
  return "valid";
}
