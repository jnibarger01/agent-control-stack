import type { IngestDraft } from "./types.js";

/**
 * The fields an ACS signature covers. Everything that decides what a record claims is here, so changing any of it
 * (metadata, run, trust level, producer event id, timestamps) invalidates the signature. WebCrypto only: this module is
 * bundled into the browser UI as well as the server.
 */
export function signedPayload(draft: IngestDraft): Record<string, unknown> {
  return {
    component: draft.component,
    instanceId: draft.instanceId ?? null,
    releaseId: draft.releaseId ?? null,
    producerEventId: draft.producerEventId,
    identityRef: draft.identityRef ?? null,
    eventType: draft.eventType,
    runId: draft.runId,
    missionId: draft.missionId,
    correlationId: draft.correlationId,
    parentEventId: draft.parentEventId,
    sourceTimestamp: draft.sourceTimestamp,
    ingestedAt: draft.ingestedAt,
    trustLevel: draft.trustLevel,
    sourceRecordRef: draft.sourceRecordRef ?? null,
    metadata: draft.metadata ?? {}
  };
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function pemToDer(pem: string): Uint8Array {
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  return base64ToBytes(body);
}

/** Imports an Ed25519 public key given as a PEM (SPKI) or base64 DER string. Throws if it is not a valid key. */
export async function importTrustedKey(publicKey: string): Promise<CryptoKey> {
  const der = publicKey.includes("BEGIN") ? pemToDer(publicKey) : base64ToBytes(publicKey.trim());
  return crypto.subtle.importKey("spki", der as BufferSource, { name: "Ed25519" }, false, ["verify"]);
}

/**
 * True only when the draft carries a signature, from a key id the recorder trusts, over exactly the canonical signed
 * payload. Any failure, including a malformed signature, returns false and never throws into ingestion.
 */
export async function verifyProvenance(
  draft: IngestDraft,
  canonical: (value: unknown) => string,
  keys: ReadonlyMap<string, CryptoKey>
): Promise<boolean> {
  const claim = draft.provenance;
  if (!claim) return false;
  const key = keys.get(claim.keyId);
  if (!key) return false;
  try {
    const data = new TextEncoder().encode(canonical(signedPayload(draft)));
    return await crypto.subtle.verify(
      "Ed25519",
      key,
      base64ToBytes(claim.signature) as BufferSource,
      data as BufferSource
    );
  } catch {
    return false;
  }
}
