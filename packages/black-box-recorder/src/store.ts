import { canonicalJson, envelopeForDigest, sha256Hex } from "./canonical.js";
import { recorderFeatureEnabled } from "./flag.js";
import {
  toWitnessRecorderDraft,
  verifyJcWitnessReceipt,
  type VerifyJcWitnessOptions,
  type WitnessIngestResult
} from "./jc-witness-adapter.js";
import { importTrustedKey, signedPayload, verifyProvenance } from "./provenance.js";
import { redact, redactField } from "./redact.js";
import type {
  ChainFinding,
  ChainVerification,
  Finding,
  IngestDraft,
  IngestResult,
  RecorderEvent,
  RunAnnotation,
  TrustLevel
} from "./types.js";
import { SCHEMA_VERSION } from "./types.js";

export const GENESIS_HASH = "0".repeat(64);

export async function computeEventHash(
  seq: number,
  previousHash: string,
  eventId: string,
  payloadSha256: string
): Promise<string> {
  return sha256Hex(canonicalJson({ seq, previousHash, eventId, payloadSha256 }));
}

export async function computeRecorderFingerprint(
  domain: "identity" | "payload",
  content: string
): Promise<string> {
  return sha256Hex(`abbr.fingerprint.v1:${domain}:${content}`);
}

export type PreparedRecorderDraft = {
  readonly partial: Omit<RecorderEvent, "evidence"> & {
    readonly evidence: {
      readonly sourceRecordRef: string | null;
      readonly integrityStatus: RecorderEvent["evidence"]["integrityStatus"];
    };
  };
  readonly payloadSha256: string;
  readonly producerKey: string;
  readonly fingerprint: string;
  readonly evidenceHashClaim: string | null;
};

