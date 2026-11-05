import { canonicalJson, envelopeForDigest, sha256Hex } from "./canonical.js";
import { recorderFeatureEnabled } from "./flag.js";
import { importTrustedKey, signedPayload, verifyProvenance } from "./provenance.js";
import { redact, redactField } from "./redact.js";
import type { Finding, IngestDraft, IngestResult, RecorderEvent, RunAnnotation, TrustLevel } from "./types.js";
import { SCHEMA_VERSION } from "./types.js";

/**
 * Derives an event id within its trust namespace so an unsigned claim cannot
 * occupy the id an authenticated record or a validator reference uses.
 */
export async function recorderEventIdFor(
  component: string,
  producerEventId: string,
  authority: "authoritative" | "authenticated" | "untrusted" = "authoritative"
): Promise<string> {
  if (!isPublicRecorderId(component) || !isPublicRecorderId(producerEventId)) {
    throw new Error("Recorder reference requires an unambiguous public identity");
  }
  const producerKey = `${component}\0${producerEventId}\0${authority}`;
  return `rec_${(await sha256Hex(producerKey)).slice(0, 24)}`;
}

export function isPublicRecorderId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    !value.includes("\0") && !value.includes("[redacted]") && !value.includes("…[truncated]") &&
    !/[\uD800-\uDFFF]/u.test(value) &&
    redactField(value) === value;
}

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
const TRUSTED_AUTHORITY_LEVELS: ReadonlySet<TrustLevel> = new Set(["acs_authoritative", "independently_verified"]);
const DEFAULT_MAX_RUNS = 10_000;
const UNGRANTED: ReadonlySet<TrustLevel> = new Set([
  "acs_authoritative",
  "independently_verified",
  "authenticated_producer"
]);

