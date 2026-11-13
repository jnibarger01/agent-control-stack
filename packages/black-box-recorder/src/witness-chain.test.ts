import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  GENESIS_HASH,
  RecorderStore,
  canonicalJson,
  ingestJcWitnessReceipt,
  sha256Hex,
  verifyJcWitnessReceipt,
  verifyRecorderChain,
  type JcKernelWitnessReceiptV1
} from "./index.js";

function makeEd25519Keys() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  };
}

async function signWitnessReceipt(
  body: Omit<JcKernelWitnessReceiptV1, "evidenceHash" | "signature">,
  privateKeyPem: string
): Promise<JcKernelWitnessReceiptV1> {
  const canonical = canonicalJson(body);
  const evidenceHash = await sha256Hex(canonical);
  const signature = sign(null, Buffer.from(canonical, "utf8"), privateKeyPem).toString("base64");
  return { ...body, evidenceHash, signature };
}

function baseReceiptBody(overrides: Partial<Omit<JcKernelWitnessReceiptV1, "evidenceHash" | "signature">> = {}) {
  return {
    schemaVersion: "jc.kernel-witness.receipt.v1" as const,
    observerVersion: "0.1.0",
    observerMode: "live" as const,
    observerId: "witness-host-1",
    workItemId: "wi-100",
    attemptId: "att-1",
    leaseId: "lease-1",
    invocationHash: "a".repeat(64),
    cgroupId: 12345,
    cgroupPath: "/sys/fs/cgroup/user.slice/jc-wi-100",
    startTimeNs: 1000,
    endTimeNs: 2000,
    status: "complete" as const,
    incompleteReasons: [],
    events: [
      {
        seq: 1,
        timestampNs: 1100,
        cgroupId: 12345,
        eventType: "EXEC" as const,
        pid: 4201,
        tgid: 4201,
        ppid: 4200,
        childPid: 0,
        childTgid: 0,
        uid: 1000,
        gid: 1000,
        exitCode: 0,
        comm: "echo"
      }
    ],
    processTree: [
      {
        pid: 4201,
        tgid: 4201,
        ppid: 4200,
        comm: "echo",
        uid: 1000,
        gid: 1000,
        forkedAtNs: 0,
        execedAtNs: 1100,
        exitedAtNs: 1900,
        exitCode: 0,
        children: []
      }
    ],
    eventCounts: { total: 1, fork: 0, exec: 1, exit: 0 },
    droppedEvents: 0,
    sequenceGaps: 0,
    previousEvidenceHash: null,
    acsAnchorRef: "acs:audit:42",
    signingKeyId: "witness-key-1",
    ...overrides
  };
}

describe("RecorderStore inter-event hash chaining", () => {
  it("chains ingested events with seq, previousHash, and eventHash and verifies intact chains", async () => {
    const store = new RecorderStore({ enabled: true });
    const r1 = await store.ingest({
      producerEventId: "ev-1",
      component: "acs",
      eventType: "work_item.created",
      runId: "run-1",
      missionId: "m-1",
      correlationId: "att-1",
      parentEventId: null,
      sourceTimestamp: "2026-11-13T00:00:00.000Z",
      ingestedAt: "2026-11-13T00:00:01.000Z",
      trustLevel: "untrusted_claim"
    });
    const r2 = await store.ingest({
      producerEventId: "ev-2",
      component: "acs",
      eventType: "work_item.finished",
      runId: "run-1",
      missionId: "m-1",
      correlationId: "att-1",
      parentEventId: null,
      sourceTimestamp: "2026-11-13T00:00:02.000Z",
      ingestedAt: "2026-11-13T00:00:03.000Z",
      trustLevel: "untrusted_claim"
    });
    expect(r1.status).toBe("created");
    expect(r2.status).toBe("created");
    if (r1.status !== "created" || r2.status !== "created") throw new Error("expected created");

    expect(r1.event.evidence.seq).toBe(1);
    expect(r1.event.evidence.previousHash).toBe(GENESIS_HASH);
    expect(r1.event.evidence.eventHash).toMatch(/^[a-f0-9]{64}$/);
    expect(r2.event.evidence.seq).toBe(2);
    expect(r2.event.evidence.previousHash).toBe(r1.event.evidence.eventHash);
    expect(store.headHash).toBe(r2.event.evidence.eventHash);

    const verification = await store.verifyChain();
    expect(verification.valid).toBe(true);
    expect(verification.eventCount).toBe(2);
    expect(verification.findings).toEqual([]);
  });

  it("detects deleted middle events, reordered events, and tampered payloads", async () => {
    const store = new RecorderStore({ enabled: true });
    for (const i of [1, 2, 3]) {
      await store.ingest({
        producerEventId: `ev-${i}`,
        component: "acs",
        eventType: "step",
        runId: "run-chain",
        missionId: "m-1",
        correlationId: "att-1",
        parentEventId: null,
        sourceTimestamp: `2026-11-13T00:00:0${i}.000Z`,
        ingestedAt: `2026-11-13T00:00:0${i}.000Z`,
        trustLevel: "untrusted_claim",
        metadata: { step: i }
      });
    }
    const all = [...store.events.values()];
    expect((await verifyRecorderChain(all)).valid).toBe(true);

    // Delete middle event
    const deleted = [all[0]!, all[2]!];
    const delCheck = await verifyRecorderChain(deleted);
    expect(delCheck.valid).toBe(false);
    expect(delCheck.findings.some((f) => f.kind === "sequence_gap" || f.kind === "previous_hash_mismatch")).toBe(true);

    // Reorder events
    const reordered = [all[0]!, all[2]!, all[1]!];
    const reorderCheck = await verifyRecorderChain(reordered);
    expect(reorderCheck.valid).toBe(false);

    // Tamper payload
    const tampered = [
      all[0]!,
      { ...all[1]!, metadata: { step: 999 } },
      all[2]!
    ];
    const tamperCheck = await verifyRecorderChain(tampered);
    expect(tamperCheck.valid).toBe(false);
    expect(tamperCheck.findings.some((f) => f.kind === "payload_hash_mismatch")).toBe(true);
  });
});