export async function verifyRecorderChain(events: readonly RecorderEvent[]): Promise<ChainVerification> {
  const findings: ChainFinding[] = [];
  let expectedSeq = 1;
  let expectedPrev = GENESIS_HASH;
  let headHash = GENESIS_HASH;

  for (const event of events) {
    const { seq, previousHash, eventHash, payloadSha256 } = event.evidence ?? {};
    if (seq !== expectedSeq) {
      findings.push({
        kind: "sequence_gap",
        seq,
        eventId: event.eventId,
        detail: `expected seq ${expectedSeq}, got ${String(seq)}`
      });
    }
    if (previousHash !== expectedPrev) {
      findings.push({
        kind: "previous_hash_mismatch",
        seq,
        eventId: event.eventId,
        detail: `expected previousHash ${expectedPrev}, got ${String(previousHash)}`
      });
    }
    const recomputedPayload = await sha256Hex(envelopeForDigest(event));
    if (payloadSha256 !== recomputedPayload) {
      findings.push({
        kind: "payload_hash_mismatch",
        seq,
        eventId: event.eventId,
        detail: `payloadSha256 mismatch for ${event.eventId}`
      });
    }
    if (typeof seq === "number" && typeof previousHash === "string" && typeof payloadSha256 === "string") {
      const recomputedEvent = await computeEventHash(seq, previousHash, event.eventId, payloadSha256);
      if (eventHash !== recomputedEvent) {
        findings.push({
          kind: "event_hash_mismatch",
          seq,
          eventId: event.eventId,
          detail: `eventHash mismatch for ${event.eventId}`
        });
      }
    } else {
      findings.push({
        kind: "event_hash_mismatch",
        seq,
        eventId: event.eventId,
        detail: `missing chain fields for ${event.eventId}`
      });
    }
    expectedSeq = (typeof seq === "number" ? seq : expectedSeq) + 1;
    expectedPrev = typeof eventHash === "string" ? eventHash : "";
    headHash = expectedPrev || headHash;
  }

  return {
    valid: findings.length === 0,
    eventCount: events.length,
    headHash: events.length === 0 ? GENESIS_HASH : headHash,
    findings
  };
}

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
  readonly #producerKeyByEventId = new Map<string, string>();
  readonly #annotations = new Map<string, RunAnnotation>();
  readonly #fingerprints = new Map<string, string>();
  readonly #conflictedAt = new Map<string, string>();
  readonly #seenEvidenceHashes = new Set<string>();
  #seq = 0;
  #headHash = GENESIS_HASH;
  #commitQueue: Promise<void> = Promise.resolve();
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
  get headHash(): string { return this.#headHash; }
  get chainLength(): number { return this.#seq; }

  async verifyChain(): Promise<ChainVerification> {
    return verifyRecorderChain([...this.#events.values()]);
  }

  persistenceMetadataFor(eventId: string): { producerKey: string; fingerprint: string } | undefined {
    const producerKey = this.#producerKeyByEventId.get(eventId);
    const fingerprint = this.#fingerprints.get(eventId);
    if (!producerKey || !fingerprint) return undefined;
    return { producerKey, fingerprint };
  }

  async hydrate(
    entries: ReadonlyArray<{
      event: RecorderEvent;
      producerKey: string;
      fingerprint: string;
      evidenceHash?: string | null;
    }>,
    expectedChainState?: {
      seq: number;
      headHash: string;
    }
  ): Promise<ChainVerification> {
    if (this.#events.size > 0) {
      throw new Error("cannot hydrate non-empty RecorderStore");
    }
    const events = entries.map((e) => e.event);
    const verification = await verifyRecorderChain(events);
    if (!verification.valid) {
      throw new Error(`durable black-box chain verification failed: ${verification.findings.map((f) => f.detail).join("; ")}`);
    }
    if (expectedChainState) {
      if (
        verification.eventCount !== expectedChainState.seq ||
        verification.headHash !== expectedChainState.headHash
      ) {
        throw new Error(
          `black_box_chain_state_mismatch: expected seq=${expectedChainState.seq} headHash=${expectedChainState.headHash}, got seq=${verification.eventCount} headHash=${verification.headHash}`
        );
      }
    }
    for (const entry of entries) {
      const ev = deepFreeze(structuredClone(entry.event));
      this.#events.set(ev.eventId, ev);
      this.#byProducer.set(entry.producerKey, ev.eventId);
      this.#producerKeyByEventId.set(ev.eventId, entry.producerKey);
      this.#fingerprints.set(ev.eventId, entry.fingerprint);
      if (entry.evidenceHash && /^[a-f0-9]{64}$/u.test(entry.evidenceHash)) {
        this.#seenEvidenceHashes.add(entry.evidenceHash);
      }
      this.#seq = ev.evidence.seq;
      this.#headHash = ev.evidence.eventHash;
    }
    return verification;
  }

  /**
   * Synchronizes an event that has already been atomically committed to durable storage
   * into the in-memory store without advancing ahead of SQLite.
   */
  syncCommittedEvent(entry: {
    event: RecorderEvent;
    producerKey: string;
    fingerprint: string;
    evidenceHash?: string | null;
  }): RecorderEvent {
    const existingId = this.#byProducer.get(entry.producerKey);
    if (existingId) {
      const existing = this.#events.get(existingId);
      if (existing) return existing;
    }
    const ev = deepFreeze(structuredClone(entry.event));
    this.#events.set(ev.eventId, ev);
    this.#byProducer.set(entry.producerKey, ev.eventId);
    this.#producerKeyByEventId.set(ev.eventId, entry.producerKey);
    this.#fingerprints.set(ev.eventId, entry.fingerprint);
    if (entry.evidenceHash && /^[a-f0-9]{64}$/u.test(entry.evidenceHash)) {
      this.#seenEvidenceHashes.add(entry.evidenceHash);
    }
    if (ev.evidence.seq > this.#seq) {
      this.#seq = ev.evidence.seq;
      this.#headHash = ev.evidence.eventHash;
    }
    return ev;
  }

  recordConflict(conflict: {
    producerKey: string;
    existingEventId: string;
    rejectedSha256: string;
    ingestedAt: string;
  }): void {
    this.#conflictedAt.set(conflict.existingEventId, conflict.ingestedAt);
    if (this.#conflicts.length < this.#maxEvents) {
      this.#conflicts.push(Object.freeze({ ...conflict }));
    }
  }

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

  async ingestWitnessReceipt(
    rawReceipt: unknown,
    options: VerifyJcWitnessOptions & { ingestedAt?: string }
  ): Promise<WitnessIngestResult> {
    if (!this.#enabled) {
      return {
        accepted: false,
        observed: false,
        trustLevel: "untrusted_claim",
        reason: "ABBR_ENABLED is not set to 1",
        reasons: ["ABBR_ENABLED is not set to 1"]
      };
    }
    const verification = await verifyJcWitnessReceipt(rawReceipt, options);
    if (!verification.valid) {
      return {
        accepted: false,
        observed: false,
        trustLevel: "untrusted_claim",
        reason: verification.reasons.join("; "),
        reasons: verification.reasons
      };
    }
    const ingestedAt = options.ingestedAt ?? new Date().toISOString();
    const draft = toWitnessRecorderDraft(verification.receipt, verification, ingestedAt);
    const ingestResult = await this.#ingestInternal(draft, verification.observed);
    if (ingestResult.status === "created" || ingestResult.status === "duplicate") {
      if (options.seenEvidenceHashes) {
        options.seenEvidenceHashes.add(verification.receipt.evidenceHash);
      }
      return {
        accepted: true,
        observed: verification.observed && ingestResult.event.trustLevel === "independently_verified",
        trustLevel: ingestResult.event.trustLevel,
        reasons: verification.reasons,
        ingestResult
      };
    }
    const reason =
      ingestResult.status === "rejected" || ingestResult.status === "disabled"
        ? ingestResult.reason
        : "conflicting witness receipt for producer identity";
    return {
      accepted: false,
      observed: false,
      trustLevel: "untrusted_claim",
      reason,
      reasons: [reason],
      ingestResult
    };
  }

  async ingest(input: IngestDraft): Promise<IngestResult> {
    return this.#ingestInternal(input, false);
  }

  async prepareDraft(
    input: IngestDraft,
    verifiedWitnessGrant = false
  ): Promise<
    | { ok: true; prepared: PreparedRecorderDraft }
    | { ok: false; status: "disabled" | "rejected"; reason: string }
  > {
    if (!this.#enabled) return { ok: false, status: "disabled", reason: "ABBR_ENABLED is not set to 1" };
    let draft: IngestDraft;
    let producerPayload: string;
    try {
      // Capture the payload before the first await. The signature, redaction
      // and fingerprint must all describe the same immutable input.
      draft = deepFreeze(structuredClone(input));
      if (![draft.component, draft.producerEventId, draft.eventType, draft.ingestedAt]
        .every((field) => typeof field === "string" && field.length > 0)) {
        return { ok: false, status: "rejected", reason: "record is missing a required identity, type or time" };
      }
      const optionalFields = [draft.instanceId, draft.releaseId, draft.identityRef, draft.runId,
        draft.missionId, draft.correlationId, draft.parentEventId, draft.sourceTimestamp, draft.sourceRecordRef];
      if (!optionalFields.every((field) => field == null || typeof field === "string")) {
        return { ok: false, status: "rejected", reason: "record contains an invalid identity, reference or timestamp" };
      }
      if (!UNGRANTED.has(draft.trustLevel) && draft.trustLevel !== "unknown" && draft.trustLevel !== "untrusted_claim") {
        return { ok: false, status: "rejected", reason: "record contains an unknown trust level" };
      }
      const fields = signedPayload(draft);
      delete fields.ingestedAt;
      producerPayload = canonicalJson(fields);
    } catch {
      return { ok: false, status: "rejected", reason: "record payload cannot be encoded as canonical JSON" };
    }
    // Every stored string passes through the same redaction, including identity and reference fields.
    const metadata = redact(draft.metadata ?? {}) as Record<string, unknown>;
    // Authority is kept only when an ACS key signed exactly these fields, verified witness receipt, or explicit grant.
    const signed = await verifyProvenance(draft, canonicalJson, await this.#keys);
    const trustLevel: TrustLevel =
      UNGRANTED.has(draft.trustLevel) &&
      !signed &&
      !(verifiedWitnessGrant && draft.component === "jc-kernel-witness" && draft.trustLevel === "independently_verified") &&
      !this.#grantTrust(draft, draft.trustLevel)
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

    // Retry comparison keeps the original payload private and ignores the recorder's observation time.
    const fingerprint = await this.#fingerprint("payload", producerPayload);
    const evidenceHashClaim =
      typeof metadata.evidenceHash === "string" && /^[a-f0-9]{64}$/u.test(metadata.evidenceHash)
        ? metadata.evidenceHash
        : null;

    return {
      ok: true,
      prepared: {
        partial,
        payloadSha256,
        producerKey,
        fingerprint,
        evidenceHashClaim
      }
    };
  }

  async #ingestInternal(input: IngestDraft, verifiedWitnessGrant: boolean): Promise<IngestResult> {
    const prep = await this.prepareDraft(input, verifiedWitnessGrant);
    if (!prep.ok) {
      return { status: prep.status, reason: prep.reason };
    }
    const { partial, payloadSha256, producerKey, fingerprint, evidenceHashClaim } = prep.prepared;

    let result!: IngestResult;
    const runCommit = async (): Promise<void> => {
      const existingId = this.#byProducer.get(producerKey);
      if (existingId) {
        const existing = this.#events.get(existingId);
        if (!existing) throw new Error("producer index pointed at a missing event");
        if (this.#fingerprints.get(existingId) === fingerprint) {
          result = { status: "duplicate", event: existing };
          return;
        }
        this.#conflictedAt.set(existingId, partial.ingestedAt);
        if (this.#conflicts.length < this.#maxEvents) {
          this.#conflicts.push(Object.freeze({
            producerKey,
            existingEventId: existing.eventId,
            rejectedSha256: payloadSha256,
            ingestedAt: partial.ingestedAt
          }));
        }
        result = { status: "conflict", event: existing, rejectedSha256: payloadSha256 };
        return;
      }

      if (evidenceHashClaim && this.#seenEvidenceHashes.has(evidenceHashClaim)) {
        result = { status: "rejected", reason: "replayed evidenceHash under a different producer identity" };
        return;
      }
      if (this.#events.size >= this.#maxEvents) {
        result = { status: "rejected", reason: `store is at its ${this.#maxEvents}-record limit` };
        return;
      }
      if (this.#events.has(partial.eventId)) {
        result = { status: "rejected", reason: "recorder event identity collision" };
        return;
      }

      const seq = this.#seq + 1;
      const previousHash = this.#headHash;
      const eventHash = await computeEventHash(seq, previousHash, partial.eventId, payloadSha256);
      const event = deepFreeze({
        ...partial,
        evidence: { ...partial.evidence, payloadSha256, seq, previousHash, eventHash }
      }) as RecorderEvent;

      this.#seq = seq;
      this.#headHash = eventHash;
      this.#events.set(event.eventId, event);
      this.#byProducer.set(producerKey, event.eventId);
      this.#producerKeyByEventId.set(event.eventId, producerKey);
      this.#fingerprints.set(event.eventId, fingerprint);
      if (evidenceHashClaim) this.#seenEvidenceHashes.add(evidenceHashClaim);
      result = { status: "created", event };
    };

    const next = this.#commitQueue.then(runCommit, runCommit);
    this.#commitQueue = next.catch(() => undefined);
    await next;
    return result;
  }

  eventsFor(runId: string): RecorderEvent[] {
    return [...this.#events.values()].filter((event) => recorderRunId(event.runId, event.eventId) === runId);
  }

  async #fingerprint(domain: "identity" | "payload", content: string): Promise<string> {
    return computeRecorderFingerprint(domain, content);
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
