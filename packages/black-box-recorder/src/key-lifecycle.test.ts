import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ObserverKeyRegistry,
  RecorderStore,
  canonicalJson,
  computeSpkiFingerprintSha256,
  sha256Hex,
  validatePublicKeyCustody,
  verifyJcWitnessReceipt,
  type JcKernelWitnessReceiptV1
} from "./index.js";

function makeKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  };
}

async function signReceipt(
  overrides: Partial<Omit<JcKernelWitnessReceiptV1, "evidenceHash" | "signature">>,
  privateKeyPem: string
): Promise<JcKernelWitnessReceiptV1> {
  const body: Omit<JcKernelWitnessReceiptV1, "evidenceHash" | "signature"> = {
    schemaVersion: "jc.kernel-witness.receipt.v1",
    observerVersion: "0.1.0",
    observerMode: "live",
    observerId: "obs-1",
    workItemId: "wi-kl-1",
    attemptId: "att-1",
    leaseId: "lease-1",
    invocationHash: "a".repeat(64),
    cgroupId: 111,
    cgroupPath: "/sys/fs/cgroup/jc-kl",
    startTimeNs: 1_000_000_000_000_000,
    endTimeNs: Date.parse("2026-11-13T00:00:00.000Z") * 1_000_000,
    status: "complete",
    incompleteReasons: [],
    events: [],
    processTree: [],
    eventCounts: { total: 0, fork: 0, exec: 0, exit: 0 },
    droppedEvents: 0,
    sequenceGaps: 0,
    previousEvidenceHash: null,
    acsAnchorRef: "acs:work_item:wi-kl-1",
    signingKeyId: "k1",
    ...overrides
  };
  const canonical = canonicalJson(body);
  const evidenceHash = await sha256Hex(canonical);
  const signature = sign(null, Buffer.from(canonical, "utf8"), privateKeyPem).toString("base64");
  return { ...body, evidenceHash, signature };
}

