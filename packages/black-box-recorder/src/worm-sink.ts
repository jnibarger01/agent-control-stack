import { canonicalJson, envelopeForDigest, sha256Hex } from "./canonical.js";
import {
  verifyJcWitnessReceipt,
  type JcKernelWitnessReceipt
} from "./jc-witness-adapter.js";
import { ObserverKeyRegistry } from "./key-lifecycle.js";
import { computeEventHash, GENESIS_HASH } from "./store.js";
import type { RecorderEvent } from "./types.js";

export type WormReceiptEnvelope = {
  readonly schema: "acs.black-box.worm-envelope.v1";
  readonly seq: number;
  readonly eventId: string;
  readonly previousHash: string;
  readonly eventHash: string;
  readonly payloadSha256: string;
  readonly evidenceHash: string;
  readonly receiptSchema:
    | "jc.kernel-witness.receipt.v1"
    | "jc.kernel-witness.receipt.v2";
  readonly receipt: JcKernelWitnessReceipt;
  readonly recorderEvent: RecorderEvent;
  readonly producerKey: string;
  readonly fingerprint: string;
  readonly observerKeyId: string;
  readonly observerPublicKeyPem?: string;
  readonly anchoredAt: string;
};

export type WormChainHeadAnchor = {
  readonly schema: "acs.black-box.worm-head.v1";
  readonly seq: number;
  readonly headHash: string;
  readonly evidenceHash: string;
  readonly anchoredAt: string;
};

export type WormPutResult = {
  readonly status: "anchored" | "duplicate";
  readonly objectKey: string;
  readonly versionId: string;
  readonly etagSha256: string;
  readonly retentionMode: "COMPLIANCE" | "GOVERNANCE" | "FS_IMMUTABLE";
  readonly retainUntilIso: string;
};

export type WormIntegrityFindingKind =
  | "invalid_envelope"
  | "receipt_signature_invalid"
  | "payload_hash_mismatch"
  | "event_hash_mismatch"
  | "sequence_gap"
  | "sequence_reorder"
  | "previous_hash_mismatch"
  | "head_anchor_mismatch"
  | "conflicting_write";

export type WormIntegrityFinding = {
  readonly kind: WormIntegrityFindingKind;
  readonly seq?: number;
  readonly eventId?: string;
  readonly detail: string;
};

export type WormIntegrityReport = {
  readonly valid: boolean;
  readonly receiptCount: number;
  readonly headSeq: number;
  readonly headHash: string;
  readonly findings: readonly WormIntegrityFinding[];
};

export class WormTamperOrConflictError extends Error {
  readonly kind: WormIntegrityFindingKind;
  readonly seq?: number;

  constructor(kind: WormIntegrityFindingKind, detail: string, seq?: number) {
    super(`WORM integrity violation (${kind}): ${detail}`);
    this.name = "WormTamperOrConflictError";
    this.kind = kind;
    this.seq = seq;
  }
}

export interface WormEvidenceSink {
  readonly providerId: string;
  putReceiptEnvelope(envelope: WormReceiptEnvelope): Promise<WormPutResult>;
  putChainHeadAnchor(anchor: WormChainHeadAnchor): Promise<WormPutResult>;
  getReceiptEnvelope(seq: number): Promise<WormReceiptEnvelope | null>;
  listReceiptEnvelopes(options?: {
    fromSeq?: number;
    toSeq?: number;
  }): Promise<readonly WormReceiptEnvelope[]>;
  getChainHeadAnchor(): Promise<WormChainHeadAnchor | null>;
  verifySinkIntegrity(
    keyRegistry?: ObserverKeyRegistry
  ): Promise<WormIntegrityReport>;
}

export function canonicalWormEnvelopeIdentity(
  envelope: WormReceiptEnvelope
): string {
  return canonicalJson({
    schema: envelope.schema,
    seq: envelope.seq,
    eventId: envelope.eventId,
    previousHash: envelope.previousHash,
    eventHash: envelope.eventHash,
    payloadSha256: envelope.payloadSha256,
    evidenceHash: envelope.evidenceHash,
    receiptSchema: envelope.receiptSchema,
    receipt: envelope.receipt,
    recorderEvent: envelope.recorderEvent,
    producerKey: envelope.producerKey,
    fingerprint: envelope.fingerprint,
    observerKeyId: envelope.observerKeyId
  });
}