/** Give each unscoped record its own run key, reserving that namespace. */
export function recorderRunId(runId: string | null, eventId: string): string {
  if (runId === null) return `unscoped:${eventId}`;
  return runId.startsWith("unscoped:") ? `unscoped:run:${runId}` : runId;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export class RecorderStore {
  readonly #events = new Map<string, RecorderEvent>();
  readonly #byProducer = new Map<string, string>();
  readonly #annotations = new Map<string, RunAnnotation>();
  readonly #fingerprints = new Map<string, string>();
  readonly #conflictedAt = new Map<string, string>();
  #fingerprintKey?: Promise<CryptoKey>;
  readonly #enabled: boolean;
  readonly #maxEvents: number;
  readonly #grantTrust: NonNullable<RecorderStoreOptions["grantTrust"]>;
  readonly #maxRuns: number;
  readonly #keys: Promise<Map<string, CryptoKey>>;

  constructor(options: RecorderStoreOptions = {}) {
    this.#enabled = options.enabled ?? recorderFeatureEnabled();
    this.#maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
    this.#maxRuns = options.maxRuns ?? DEFAULT_MAX_RUNS;
    this.#grantTrust = options.grantTrust ?? (() => false);
    this.#keys = loadKeys(options.trustedKeys ?? {});
  }
  readonly #conflicts: Array<Readonly<{
    producerKey: string;
    existingEventId: string;
    rejectedSha256: string;
    ingestedAt: string;
  }>> = [];
  readonly findings: Finding[] = [];

  get events(): ReadonlyMap<string, RecorderEvent> { return new Map(this.#events); }
  get annotations(): ReadonlyMap<string, RunAnnotation> { return new Map(this.#annotations); }
  get conflicts() { return this.#conflicts.slice(); }
  get conflictedAt(): ReadonlyMap<string, string> { return new Map(this.#conflictedAt); }

  annotationFor(runId: string): RunAnnotation | undefined { return this.#annotations.get(runId); }
  hasConflict(eventId: string): boolean { return this.#conflictedAt.has(eventId); }

  /** Returns false, and stores nothing, when a new run would exceed the annotation cap. */
  annotate(runId: string, annotation: RunAnnotation): boolean {
    if (!this.#enabled || !isPublicRecorderId(runId) || !annotation || typeof annotation !== "object") return false;
    const key = recorderRunId(runId, "");
    if (!this.#annotations.has(key) && this.#annotations.size >= this.#maxRuns) return false;
    const prev = this.#annotations.get(key) ?? {};
    const redacted = redact(annotation) as RunAnnotation;
    const safe: RunAnnotation = {};
    for (const field of ["agent", "tool", "observedStatus", "coverage", "instruction", "correlatedSession", "correlatedWorkItem", "sessionId"] as const) {
      const value = redacted[field];
      if (typeof value === "string") safe[field] = value;
    }
    for (const field of ["correlatedExitCode", "observedProcessExitCode"] as const) {
      const value = redacted[field];
      if (typeof value === "number") safe[field] = value;
    }
    this.#annotations.set(key, deepFreeze({ ...prev, ...safe }));
    return true;
  }

  async ingest(input: IngestDraft): Promise<IngestResult> {
    if (!this.#enabled) return { status: "disabled", reason: "ABBR_ENABLED is not set to 1" };
    let draft: IngestDraft;
    let producerPayload: string;
    try {
      // Capture the payload before the first await. The signature, redaction
      // and fingerprint must all describe the same immutable input.
      draft = deepFreeze(structuredClone(input));
      if (![draft.component, draft.producerEventId, draft.eventType, draft.ingestedAt]
        .every((field) => typeof field === "string" && field.length > 0)) {
        return { status: "rejected", reason: "record is missing a required identity, type or time" };
      }
      const optionalFields = [draft.instanceId, draft.releaseId, draft.identityRef, draft.runId,
        draft.missionId, draft.correlationId, draft.parentEventId, draft.sourceTimestamp, draft.sourceRecordRef];
      if (!optionalFields.every((field) => field == null || typeof field === "string")) {
        return { status: "rejected", reason: "record contains an invalid identity, reference or timestamp" };
      }
      if (!UNGRANTED.has(draft.trustLevel) && draft.trustLevel !== "unknown" && draft.trustLevel !== "untrusted_claim") {
        return { status: "rejected", reason: "record contains an unknown trust level" };
      }
      const fields = signedPayload(draft);
      delete fields.ingestedAt;
      producerPayload = canonicalJson(fields);
    } catch {
      return { status: "rejected", reason: "record payload cannot be encoded as canonical JSON" };
    }
    // Every stored string passes through the same redaction, including identity and reference fields.
    const metadata = redact(draft.metadata ?? {}) as Record<string, unknown>;
    // Authority is kept only when an ACS key signed exactly these fields, or the caller explicitly grants it.
    const signed = await verifyProvenance(draft, canonicalJson, await this.#keys);
    const trustLevel: TrustLevel =
      UNGRANTED.has(draft.trustLevel) && !signed && !this.#grantTrust(draft, draft.trustLevel)
        ? "untrusted_claim"
        : draft.trustLevel;
    const source = {
      component: redactField(draft.component) ?? "",
      instanceId: redactField(draft.instanceId),
      releaseId: redactField(draft.releaseId),
      producerEventId: redactField(draft.producerEventId) ?? "",
      identityRef: redactField(draft.identityRef)
    };
    const authority = TRUSTED_AUTHORITY_LEVELS.has(trustLevel) ? "authoritative"
      : trustLevel === "authenticated_producer" ? "authenticated" : "untrusted";
    const producerIdentity = [draft.component, draft.producerEventId, authority];
    const producerKey = isPublicRecorderId(draft.component) && isPublicRecorderId(draft.producerEventId)
      ? producerIdentity.join("\0")
      : `private\0${await this.#fingerprint("identity", canonicalJson(producerIdentity))}`;
    const eventId = `rec_${(await sha256Hex(producerKey)).slice(0, 24)}`;
    const partial = {
      eventId,
      schemaVersion: SCHEMA_VERSION,
      runId: isPublicRecorderId(draft.runId) ? draft.runId : null,
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

    // Retry comparison keeps the original payload private and ignores the recorder's observation time.
    const fingerprint = await this.#fingerprint("payload", producerPayload);
    const existingId = this.#byProducer.get(producerKey);
    if (existingId) {
      const existing = this.#events.get(existingId);
      if (!existing) throw new Error("producer index pointed at a missing event");
      if (this.#fingerprints.get(existingId) === fingerprint) {
        return { status: "duplicate", event: existing };
      }
      this.#conflictedAt.set(existingId, event.ingestedAt);
      if (this.#conflicts.length < this.#maxEvents) {
        this.#conflicts.push(Object.freeze({
          producerKey,
          existingEventId: existing.eventId,
          rejectedSha256: payloadSha256,
          ingestedAt: event.ingestedAt
        }));
      }
      return { status: "conflict", event: existing, rejectedSha256: payloadSha256 };
    }

    if (this.#events.size >= this.#maxEvents) {
      return { status: "rejected", reason: `store is at its ${this.#maxEvents}-record limit` };
    }
    if (this.#events.has(event.eventId)) return { status: "rejected", reason: "recorder event identity collision" };
    this.#events.set(event.eventId, event);
    this.#byProducer.set(producerKey, event.eventId);
    this.#fingerprints.set(event.eventId, fingerprint);
    return { status: "created", event };
  }

  eventsFor(runId: string): RecorderEvent[] {
    return [...this.#events.values()].filter((event) => recorderRunId(event.runId, event.eventId) === runId);
  }

  async #fingerprint(domain: "identity" | "payload", content: string): Promise<string> {
    this.#fingerprintKey ??= crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const data = new TextEncoder().encode(`${domain}\0${content}`);
    const digest = await crypto.subtle.sign("HMAC", await this.#fingerprintKey, data);
    return btoa(String.fromCharCode(...new Uint8Array(digest)));
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
  return UNGRANTED.has(trust) ? "valid" : "unverifiable";
}