describe("ObserverKeyRegistry & key custody", () => {
  it("rejects private keys and invalid PEMs in custody validation", async () => {
    const k1 = makeKeys();
    await expect(validatePublicKeyCustody(k1.privateKeyPem)).rejects.toThrow(/private key/i);
    await expect(validatePublicKeyCustody("not-a-key")).rejects.toThrow();
    await expect(validatePublicKeyCustody(k1.publicKeyPem)).resolves.toBeTruthy();
  });

  it("enforces registration, rotation, historical check, and revocation", async () => {
    const k1 = makeKeys();
    const k2 = makeKeys();
    const registry = new ObserverKeyRegistry();

    await registry.registerKey({
      keyId: "k1",
      observerId: "obs-1",
      publicKeyPem: k1.publicKeyPem,
      registeredAt: "2026-11-13T00:00:00.000Z",
      registeredBy: "admin"
    });

    const r1 = await signReceipt(
      { signingKeyId: "k1", endTimeNs: Date.parse("2026-11-13T00:05:00.000Z") * 1_000_000 },
      k1.privateKeyPem
    );
    const v1 = await verifyJcWitnessReceipt(r1, { keyRegistry: registry });
    expect(v1.valid).toBe(true);
    expect(v1.observed).toBe(true);

    // Rotate k1 -> k2 at 00:10:00
    await registry.rotateKey({
      oldKeyId: "k1",
      newKeyId: "k2",
      newPublicKeyPem: k2.publicKeyPem,
      rotatedAt: "2026-11-13T00:10:00.000Z",
      rotatedBy: "admin"
    });

    // k1 fails for new receipts by default
    const r1After = await signReceipt(
      { signingKeyId: "k1", endTimeNs: Date.parse("2026-11-13T00:15:00.000Z") * 1_000_000 },
      k1.privateKeyPem
    );
    const v1After = await verifyJcWitnessReceipt(r1After, { keyRegistry: registry });
    expect(v1After.valid).toBe(false);
    expect(v1After.observed).toBe(false);

    // k1 can verify pre-rotation historical receipt ONLY when allowRotatedHistorical is true
    const v1Hist = await verifyJcWitnessReceipt(r1, {
      keyRegistry: registry,
      allowRotatedHistorical: true
    });
    expect(v1Hist.valid).toBe(true);

    // k2 succeeds
    const r2 = await signReceipt(
      { signingKeyId: "k2", endTimeNs: Date.parse("2026-11-13T00:15:00.000Z") * 1_000_000 },
      k2.privateKeyPem
    );
    const v2 = await verifyJcWitnessReceipt(r2, { keyRegistry: registry });
    expect(v2.valid).toBe(true);
    expect(v2.observed).toBe(true);

    // Revoke k2 -> immediately rejected
    registry.revokeKey({ keyId: "k2", reason: "compromised", revokedBy: "admin" });
    const v2Revoked = await verifyJcWitnessReceipt(r2, { keyRegistry: registry });
    expect(v2Revoked.valid).toBe(false);
    expect(v2Revoked.observed).toBe(false);
  });

  it("hydrates RecorderStore from persisted snapshot and detects tampered chains", async () => {
    const store1 = new RecorderStore({ enabled: true });
    const r1 = await store1.ingest({
      producerEventId: "p1",
      component: "acs",
      eventType: "step",
      runId: "run-hyd",
      missionId: "run-hyd",
      correlationId: "c1",
      parentEventId: null,
      sourceTimestamp: "2026-11-13T00:00:00.000Z",
      ingestedAt: "2026-11-13T00:00:00.000Z",
      trustLevel: "untrusted_claim"
    });
    expect(r1.status).toBe("created");
    if (r1.status !== "created") throw new Error("expected created");
    const meta = store1.persistenceMetadataFor(r1.event.eventId)!;

    const store2 = new RecorderStore({ enabled: true });
    await store2.hydrate([
      {
        event: r1.event,
        producerKey: meta.producerKey,
        fingerprint: meta.fingerprint,
        evidenceHash: "b".repeat(64)
      }
    ]);
    expect(store2.chainLength).toBe(1);
    expect(store2.headHash).toBe(r1.event.evidence.eventHash);

    // Next event chains cleanly from seq 2
    const r2 = await store2.ingest({
      producerEventId: "p2",
      component: "acs",
      eventType: "step",
      runId: "run-hyd",
      missionId: "run-hyd",
      correlationId: "c1",
      parentEventId: null,
      sourceTimestamp: "2026-11-13T00:00:01.000Z",
      ingestedAt: "2026-11-13T00:00:01.000Z",
      trustLevel: "untrusted_claim"
    });
    expect(r2.status).toBe("created");
    if (r2.status === "created") {
      expect(r2.event.evidence.seq).toBe(2);
      expect(r2.event.evidence.previousHash).toBe(r1.event.evidence.eventHash);
    }

    // Tampered snapshot fails hydration
    const badStore = new RecorderStore({ enabled: true });
    await expect(
      badStore.hydrate([
        {
          event: { ...r1.event, eventType: "tampered" },
          producerKey: meta.producerKey,
          fingerprint: meta.fingerprint
        }
      ])
    ).rejects.toThrow(/chain verification failed/i);

    // Tail truncation relative to expectedChainState fails closed
    const truncatedStore = new RecorderStore({ enabled: true });
    await expect(
      truncatedStore.hydrate(
        [
          {
            event: r1.event,
            producerKey: meta.producerKey,
            fingerprint: meta.fingerprint
          }
        ],
        { seq: 2, headHash: "f".repeat(64) }
      )
    ).rejects.toThrow(/black_box_chain_state_mismatch/i);
  });

  it("enforces SPKI SHA-256 fingerprint pinning, key retirement, backdated pre-registration rejection, and deterministic store fingerprints", async () => {
    const k1 = makeKeys();
    const k2 = makeKeys();
    const fp1 = await computeSpkiFingerprintSha256(k1.publicKeyPem);
    expect(fp1).toMatch(/^[a-f0-9]{64}$/);

    const registry = new ObserverKeyRegistry();
    // Mismatched expectedFingerprintSha256 is rejected
    await expect(
      registry.registerKey({
        keyId: "k-fp",
        observerId: "obs-1",
        publicKeyPem: k1.publicKeyPem,
        expectedFingerprintSha256: "0".repeat(64)
      })
    ).rejects.toThrow(/fingerprint mismatch/i);

    const rec = await registry.registerKey({
      keyId: "k1",
      observerId: "obs-1",
      publicKeyPem: k1.publicKeyPem,
      expectedFingerprintSha256: fp1,
      registeredAt: "2026-11-13T00:10:00.000Z"
    });
    expect(rec.publicKeyFingerprintSha256).toBe(fp1);

    // Rotate k1 -> k2 at 00:20:00
    await registry.rotateKey({
      oldKeyId: "k1",
      newKeyId: "k2",
      newPublicKeyPem: k2.publicKeyPem,
      rotatedAt: "2026-11-13T00:20:00.000Z"
    });

    // Receipt backdated BEFORE k1 registration (00:05:00 < 00:10:00) is rejected even with allowRotatedHistorical: true
    const backdatedReceipt = await signReceipt(
      {
        signingKeyId: "k1",
        endTimeNs: Date.parse("2026-11-13T00:05:00.000Z") * 1_000_000
      },
      k1.privateKeyPem
    );
    const vBackdated = await verifyJcWitnessReceipt(backdatedReceipt, {
      keyRegistry: registry,
      allowRotatedHistorical: true
    });
    expect(vBackdated.valid).toBe(false);
    expect(vBackdated.reasons.join("; ")).toMatch(/rotated out/i);

    // Retire k1 -> rejected even for historical receipts inside the window
    const retired = registry.retireKey({
      keyId: "k1",
      retiredAt: "2026-11-13T00:30:00.000Z",
      retiredBy: "admin"
    });
    expect(retired.status).toBe("retired");

    const inWindowReceipt = await signReceipt(
      {
        signingKeyId: "k1",
        endTimeNs: Date.parse("2026-11-13T00:15:00.000Z") * 1_000_000
      },
      k1.privateKeyPem
    );
    const vRetired = await verifyJcWitnessReceipt(inWindowReceipt, {
      keyRegistry: registry,
      allowRotatedHistorical: true
    });
    expect(vRetired.valid).toBe(false);
    expect(vRetired.reasons.join("; ")).toMatch(/retired/i);

    // Deterministic fingerprint across two separate RecorderStore instances
    const draft = {
      producerEventId: "det-1",
      component: "acs",
      eventType: "step",
      runId: "run-det",
      missionId: "run-det",
      correlationId: "c1",
      parentEventId: null,
      sourceTimestamp: "2026-11-13T00:00:00.000Z",
      ingestedAt: "2026-11-13T00:00:00.000Z",
      trustLevel: "untrusted_claim" as const
    };
    const sA = new RecorderStore({ enabled: true });
    const sB = new RecorderStore({ enabled: true });
    const rA = await sA.ingest(draft);
    if (rA.status !== "created") throw new Error("expected created");
    const metaA = sA.persistenceMetadataFor(rA.event.eventId)!;
    await sB.hydrate([
      {
        event: rA.event,
        producerKey: metaA.producerKey,
        fingerprint: metaA.fingerprint
      }
    ]);
    // Re-ingesting identical draft into hydrated sB returns duplicate (not conflict!)
    const retryB = await sB.ingest({
      ...draft,
      ingestedAt: "2026-11-13T00:05:00.000Z"
    });
    expect(retryB.status).toBe("duplicate");
  });
});