export async function verifyWormReceiptEnvelope(
  envelope: WormReceiptEnvelope,
  keyRegistry?: ObserverKeyRegistry
): Promise<WormIntegrityFinding[]> {
  const findings: WormIntegrityFinding[] = [];
  if (
    !envelope ||
    typeof envelope !== "object" ||
    envelope.schema !== "acs.black-box.worm-envelope.v1"
  ) {
    findings.push({
      kind: "invalid_envelope",
      detail: "envelope schema must be acs.black-box.worm-envelope.v1"
    });
    return findings;
  }

  const ev = envelope.recorderEvent;
  if (!ev || typeof ev !== "object" || !ev.evidence) {
    findings.push({
      kind: "invalid_envelope",
      seq: envelope.seq,
      detail: "envelope is missing recorderEvent.evidence"
    });
    return findings;
  }

  if (
    envelope.seq !== ev.evidence.seq ||
    envelope.eventId !== ev.eventId ||
    envelope.previousHash !== ev.evidence.previousHash ||
    envelope.eventHash !== ev.evidence.eventHash ||
    envelope.payloadSha256 !== ev.evidence.payloadSha256
  ) {
    findings.push({
      kind: "invalid_envelope",
      seq: envelope.seq,
      eventId: envelope.eventId,
      detail: "envelope header fields do not match recorderEvent.evidence"
    });
  }

  const recomputedPayloadSha256 = await sha256Hex(envelopeForDigest(ev));
  if (recomputedPayloadSha256 !== envelope.payloadSha256) {
    findings.push({
      kind: "payload_hash_mismatch",
      seq: envelope.seq,
      eventId: envelope.eventId,
      detail: `payloadSha256 mismatch for seq ${envelope.seq}`
    });
  }

  const recomputedEventHash = await computeEventHash(
    envelope.seq,
    envelope.previousHash,
    envelope.eventId,
    envelope.payloadSha256
  );
  if (recomputedEventHash !== envelope.eventHash) {
    findings.push({
      kind: "event_hash_mismatch",
      seq: envelope.seq,
      eventId: envelope.eventId,
      detail: `eventHash mismatch for seq ${envelope.seq}`
    });
  }

  let registryToUse = keyRegistry;
  if (!registryToUse && typeof envelope.observerPublicKeyPem === "string") {
    const tempRegistry = new ObserverKeyRegistry();
    await tempRegistry.registerKey({
      keyId: envelope.observerKeyId,
      observerId: envelope.receipt.observerId,
      publicKeyPem: envelope.observerPublicKeyPem,
      registeredAt: "1970-01-01T00:00:00.000Z"
    });
    registryToUse = tempRegistry;
  }

  if (!registryToUse) {
    findings.push({
      kind: "receipt_signature_invalid",
      seq: envelope.seq,
      eventId: envelope.eventId,
      detail: `no observer key registry or embedded public key available to verify seq ${envelope.seq}`
    });
  } else {
    const verification = await verifyJcWitnessReceipt(envelope.receipt, {
      keyRegistry: registryToUse
    });
    if (!verification.valid) {
      findings.push({
        kind: "receipt_signature_invalid",
        seq: envelope.seq,
        eventId: envelope.eventId,
        detail: `witness receipt cryptographic verification failed at seq ${envelope.seq}: ${verification.reasons.join("; ")}`
      });
    } else if (verification.receipt.evidenceHash !== envelope.evidenceHash) {
      findings.push({
        kind: "receipt_signature_invalid",
        seq: envelope.seq,
        eventId: envelope.eventId,
        detail: `envelope evidenceHash does not match receipt evidenceHash at seq ${envelope.seq}`
      });
    }
  }

  return findings;
}

export async function verifyWormEnvelopeSequence(
  envelopes: readonly WormReceiptEnvelope[],
  headAnchor: WormChainHeadAnchor | null,
  keyRegistry?: ObserverKeyRegistry
): Promise<WormIntegrityReport> {
  const findings: WormIntegrityFinding[] = [];
  let expectedSeq = 1;
  let expectedPrev = GENESIS_HASH;
  let headSeq = 0;
  let headHash = GENESIS_HASH;

  for (const envelope of envelopes) {
    if (envelope.seq !== expectedSeq) {
      const kind =
        envelope.seq < expectedSeq ? "sequence_reorder" : "sequence_gap";
      findings.push({
        kind,
        seq: envelope.seq,
        eventId: envelope.eventId,
        detail: `expected seq ${expectedSeq}, got ${envelope.seq}`
      });
    }
    if (envelope.previousHash !== expectedPrev) {
      findings.push({
        kind: "previous_hash_mismatch",
        seq: envelope.seq,
        eventId: envelope.eventId,
        detail: `expected previousHash ${expectedPrev}, got ${envelope.previousHash}`
      });
    }
    const envFindings = await verifyWormReceiptEnvelope(envelope, keyRegistry);
    findings.push(...envFindings);

    expectedSeq = envelope.seq + 1;
    expectedPrev = envelope.eventHash;
    headSeq = envelope.seq;
    headHash = envelope.eventHash;
  }

  if (headAnchor) {
    if (headAnchor.seq !== headSeq || headAnchor.headHash !== headHash) {
      findings.push({
        kind: "head_anchor_mismatch",
        seq: headAnchor.seq,
        detail: `head anchor (seq=${headAnchor.seq}, headHash=${headAnchor.headHash}) does not match chain tail (seq=${headSeq}, headHash=${headHash})`
      });
    }
  } else if (envelopes.length > 0) {
    findings.push({
      kind: "head_anchor_mismatch",
      seq: headSeq,
      detail: "receipts are present in WORM sink but chain head anchor is missing"
    });
  }

  return {
    valid: findings.length === 0,
    receiptCount: envelopes.length,
    headSeq,
    headHash,
    findings
  };
}

