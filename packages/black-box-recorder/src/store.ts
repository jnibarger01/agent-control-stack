import { canonicalJson, envelopeForDigest, sha256Hex } from "./canonical.js";
import { recorderFeatureEnabled } from "./flag.js";
import { importTrustedKey, verifyProvenance } from "./provenance.js";
import { redact, redactField } from "./redact.js";
import type { Finding, IngestDraft, IngestResult, RecorderEvent, RunAnnotation, TrustLevel } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";

export type RecorderStoreOptions = {
  /** Ingestion is refused unless this is true. Defaults to the ABBR_ENABLED flag. */
  enabled?: boolean;
  /** Hard cap on stored records. A full store rejects new records; it never evicts or grows. */
  maxEvents?: number;
  /**
   * Caller-supplied authority. Without a grant, a producer's claim of ACS or independent authority is recorded as
   * untrusted, because the recorder cannot authenticate it itself.
   */
  grantTrust?: (draft: IngestDraft, claimed: TrustLevel) => boolean;
  /**
   * ACS public keys by key id (PEM SPKI). A draft signed by one of these keys over its signed payload keeps its claimed
   * authority. A key that fails to import is skipped, so it can never grant trust.
   */
  trustedKeys?: Record<string, string>;
  /** Cap on run annotations. A new run beyond the cap is refused. */
  maxRuns?: number;
};

const DEFAULT_MAX_EVENTS = 10_000;
const DEFAULT_MAX_RUNS = 10_000;
const UNGRANTED: ReadonlySet<TrustLevel> = new Set([
  "acs_authoritative",
  "independently_verified",
  "authenticated_producer"
]);

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export class RecorderStore {
  readonly events = new Map<string, RecorderEvent>();
  private readonly enabled: boolean;
  private readonly maxEvents: number;
  private readonly grantTrust: NonNullable<RecorderStoreOptions["grantTrust"]>;
  private readonly maxRuns: number;
  private readonly keys: Promise<Map<string, CryptoKey>>;

  constructor(options: RecorderStoreOptions = {}) {
    this.enabled = options.enabled ?? recorderFeatureEnabled();
    this.maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
    this.maxRuns = options.maxRuns ?? DEFAULT_MAX_RUNS;
    this.grantTrust = options.grantTrust ?? (() => false);
    this.keys = loadKeys(options.trustedKeys ?? {});
  }
  readonly byProducer = new Map<string, string>();
  readonly conflicts: Array<{
    producerKey: string;
    existingEventId: string;
    rejectedSha256: string;
    ingestedAt: string;
  }> = [];
  readonly annotations = new Map<string, RunAnnotation>();
  readonly findings: Finding[] = [];

  /** Returns false, and stores nothing, when a new run would exceed the annotation cap. */
  annotate(runId: string, annotation: RunAnnotation): boolean {
    if (!this.annotations.has(runId) && this.annotations.size >= this.maxRuns) return false;
    const prev = this.annotations.get(runId) ?? {};
    this.annotations.set(runId, { ...prev, ...annotation });
    return true;
  }

  async ingest(draft: IngestDraft): Promise<IngestResult> {
    if (!this.enabled) return { status: "disabled", reason: "ABBR_ENABLED is not set to 1" };
    // Every stored string passes through the same redaction, including identity and reference fields.
    const metadata = redact(draft.metadata ?? {}) as Record<string, unknown>;
    // Authority is kept only when an ACS key signed exactly these fields, or the caller explicitly grants it.
    const signed = await verifyProvenance(draft, canonicalJson, await this.keys);
    const trustLevel: TrustLevel =
      UNGRANTED.has(draft.trustLevel) && !signed && !this.grantTrust(draft, draft.trustLevel)
        ? "untrusted_claim"
        : draft.trustLevel;
    const source = {
      component: redactField(draft.component) ?? "",
      instanceId: redactField(draft.instanceId),
      releaseId: redactField(draft.releaseId),
      producerEventId: redactField(draft.producerEventId) ?? "",
      identityRef: redactField(draft.identityRef)
    };
    const producerKey = `${source.component}\0${source.producerEventId}`;
    const eventId = `rec_${(await sha256Hex(producerKey)).slice(0, 24)}`;
    const partial = {
      eventId,
      schemaVersion: SCHEMA_VERSION,
      runId: redactField(draft.runId),
      missionId: redactField(draft.missionId),
      correlationId: redactField(draft.correlationId),
      parentEventId: redactField(draft.parentEventId),
      eventType: redactField(draft.eventType) ?? "",
      source,
      sourceTimestamp: redactField(draft.sourceTimestamp),
      ingestedAt: redactField(draft.ingestedAt) ?? "",
      trustLevel,
      metadata,
      evidence: {
        sourceRecordRef: redactField(draft.sourceRecordRef),
        integrityStatus: trustIntegrity(trustLevel)
      }
    };
    // The digest covers the redacted envelope only, so it cannot be used to test a guessed secret.
    const payloadSha256 = await sha256Hex(envelopeForDigest(partial));
    const event = deepFreeze({
      ...partial,
      evidence: { ...partial.evidence, payloadSha256 }
    }) as RecorderEvent;

    const existingId = this.byProducer.get(producerKey);
    if (existingId) {
      const existing = this.events.get(existingId);
      if (!existing) throw new Error("producer index pointed at a missing event");
      if (existing.evidence.payloadSha256 === payloadSha256) {
        return { status: "duplicate", event: existing };
      }
      if (this.conflicts.length < this.maxEvents) {
        this.conflicts.push({
          producerKey,
          existingEventId: existing.eventId,
          rejectedSha256: payloadSha256,
          ingestedAt: draft.ingestedAt
        });
      }
      return { status: "conflict", event: existing, rejectedSha256: payloadSha256 };
    }

    if (this.events.size >= this.maxEvents) {
      return { status: "rejected", reason: `store is at its ${this.maxEvents}-record limit` };
    }
    this.events.set(event.eventId, event);
    this.byProducer.set(producerKey, event.eventId);
    return { status: "created", event };
  }

  eventsFor(runId: string): RecorderEvent[] {
    return [...this.events.values()].filter((event) => event.runId === runId);
  }
}

/** Imports each trusted key. A key that does not import is dropped and can never verify anything. */
async function loadKeys(pems: Record<string, string>): Promise<Map<string, CryptoKey>> {
  const out = new Map<string, CryptoKey>();
  for (const [keyId, pem] of Object.entries(pems)) {
    try {
      out.set(keyId, await importTrustedKey(pem));
    } catch {
      // Fail closed: an unusable key is treated as absent.
    }
  }
  return out;
}

function trustIntegrity(trust: IngestDraft["trustLevel"]): RecorderEvent["evidence"]["integrityStatus"] {
  if (trust === "unknown" || trust === "untrusted_claim") return "unverifiable";
  return "valid";
}