describe("JC Kernel Witness producer adapter & replay protection", () => {
  it("promotes complete, signed, hash-valid, ACS-anchored witness receipt to independently_verified", async () => {
    const { publicKeyPem, privateKeyPem } = makeEd25519Keys();
    const receipt = await signWitnessReceipt(baseReceiptBody(), privateKeyPem);
    const store = new RecorderStore({ enabled: true });
    const seen = new Set<string>();

    const res = await ingestJcWitnessReceipt(store, receipt, {
      trustedWitnessKeys: { "witness-key-1": publicKeyPem },
      seenEvidenceHashes: seen,
      ingestedAt: "2026-11-13T00:00:10.000Z"
    });
    expect(res.accepted).toBe(true);
    expect(res.observed).toBe(true);
    expect(res.trustLevel).toBe("independently_verified");
    expect(res.ingestResult?.status).toBe("created");
    if (res.ingestResult?.status === "created") {
      expect(res.ingestResult.event.trustLevel).toBe("independently_verified");
    }
  });

  it("downgrades incomplete or unanchored witness receipts to untrusted_claim (never observed)", async () => {
    const { publicKeyPem, privateKeyPem } = makeEd25519Keys();
    const incompleteReceipt = await signWitnessReceipt(
      baseReceiptBody({ status: "incomplete", incompleteReasons: ["ringbuf_overflow"], droppedEvents: 3 }),
      privateKeyPem
    );
    const unanchoredReceipt = await signWitnessReceipt(
      baseReceiptBody({ acsAnchorRef: null }),
      privateKeyPem
    );
    const store = new RecorderStore({ enabled: true });

    const rIncomplete = await ingestJcWitnessReceipt(store, incompleteReceipt, {
      trustedWitnessKeys: { "witness-key-1": publicKeyPem },
      ingestedAt: "2026-11-13T00:00:10.000Z"
    });
    expect(rIncomplete.accepted).toBe(true);
    expect(rIncomplete.observed).toBe(false);
    expect(rIncomplete.trustLevel).toBe("untrusted_claim");

    const rUnanchored = await ingestJcWitnessReceipt(store, unanchoredReceipt, {
      trustedWitnessKeys: { "witness-key-1": publicKeyPem },
      ingestedAt: "2026-11-13T00:00:11.000Z"
    });
    expect(rUnanchored.accepted).toBe(true);
    expect(rUnanchored.observed).toBe(false);
    expect(rUnanchored.trustLevel).toBe("untrusted_claim");
  });

  it("rejects tampered, invalid-signature, chain-broken, and replayed witness receipts", async () => {
    const { publicKeyPem, privateKeyPem } = makeEd25519Keys();
    const otherKeys = makeEd25519Keys();
    const receipt = await signWitnessReceipt(baseReceiptBody(), privateKeyPem);
    const store = new RecorderStore({ enabled: true });
    const seen = new Set<string>();

    // Tampered
    const tampered = { ...receipt, cgroupId: 99999 };
    const rTampered = await verifyJcWitnessReceipt(tampered, {
      trustedWitnessKeys: { "witness-key-1": publicKeyPem }
    });
    expect(rTampered.valid).toBe(false);

    // Wrong key
    const rBadSig = await verifyJcWitnessReceipt(receipt, {
      trustedWitnessKeys: { "witness-key-1": otherKeys.publicKeyPem }
    });
    expect(rBadSig.valid).toBe(false);

    // Chain mismatch
    const rBadChain = await verifyJcWitnessReceipt(receipt, {
      trustedWitnessKeys: { "witness-key-1": publicKeyPem },
      expectedPreviousEvidenceHash: "f".repeat(64)
    });
    expect(rBadChain.valid).toBe(false);

    // First ingest succeeds, replay is rejected
    const first = await ingestJcWitnessReceipt(store, receipt, {
      trustedWitnessKeys: { "witness-key-1": publicKeyPem },
      seenEvidenceHashes: seen,
      ingestedAt: "2026-11-13T00:00:10.000Z"
    });
    expect(first.accepted).toBe(true);

    const replay = await ingestJcWitnessReceipt(store, receipt, {
      trustedWitnessKeys: { "witness-key-1": publicKeyPem },
      seenEvidenceHashes: seen,
      ingestedAt: "2026-11-13T00:00:11.000Z"
    });
    expect(replay.accepted).toBe(false);
    expect(replay.reason).toMatch(/replay/i);
  });
});