function formatSeqKey(seq: number): string {
  return String(seq).padStart(8, "0");
}

function defaultRetainUntilIso(retentionDays = 365): string {
  return new Date(Date.now() + retentionDays * 86_400_000).toISOString();
}

export type ImmutableFsWormSinkOptions = {
  readonly rootDir: string;
  readonly retentionDays?: number;
  readonly keyRegistry?: ObserverKeyRegistry;
};

/**
 * Write-once local filesystem WORM sink using O_CREAT | O_EXCL ("wx") and 0444 permissions.
 * Verifies cryptographic receipt signature and hash-chain contiguity before persisting.
 */
export class ImmutableFsWormSink implements WormEvidenceSink {
  readonly providerId = "fs-immutable-worm";
  readonly #rootDir: string;
  readonly #retentionDays: number;
  readonly #keyRegistry?: ObserverKeyRegistry;

  constructor(options: ImmutableFsWormSinkOptions) {
    this.#rootDir = options.rootDir;
    this.#retentionDays = options.retentionDays ?? 365;
    this.#keyRegistry = options.keyRegistry;
  }

  get rootDir(): string {
    return this.#rootDir;
  }

  async #ensureDirs(): Promise<{
    fs: typeof import("node:fs");
    path: typeof import("node:path");
    receiptsDir: string;
    headsDir: string;
  }> {
    const fs = await import(/* @vite-ignore */ "node:fs");
    const path = await import(/* @vite-ignore */ "node:path");
    const receiptsDir = path.join(this.#rootDir, "receipts");
    const headsDir = path.join(this.#rootDir, "heads");
    fs.mkdirSync(receiptsDir, { recursive: true });
    fs.mkdirSync(headsDir, { recursive: true });
    return { fs, path, receiptsDir, headsDir };
  }

  async putReceiptEnvelope(
    envelope: WormReceiptEnvelope
  ): Promise<WormPutResult> {
    const { fs, path, receiptsDir } = await this.#ensureDirs();

    const envFindings = await verifyWormReceiptEnvelope(
      envelope,
      this.#keyRegistry
    );
    if (envFindings.length > 0) {
      throw new WormTamperOrConflictError(
        envFindings[0]!.kind,
        envFindings.map((f) => f.detail).join("; "),
        envelope.seq
      );
    }

    const prefix = `seq-${formatSeqKey(envelope.seq)}-`;
    const existingFiles = fs
      .readdirSync(receiptsDir)
      .filter((name) => name.startsWith(prefix) && name.endsWith(".json"));

    const incomingIdentity = canonicalWormEnvelopeIdentity(envelope);
    const incomingSha = await sha256Hex(incomingIdentity);
    const retainUntilIso = defaultRetainUntilIso(this.#retentionDays);

    if (existingFiles.length > 0) {
      const existingFile = existingFiles[0]!;
      const existingPath = path.join(receiptsDir, existingFile);
      let existingParsed: WormReceiptEnvelope;
      try {
        existingParsed = JSON.parse(
          fs.readFileSync(existingPath, "utf8")
        ) as WormReceiptEnvelope;
      } catch {
        throw new WormTamperOrConflictError(
          "invalid_envelope",
          `corrupted existing WORM file ${existingFile}`,
          envelope.seq
        );
      }
      const existingFindings = await verifyWormReceiptEnvelope(
        existingParsed,
        this.#keyRegistry
      );
      if (existingFindings.length > 0) {
        throw new WormTamperOrConflictError(
          existingFindings[0]!.kind,
          `tampered existing WORM file ${existingFile}: ${existingFindings.map((f) => f.detail).join("; ")}`,
          envelope.seq
        );
      }
      const existingSha = await sha256Hex(
        canonicalWormEnvelopeIdentity(existingParsed)
      );
      if (existingSha === incomingSha) {
        return {
          status: "duplicate",
          objectKey: `receipts/${existingFile}`,
          versionId: `v1-${existingSha.slice(0, 16)}`,
          etagSha256: existingSha,
          retentionMode: "FS_IMMUTABLE",
          retainUntilIso
        };
      }
      throw new WormTamperOrConflictError(
        "conflicting_write",
        `conflicting WORM envelope for seq ${envelope.seq} (existing=${existingSha}, incoming=${incomingSha})`,
        envelope.seq
      );
    }

    // Verify contiguity with seq - 1
    if (envelope.seq === 1) {
      if (envelope.previousHash !== GENESIS_HASH) {
        throw new WormTamperOrConflictError(
          "previous_hash_mismatch",
          `seq 1 must reference GENESIS_HASH, got ${envelope.previousHash}`,
          1
        );
      }
    } else if (envelope.seq > 1) {
      const prev = await this.getReceiptEnvelope(envelope.seq - 1);
      if (!prev) {
        throw new WormTamperOrConflictError(
          "sequence_gap",
          `cannot anchor seq ${envelope.seq} before seq ${envelope.seq - 1}`,
          envelope.seq
        );
      }
      if (envelope.previousHash !== prev.eventHash) {
        throw new WormTamperOrConflictError(
          "previous_hash_mismatch",
          `seq ${envelope.seq} previousHash ${envelope.previousHash} does not match seq ${prev.seq} eventHash ${prev.eventHash}`,
          envelope.seq
        );
      }
    } else {
      throw new WormTamperOrConflictError(
        "sequence_gap",
        `invalid seq ${envelope.seq}`,
        envelope.seq
      );
    }

    const fileName = `seq-${formatSeqKey(envelope.seq)}-${envelope.eventId}.json`;
    const filePath = path.join(receiptsDir, fileName);
    const serialized = canonicalJson(envelope);
    try {
      fs.writeFileSync(filePath, serialized, { encoding: "utf8", flag: "wx", mode: 0o444 });
      fs.chmodSync(filePath, 0o444);
    } catch (err) {
      throw new WormTamperOrConflictError(
        "conflicting_write",
        `write-once creation failed for ${fileName}: ${err instanceof Error ? err.message : String(err)}`,
        envelope.seq
      );
    }

    return {
      status: "anchored",
      objectKey: `receipts/${fileName}`,
      versionId: `v1-${incomingSha.slice(0, 16)}`,
      etagSha256: incomingSha,
      retentionMode: "FS_IMMUTABLE",
      retainUntilIso
    };
  }

  async putChainHeadAnchor(anchor: WormChainHeadAnchor): Promise<WormPutResult> {
    const { fs, path, headsDir } = await this.#ensureDirs();
    if (anchor.schema !== "acs.black-box.worm-head.v1") {
      throw new WormTamperOrConflictError(
        "invalid_envelope",
        "invalid head anchor schema",
        anchor.seq
      );
    }
    const targetEnvelope = await this.getReceiptEnvelope(anchor.seq);
    if (!targetEnvelope || targetEnvelope.eventHash !== anchor.headHash) {
      throw new WormTamperOrConflictError(
        "head_anchor_mismatch",
        `head anchor seq=${anchor.seq} headHash=${anchor.headHash} does not match stored receipt`,
        anchor.seq
      );
    }

    const fileName = `head-${formatSeqKey(anchor.seq)}-${anchor.headHash.slice(0, 16)}.json`;
    const filePath = path.join(headsDir, fileName);
    const serialized = canonicalJson(anchor);
    const etagSha256 = await sha256Hex(
      canonicalJson({
        schema: anchor.schema,
        seq: anchor.seq,
        headHash: anchor.headHash,
        evidenceHash: anchor.evidenceHash
      })
    );
    const retainUntilIso = defaultRetainUntilIso(this.#retentionDays);

    let status: "anchored" | "duplicate" = "anchored";
    if (fs.existsSync(filePath)) {
      status = "duplicate";
    } else {
      fs.writeFileSync(filePath, serialized, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o444
      });
      fs.chmodSync(filePath, 0o444);
    }

    const currentLatest = await this.getChainHeadAnchor();
    if (currentLatest && currentLatest.seq > anchor.seq) {
      throw new WormTamperOrConflictError(
        "sequence_reorder",
        `cannot regress chain head anchor from seq ${currentLatest.seq} to ${anchor.seq}`,
        anchor.seq
      );
    }
    if (
      currentLatest &&
      currentLatest.seq === anchor.seq &&
      currentLatest.headHash !== anchor.headHash
    ) {
      throw new WormTamperOrConflictError(
        "head_anchor_mismatch",
        `conflicting head anchor at seq ${anchor.seq}`,
        anchor.seq
      );
    }

    const latestPath = path.join(headsDir, "latest.json");
    const tmpPath = path.join(headsDir, `latest.tmp.${process.pid}.${Date.now()}`);
    fs.writeFileSync(tmpPath, serialized, { encoding: "utf8", mode: 0o644 });
    fs.renameSync(tmpPath, latestPath);

    return {
      status,
      objectKey: `heads/${fileName}`,
      versionId: `v1-${etagSha256.slice(0, 16)}`,
      etagSha256,
      retentionMode: "FS_IMMUTABLE",
      retainUntilIso
    };
  }

  async getReceiptEnvelope(seq: number): Promise<WormReceiptEnvelope | null> {
    const { fs, path, receiptsDir } = await this.#ensureDirs();
    const prefix = `seq-${formatSeqKey(seq)}-`;
    const matches = fs
      .readdirSync(receiptsDir)
      .filter((name) => name.startsWith(prefix) && name.endsWith(".json"));
    if (matches.length === 0) return null;
    const raw = fs.readFileSync(path.join(receiptsDir, matches[0]!), "utf8");
    return JSON.parse(raw) as WormReceiptEnvelope;
  }

  async listReceiptEnvelopes(options?: {
    fromSeq?: number;
    toSeq?: number;
  }): Promise<readonly WormReceiptEnvelope[]> {
    const { fs, path, receiptsDir } = await this.#ensureDirs();
    const files = fs
      .readdirSync(receiptsDir)
      .filter((name) => name.startsWith("seq-") && name.endsWith(".json"))
      .sort();
    const out: WormReceiptEnvelope[] = [];
    for (const file of files) {
      const raw = fs.readFileSync(path.join(receiptsDir, file), "utf8");
      const env = JSON.parse(raw) as WormReceiptEnvelope;
      if (options?.fromSeq !== undefined && env.seq < options.fromSeq) continue;
      if (options?.toSeq !== undefined && env.seq > options.toSeq) continue;
      out.push(env);
    }
    return out;
  }

  async getChainHeadAnchor(): Promise<WormChainHeadAnchor | null> {
    const { fs, path, headsDir } = await this.#ensureDirs();
    const latestPath = path.join(headsDir, "latest.json");
    if (!fs.existsSync(latestPath)) return null;
    const raw = fs.readFileSync(latestPath, "utf8");
    return JSON.parse(raw) as WormChainHeadAnchor;
  }

  async verifySinkIntegrity(
    keyRegistry?: ObserverKeyRegistry
  ): Promise<WormIntegrityReport> {
    const { fs, path, receiptsDir } = await this.#ensureDirs();
    const files = fs
      .readdirSync(receiptsDir)
      .filter((name) => name.startsWith("seq-") && name.endsWith(".json"))
      .sort();
    const findings: WormIntegrityFinding[] = [];
    const envelopes: WormReceiptEnvelope[] = [];
    const seenSeqs = new Set<number>();

    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(receiptsDir, file), "utf8");
        const parsed = JSON.parse(raw) as WormReceiptEnvelope;
        if (seenSeqs.has(parsed.seq)) {
          findings.push({
            kind: "conflicting_write",
            seq: parsed.seq,
            eventId: parsed.eventId,
            detail: `multiple WORM files found for seq ${parsed.seq}`
          });
        }
        seenSeqs.add(parsed.seq);
        envelopes.push(parsed);
      } catch (err) {
        findings.push({
          kind: "invalid_envelope",
          detail: `failed to parse WORM receipt file ${file}: ${err instanceof Error ? err.message : String(err)}`
        });
      }
    }

    const headAnchor = await this.getChainHeadAnchor();
    const seqReport = await verifyWormEnvelopeSequence(
      envelopes,
      headAnchor,
      keyRegistry ?? this.#keyRegistry
    );
    const allFindings = [...findings, ...seqReport.findings];
    return {
      valid: allFindings.length === 0,
      receiptCount: envelopes.length,
      headSeq: seqReport.headSeq,
      headHash: seqReport.headHash,
      findings: allFindings
    };
  }
}

