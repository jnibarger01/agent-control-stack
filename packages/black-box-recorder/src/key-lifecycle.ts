import { sha256Hex } from "./canonical.js";
import { importTrustedKey } from "./provenance.js";

export type ObserverKeyStatus = "active" | "rotated" | "retired" | "revoked";

export type ObserverKeyRecord = {
  keyId: string;
  observerId: string;
  publicKeyPem: string;
  publicKeyFingerprintSha256?: string | null;
  status: ObserverKeyStatus;
  registeredAt: string;
  registeredBy: string;
  rotatedAt: string | null;
  rotatedToKeyId: string | null;
  retiredAt?: string | null;
  retiredBy?: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  revocationReason: string | null;
  auditEventId: string | null;
};

export type KeyEvaluationResult =
  | { allowed: true; status: "active" | "rotated"; record: ObserverKeyRecord }
  | { allowed: false; status: ObserverKeyStatus | "unknown"; reason: string; record?: ObserverKeyRecord };

const PRIVATE_KEY_MARKER_RE = /BEGIN\s+(?:[A-Z0-9]+\s+)?PRIVATE\s+KEY/i;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/u;

export async function computeSpkiFingerprintSha256(publicKeyPem: string): Promise<string> {
  const b64 = publicKeyPem
    .replace(/-----BEGIN PUBLIC KEY-----/g, "")
    .replace(/-----END PUBLIC KEY-----/g, "")
    .replace(/\s+/g, "");
  const binary = atob(b64);
  const derBytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  const digest = await crypto.subtle.digest("SHA-256", derBytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function validatePublicKeyCustody(publicKeyPem: string): Promise<CryptoKey> {
  if (typeof publicKeyPem !== "string" || publicKeyPem.trim().length === 0) {
    throw new Error("publicKeyPem must be a non-empty string");
  }
  if (PRIVATE_KEY_MARKER_RE.test(publicKeyPem)) {
    throw new Error("private key material must never be registered in the public observer key registry");
  }
  try {
    return await importTrustedKey(publicKeyPem);
  } catch {
    throw new Error("publicKeyPem is not a valid Ed25519 SPKI public key");
  }
}

export class ObserverKeyRegistry {
  readonly #records = new Map<string, ObserverKeyRecord>();

  constructor(initial: readonly ObserverKeyRecord[] = []) {
    for (const rec of initial) {
      this.#records.set(
        rec.keyId,
        Object.freeze({
          ...rec,
          publicKeyFingerprintSha256: rec.publicKeyFingerprintSha256 ?? null,
          retiredAt: rec.retiredAt ?? null,
          retiredBy: rec.retiredBy ?? null
        })
      );
    }
  }

  get(keyId: string): ObserverKeyRecord | undefined {
    return this.#records.get(keyId);
  }

  list(): ObserverKeyRecord[] {
    return [...this.#records.values()].map((r) => ({ ...r }));
  }

  async registerKey(input: {
    keyId: string;
    observerId: string;
    publicKeyPem: string;
    expectedFingerprintSha256?: string;
    registeredAt?: string;
    registeredBy?: string;
    auditEventId?: string | null;
  }): Promise<ObserverKeyRecord> {
    if (!ID_RE.test(input.keyId)) throw new Error("invalid keyId");
    if (!ID_RE.test(input.observerId)) throw new Error("invalid observerId");
    if (this.#records.has(input.keyId)) {
      throw new Error(`observer key '${input.keyId}' is already registered`);
    }
    await validatePublicKeyCustody(input.publicKeyPem);
    const fingerprint = await computeSpkiFingerprintSha256(input.publicKeyPem);
    if (input.expectedFingerprintSha256 !== undefined) {
      if (!SHA256_HEX_RE.test(input.expectedFingerprintSha256) || input.expectedFingerprintSha256 !== fingerprint) {
        throw new Error(`publicKeyPem SPKI fingerprint mismatch for key '${input.keyId}'`);
      }
    }
    const record: ObserverKeyRecord = Object.freeze({
      keyId: input.keyId,
      observerId: input.observerId,
      publicKeyPem: input.publicKeyPem,
      publicKeyFingerprintSha256: fingerprint,
      status: "active",
      registeredAt: input.registeredAt ?? new Date().toISOString(),
      registeredBy: input.registeredBy ?? "system",
      rotatedAt: null,
      rotatedToKeyId: null,
      retiredAt: null,
      retiredBy: null,
      revokedAt: null,
      revokedBy: null,
      revocationReason: null,
      auditEventId: input.auditEventId ?? null
    });
    this.#records.set(record.keyId, record);
    return record;
  }

  async rotateKey(input: {
    oldKeyId: string;
    newKeyId: string;
    newPublicKeyPem: string;
    expectedNewFingerprintSha256?: string;
    observerId?: string;
    rotatedAt?: string;
    rotatedBy?: string;
    auditEventId?: string | null;
  }): Promise<{ oldRecord: ObserverKeyRecord; newRecord: ObserverKeyRecord }> {
    const existing = this.#records.get(input.oldKeyId);
    if (!existing) throw new Error(`observer key '${input.oldKeyId}' does not exist`);
    if (existing.status !== "active") {
      throw new Error(`cannot rotate observer key '${input.oldKeyId}' with status '${existing.status}'`);
    }
    if (!ID_RE.test(input.newKeyId)) throw new Error("invalid newKeyId");
    if (this.#records.has(input.newKeyId)) {
      throw new Error(`observer key '${input.newKeyId}' is already registered`);
    }
    const observerId = input.observerId ?? existing.observerId;
    if (!ID_RE.test(observerId)) throw new Error("invalid observerId");
    await validatePublicKeyCustody(input.newPublicKeyPem);
    const newFingerprint = await computeSpkiFingerprintSha256(input.newPublicKeyPem);
    if (input.expectedNewFingerprintSha256 !== undefined) {
      if (!SHA256_HEX_RE.test(input.expectedNewFingerprintSha256) || input.expectedNewFingerprintSha256 !== newFingerprint) {
        throw new Error(`newPublicKeyPem SPKI fingerprint mismatch for key '${input.newKeyId}'`);
      }
    }
    if (existing.publicKeyPem === input.newPublicKeyPem || existing.publicKeyFingerprintSha256 === newFingerprint) {
      throw new Error("newPublicKeyPem must differ from the old key material on rotation");
    }

    const now = input.rotatedAt ?? new Date().toISOString();
    const actor = input.rotatedBy ?? "system";
    const oldRecord: ObserverKeyRecord = Object.freeze({
      ...existing,
      status: "rotated",
      rotatedAt: now,
      rotatedToKeyId: input.newKeyId
    });
    const newRecord: ObserverKeyRecord = Object.freeze({
      keyId: input.newKeyId,
      observerId,
      publicKeyPem: input.newPublicKeyPem,
      publicKeyFingerprintSha256: newFingerprint,
      status: "active",
      registeredAt: now,
      registeredBy: actor,
      rotatedAt: null,
      rotatedToKeyId: null,
      retiredAt: null,
      retiredBy: null,
      revokedAt: null,
      revokedBy: null,
      revocationReason: null,
      auditEventId: input.auditEventId ?? null
    });
    this.#records.set(oldRecord.keyId, oldRecord);
    this.#records.set(newRecord.keyId, newRecord);
    return { oldRecord, newRecord };
  }

  retireKey(input: {
    keyId: string;
    retiredAt?: string;
    retiredBy?: string;
  }): ObserverKeyRecord {
    const existing = this.#records.get(input.keyId);
    if (!existing) throw new Error(`observer key '${input.keyId}' does not exist`);
    if (existing.status === "revoked") {
      throw new Error(`cannot retire revoked observer key '${input.keyId}'`);
    }
    if (existing.status === "retired") return existing;
    const now = input.retiredAt ?? new Date().toISOString();
    const updated: ObserverKeyRecord = Object.freeze({
      ...existing,
      status: "retired",
      retiredAt: now,
      retiredBy: input.retiredBy ?? "system"
    });
    this.#records.set(updated.keyId, updated);
    return updated;
  }

  revokeKey(input: {
    keyId: string;
    reason: string;
    revokedAt?: string;
    revokedBy?: string;
  }): ObserverKeyRecord {
    const existing = this.#records.get(input.keyId);
    if (!existing) throw new Error(`observer key '${input.keyId}' does not exist`);
    if (existing.status === "revoked") return existing;
    if (typeof input.reason !== "string" || input.reason.trim().length === 0) {
      throw new Error("revocation reason is required");
    }
    const updated: ObserverKeyRecord = Object.freeze({
      ...existing,
      status: "revoked",
      revokedAt: input.revokedAt ?? new Date().toISOString(),
      revokedBy: input.revokedBy ?? "system",
      revocationReason: input.reason.trim()
    });
    this.#records.set(updated.keyId, updated);
    return updated;
  }

  evaluateKey(
    keyId: string,
    options: { allowRotatedHistorical?: boolean; receiptTimestampIso?: string } = {}
  ): KeyEvaluationResult {
    const rec = this.#records.get(keyId);
    if (!rec) {
      return { allowed: false, status: "unknown", reason: `untrusted or unknown signingKeyId '${keyId}'` };
    }
    if (rec.status === "revoked") {
      return {
        allowed: false,
        status: "revoked",
        reason: `signingKeyId '${keyId}' has been revoked (${rec.revocationReason ?? "revoked"})`,
        record: rec
      };
    }
    if (rec.status === "retired") {
      return {
        allowed: false,
        status: "retired",
        reason: `signingKeyId '${keyId}' has been retired and is no longer valid for receipt verification`,
        record: rec
      };
    }
    if (rec.status === "rotated") {
      if (options.allowRotatedHistorical && rec.rotatedAt && options.receiptTimestampIso) {
        const receiptMs = Date.parse(options.receiptTimestampIso);
        const rotatedMs = Date.parse(rec.rotatedAt);
        const registeredMs = Date.parse(rec.registeredAt);
        const afterRegistration = Number.isNaN(registeredMs) || receiptMs >= registeredMs;
        if (!Number.isNaN(receiptMs) && !Number.isNaN(rotatedMs) && afterRegistration && receiptMs < rotatedMs) {
          return { allowed: true, status: "rotated", record: rec };
        }
      }
      return {
        allowed: false,
        status: "rotated",
        reason: `signingKeyId '${keyId}' has been rotated out`,
        record: rec
      };
    }
    return { allowed: true, status: "active", record: rec };
  }
}

export { sha256Hex };