export type S3ObjectLockWormSinkOptions = {
  readonly endpointUrl: string;
  readonly bucket: string;
  readonly prefix?: string;
  readonly retentionMode?: "COMPLIANCE" | "GOVERNANCE";
  readonly retentionDays?: number;
  readonly keyRegistry?: ObserverKeyRegistry;
  readonly fetchImpl?: typeof fetch;
  readonly headers?: Readonly<Record<string, string>>;
};

async function sha256Base64(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

/**
 * Provider-neutral S3 Object Lock WORM sink using HTTP PUT with:
 * - x-amz-object-lock-mode: COMPLIANCE | GOVERNANCE
 * - x-amz-object-lock-retain-until-date: <ISO-8601>
 * - x-amz-checksum-sha256: <base64-sha256>
 * - If-None-Match: "*"
 */
export class S3ObjectLockWormSink implements WormEvidenceSink {
  readonly providerId = "s3-object-lock-worm";
  readonly #endpointUrl: string;
  readonly #bucket: string;
  readonly #prefix: string;
  readonly #retentionMode: "COMPLIANCE" | "GOVERNANCE";
  readonly #retentionDays: number;
  readonly #keyRegistry?: ObserverKeyRegistry;
  readonly #fetch: typeof fetch;
  readonly #headers: Readonly<Record<string, string>>;

  constructor(options: S3ObjectLockWormSinkOptions) {
    this.#endpointUrl = options.endpointUrl.replace(/\/+$/u, "");
    this.#bucket = options.bucket;
    this.#prefix = (options.prefix ?? "acs-black-box").replace(/^\/+|\/+$/gu, "");
    this.#retentionMode = options.retentionMode ?? "COMPLIANCE";
    this.#retentionDays = options.retentionDays ?? 365;
    this.#keyRegistry = options.keyRegistry;
    this.#fetch = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.#headers = options.headers ?? {};
  }

  #objectUrl(key: string): string {
    return `${this.#endpointUrl}/${this.#bucket}/${this.#prefix}/${key}`;
  }

  async putReceiptEnvelope(
    envelope: WormReceiptEnvelope
  ): Promise<WormPutResult> {
    const envFindings = await verifyWormReceiptEnvelope(
      envelope,
      this.#keyRegistry
    );
    if (envFindings.length > 0) {
      throw new WormTamperOrConflictError(
        envFindings[0]!.kind,
        envFindings.map((f) => f.detail).join("; "),
        envelope.seq
      );
    }

    if (envelope.seq === 1) {
      if (envelope.previousHash !== GENESIS_HASH) {
        throw new WormTamperOrConflictError(
          "previous_hash_mismatch",
          `seq 1 must reference GENESIS_HASH, got ${envelope.previousHash}`,
          1
        );
      }
    } else if (envelope.seq > 1) {
      const prev = await this.getReceiptEnvelope(envelope.seq - 1);
      if (!prev) {
        throw new WormTamperOrConflictError(
          "sequence_gap",
          `cannot anchor seq ${envelope.seq} before seq ${envelope.seq - 1}`,
          envelope.seq
        );
      }
      if (envelope.previousHash !== prev.eventHash) {
        throw new WormTamperOrConflictError(
          "previous_hash_mismatch",
          `seq ${envelope.seq} previousHash ${envelope.previousHash} does not match seq ${prev.seq} eventHash ${prev.eventHash}`,
          envelope.seq
        );
      }
    }

    const objectKey = `receipts/seq-${formatSeqKey(envelope.seq)}.json`;
    const body = canonicalJson(envelope);
    const checksumB64 = await sha256Base64(body);
    const identitySha = await sha256Hex(canonicalWormEnvelopeIdentity(envelope));
    const retainUntilIso = defaultRetainUntilIso(this.#retentionDays);

    const response = await this.#fetch(this.#objectUrl(objectKey), {
      method: "PUT",
      headers: {
        ...this.#headers,
        "content-type": "application/json",
        "if-none-match": "*",
        "x-amz-object-lock-mode": this.#retentionMode,
        "x-amz-object-lock-retain-until-date": retainUntilIso,
        "x-amz-checksum-sha256": checksumB64
      },
      body
    });

    if (response.status === 409 || response.status === 412) {
      const existing = await this.getReceiptEnvelope(envelope.seq);
      if (existing) {
        const existingSha = await sha256Hex(
          canonicalWormEnvelopeIdentity(existing)
        );
        if (existingSha === identitySha) {
          return {
            status: "duplicate",
            objectKey: `${this.#prefix}/${objectKey}`,
            versionId:
              response.headers.get("x-amz-version-id") ??
              `v1-${existingSha.slice(0, 16)}`,
            etagSha256: existingSha,
            retentionMode: this.#retentionMode,
            retainUntilIso
          };
        }
      }
      throw new WormTamperOrConflictError(
        "conflicting_write",
        `S3 Object Lock rejected conflicting overwrite for seq ${envelope.seq}`,
        envelope.seq
      );
    }

    if (!response.ok) {
      throw new Error(
        `S3 Object Lock PUT failed with HTTP ${response.status} for ${objectKey}`
      );
    }

    return {
      status: "anchored",
      objectKey: `${this.#prefix}/${objectKey}`,
      versionId:
        response.headers.get("x-amz-version-id") ??
        `v1-${identitySha.slice(0, 16)}`,
      etagSha256: identitySha,
      retentionMode: this.#retentionMode,
      retainUntilIso
    };
  }

  async putChainHeadAnchor(anchor: WormChainHeadAnchor): Promise<WormPutResult> {
    const targetEnvelope = await this.getReceiptEnvelope(anchor.seq);
    if (!targetEnvelope || targetEnvelope.eventHash !== anchor.headHash) {
      throw new WormTamperOrConflictError(
        "head_anchor_mismatch",
        `head anchor seq=${anchor.seq} headHash=${anchor.headHash} does not match stored receipt`,
        anchor.seq
      );
    }

    const currentLatest = await this.getChainHeadAnchor();
    if (currentLatest && currentLatest.seq > anchor.seq) {
      throw new WormTamperOrConflictError(
        "sequence_reorder",
        `cannot regress chain head anchor from seq ${currentLatest.seq} to ${anchor.seq}`,
        anchor.seq
      );
    }

    const objectKey = `heads/head-${formatSeqKey(anchor.seq)}.json`;
    const body = canonicalJson(anchor);
    const checksumB64 = await sha256Base64(body);
    const etagSha256 = await sha256Hex(body);
    const retainUntilIso = defaultRetainUntilIso(this.#retentionDays);

    const response = await this.#fetch(this.#objectUrl(objectKey), {
      method: "PUT",
      headers: {
        ...this.#headers,
        "content-type": "application/json",
        "if-none-match": "*",
        "x-amz-object-lock-mode": this.#retentionMode,
        "x-amz-object-lock-retain-until-date": retainUntilIso,
        "x-amz-checksum-sha256": checksumB64
      },
      body
    });

    const status =
      response.status === 409 || response.status === 412
        ? "duplicate"
        : "anchored";
    if (!response.ok && status !== "duplicate") {
      throw new Error(
        `S3 Object Lock head PUT failed with HTTP ${response.status}`
      );
    }

    await this.#fetch(this.#objectUrl("heads/latest.json"), {
      method: "PUT",
      headers: {
        ...this.#headers,
        "content-type": "application/json",
        "x-amz-object-lock-mode": this.#retentionMode,
        "x-amz-object-lock-retain-until-date": retainUntilIso,
        "x-amz-checksum-sha256": checksumB64
      },
      body
    });

    return {
      status,
      objectKey: `${this.#prefix}/${objectKey}`,
      versionId:
        response.headers.get("x-amz-version-id") ??
        `v1-${etagSha256.slice(0, 16)}`,
      etagSha256,
      retentionMode: this.#retentionMode,
      retainUntilIso
    };
  }

  async getReceiptEnvelope(seq: number): Promise<WormReceiptEnvelope | null> {
    const objectKey = `receipts/seq-${formatSeqKey(seq)}.json`;
    const response = await this.#fetch(this.#objectUrl(objectKey), {
      method: "GET",
      headers: this.#headers
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`S3 Object Lock GET failed with HTTP ${response.status}`);
    }
    return (await response.json()) as WormReceiptEnvelope;
  }

  async listReceiptEnvelopes(options?: {
    fromSeq?: number;
    toSeq?: number;
  }): Promise<readonly WormReceiptEnvelope[]> {
    const response = await this.#fetch(
      `${this.#objectUrl("receipts")}?list-type=2`,
      {
        method: "GET",
        headers: this.#headers
      }
    );
    if (response.status === 404) return [];
    if (!response.ok) {
      throw new Error(
        `S3 Object Lock LIST failed with HTTP ${response.status}`
      );
    }
    const items = (await response.json()) as WormReceiptEnvelope[];
    return items
      .filter((env) => {
        if (options?.fromSeq !== undefined && env.seq < options.fromSeq)
          return false;
        if (options?.toSeq !== undefined && env.seq > options.toSeq) return false;
        return true;
      })
      .sort((a, b) => a.seq - b.seq);
  }

  async getChainHeadAnchor(): Promise<WormChainHeadAnchor | null> {
    const response = await this.#fetch(this.#objectUrl("heads/latest.json"), {
      method: "GET",
      headers: this.#headers
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(
        `S3 Object Lock head GET failed with HTTP ${response.status}`
      );
    }
    return (await response.json()) as WormChainHeadAnchor;
  }

  async verifySinkIntegrity(
    keyRegistry?: ObserverKeyRegistry
  ): Promise<WormIntegrityReport> {
    const envelopes = await this.listReceiptEnvelopes();
    const headAnchor = await this.getChainHeadAnchor();
    return verifyWormEnvelopeSequence(
      envelopes,
      headAnchor,
      keyRegistry ?? this.#keyRegistry
    );
  }
}

/**
 * Disposable S3 Object Lock test server / fetch handler enforcing:
 * - x-amz-object-lock-mode (COMPLIANCE | GOVERNANCE)
 * - x-amz-object-lock-retain-until-date
 * - x-amz-checksum-sha256 verification
 * - If-None-Match: "*" write-once lock (412 Precondition Failed on overwrite)
 * - 403 AccessDenied on DELETE of locked objects
 */
export function createS3ObjectLockTestHandler(): {
  fetchImpl: typeof fetch;
  objects: Map<
    string,
    {
      body: string;
      lockMode: string;
      retainUntil: string;
      versionId: string;
    }
  >;
} {
  const objects = new Map<
    string,
    {
      body: string;
      lockMode: string;
      retainUntil: string;
      versionId: string;
    }
  >();

  const fetchImpl: typeof fetch = async (input, init) => {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(urlStr);
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);

    if (method === "GET" && url.searchParams.get("list-type") === "2") {
      const prefixPath = `${url.pathname.replace(/\/+$/u, "")}/`;
      const items: unknown[] = [];
      const sortedKeys = [...objects.keys()].sort();
      for (const key of sortedKeys) {
        if (key.startsWith(prefixPath)) {
          items.push(JSON.parse(objects.get(key)!.body));
        }
      }
      return new Response(JSON.stringify(items), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    if (method === "GET") {
      const entry = objects.get(url.pathname);
      if (!entry) {
        return new Response("Not Found", { status: 404 });
      }
      return new Response(entry.body, {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-amz-version-id": entry.versionId,
          "x-amz-object-lock-mode": entry.lockMode,
          "x-amz-object-lock-retain-until-date": entry.retainUntil
        }
      });
    }

    if (method === "DELETE") {
      const entry = objects.get(url.pathname);
      if (entry && (entry.lockMode === "COMPLIANCE" || entry.lockMode === "GOVERNANCE")) {
        return new Response("Object Lock prohibits deletion", { status: 403 });
      }
      objects.delete(url.pathname);
      return new Response(null, { status: 204 });
    }

    if (method === "PUT") {
      const lockMode = headers.get("x-amz-object-lock-mode") ?? "";
      const retainUntil = headers.get("x-amz-object-lock-retain-until-date") ?? "";
      const checksumHeader = headers.get("x-amz-checksum-sha256") ?? "";
      const ifNoneMatch = headers.get("if-none-match");

      if (lockMode !== "COMPLIANCE" && lockMode !== "GOVERNANCE") {
        return new Response("Missing or invalid x-amz-object-lock-mode", {
          status: 400
        });
      }
      if (!retainUntil || Number.isNaN(Date.parse(retainUntil))) {
        return new Response("Missing or invalid x-amz-object-lock-retain-until-date", {
          status: 400
        });
      }
      const bodyStr = typeof init?.body === "string" ? init.body : "";
      const expectedChecksum = await sha256Base64(bodyStr);
      if (checksumHeader !== expectedChecksum) {
        return new Response("BadDigest: x-amz-checksum-sha256 mismatch", {
          status: 400
        });
      }

      if (ifNoneMatch === "*" && objects.has(url.pathname)) {
        return new Response("PreconditionFailed: Object already exists", {
          status: 412
        });
      }

      const existing = objects.get(url.pathname);
      if (
        existing &&
        !url.pathname.endsWith("/heads/latest.json") &&
        (existing.lockMode === "COMPLIANCE" || existing.lockMode === "GOVERNANCE")
      ) {
        return new Response("Conflict: WORM object is locked", { status: 409 });
      }

      const bodySha = await sha256Hex(bodyStr);
      const versionId = `v1-${bodySha.slice(0, 16)}`;
      objects.set(url.pathname, {
        body: bodyStr,
        lockMode,
        retainUntil,
        versionId
      });

      return new Response(null, {
        status: 200,
        headers: {
          "x-amz-version-id": versionId,
          etag: `"${bodySha}"`
        }
      });
    }

    return new Response("Method Not Allowed", { status: 405 });
  };

  return { fetchImpl, objects };
}
