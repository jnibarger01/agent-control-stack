import { generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GENESIS_HASH,
  ImmutableFsWormSink,
  ObserverKeyRegistry,
  RecorderStore,
  S3ObjectLockWormSink,
  WormTamperOrConflictError,
  canonicalJson,
  computeV2CategoryDigests,
  computeWitnessEvidenceHash,
  createS3ObjectLockTestHandler,
  ingestJcWitnessReceipt,
  sha256Hex,
  verifyJcWitnessReceipt,
  verifyRecorderChain,
  witnessCanonicalBody,
  witnessSigningPayload,
  type JcKernelWitnessReceiptV1,
  type JcKernelWitnessReceiptV2,
  type WormReceiptEnvelope
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

  it("verifies jc.kernel-witness.receipt.v2 domain-separated category digests, signature, and scope coverage", async () => {
    const { publicKeyPem, privateKeyPem } = makeEd25519Keys();
    const processTree = [
      {
        pid: 5001,
        tgid: 5001,
        ppid: 5000,
        comm: "node",
        uid: 1000,
        gid: 1000,
        forkedAtNs: 0,
        execedAtNs: 1100,
        exitedAtNs: 1900,
        exitCode: 0,
        children: []
      }
    ];
    const filesystemEvents = [
      {
        seq: 1,
        timestampNs: 1200,
        cgroupId: 12345,
        pid: 5001,
        tgid: 5001,
        comm: "node",
        uid: 1000,
        gid: 1000,
        op: "CREATE" as const,
        phase: "completed" as const,
        succeeded: true,
        resultErrno: 0,
        bytes: 42,
        flags: 0x241,
        dev: 1,
        inode: 101,
        mountId: 22,
        pathDigest: await sha256Hex("/workspace/out.txt"),
        pathDigestKeyId: "hmac-1",
        displayPath: "/workspace/out.txt",
        targetPathDigest: null,
        targetDisplayPath: null,
        targetInode: 0
      }
    ];
    const networkEvents = [
      {
        seq: 1,
        timestampNs: 1300,
        cgroupId: 12345,
        pid: 5001,
        tgid: 5001,
        comm: "node",
        sockCookie: 99,
        af: "INET" as const,
        proto: "TCP" as const,
        op: "CONNECT" as const,
        phase: "completed" as const,
        stateTransition: "SYN_SENT->ESTABLISHED",
        outcome: "connected" as const,
        errnoVal: 0,
        remoteAddrDigest: await sha256Hex("93.184.216.34"),
        displayRemoteAddr: "93.184.216.34",
        remotePort: 443,
        localPort: 54321,
        bytes: 0
      }
    ];

    const digests = await computeV2CategoryDigests({
      processTree,
      filesystemEvents,
      networkEvents
    });

    const v2Body: Omit<JcKernelWitnessReceiptV2, "evidenceHash" | "signature"> = {
      schemaVersion: "jc.kernel-witness.receipt.v2",
      observerVersion: "0.2.0",
      observerMode: "live",
      observerId: "witness-v2-host",
      workItemId: "wi-v2-1",
      attemptId: "att-v2-1",
      leaseId: "lease-v2-1",
      invocationHash: "b".repeat(64),
      cgroupId: 12345,
      cgroupPath: "/sys/fs/cgroup/jc-wi-v2-1",
      rootPid: 5001,
      startTimeNs: 1000,
      endTimeNs: 2000,
      signedAtUtc: "2026-11-13T00:00:05.000Z",
      status: "complete",
      incompleteReasons: [],
      observationScope: {
        policyRequired: ["process", "filesystem", "network"],
        requested: ["process", "filesystem", "network"],
        active: ["process", "filesystem", "network"]
      },
      categoryCompleteness: {
        process: {
          category: "process",
          enabled: true,
          status: "complete",
          eventCount: 1,
          droppedEvents: 0,
          sequenceGaps: 0,
          firstSeq: 1,
          lastSeq: 1,
          categoryDigestSha256: digests.process,
          incompleteReasons: [],
          unsupportedOperations: []
        },
        filesystem: {
          category: "filesystem",
          enabled: true,
          status: "complete",
          eventCount: 1,
          droppedEvents: 0,
          sequenceGaps: 0,
          firstSeq: 1,
          lastSeq: 1,
          categoryDigestSha256: digests.filesystem,
          incompleteReasons: [],
          unsupportedOperations: []
        },
        network: {
          category: "network",
          enabled: true,
          status: "complete",
          eventCount: 1,
          droppedEvents: 0,
          sequenceGaps: 0,
          firstSeq: 1,
          lastSeq: 1,
          categoryDigestSha256: digests.network,
          incompleteReasons: [],
          unsupportedOperations: []
        }
      },
      events: [],
      processTree,
      filesystemEvents,
      networkEvents,
      eventCounts: {
        total: 3,
        fork: 0,
        exec: 1,
        exit: 0,
        filesystem: 1,
        network: 1
      },
      droppedEvents: 0,
      sequenceGaps: 0,
      previousEvidenceHash: null,
      acsAnchorRef: "acs:work_item:wi-v2-1",
      signingKeyId: "witness-key-v2"
    };

    const canonical = witnessCanonicalBody(v2Body);
    const evidenceHash = await computeWitnessEvidenceHash(v2Body);
    const sigPayload = witnessSigningPayload(
      { ...v2Body, evidenceHash },
      canonical
    );
    const signature = sign(
      null,
      Buffer.from(sigPayload, "utf8"),
      privateKeyPem
    ).toString("base64");
    const v2Receipt: JcKernelWitnessReceiptV2 = {
      ...v2Body,
      evidenceHash,
      signature
    };

    const store = new RecorderStore({ enabled: true });
    const ingested = await ingestJcWitnessReceipt(store, v2Receipt, {
      trustedWitnessKeys: { "witness-key-v2": publicKeyPem },
      requiredCategories: ["process", "filesystem", "network"],
      ingestedAt: "2026-11-13T00:00:06.000Z"
    });
    expect(ingested.accepted).toBe(true);
    expect(ingested.observed).toBe(true);
    expect(ingested.trustLevel).toBe("independently_verified");

    // Process-only v1 receipt CANNOT satisfy full-scope requiredCategories
    const v1Receipt = await signWitnessReceipt(baseReceiptBody(), privateKeyPem);
    const v1AgainstFullPolicy = await verifyJcWitnessReceipt(v1Receipt, {
      trustedWitnessKeys: { "witness-key-1": publicKeyPem },
      requiredCategories: ["process", "filesystem", "network"]
    });
    expect(v1AgainstFullPolicy.valid).toBe(true);
    expect(v1AgainstFullPolicy.observed).toBe(false);

    // Tampered filesystem categoryDigestSha256 is rejected
    const badFsDigestReceipt: JcKernelWitnessReceiptV2 = {
      ...v2Receipt,
      categoryCompleteness: {
        ...v2Receipt.categoryCompleteness,
        filesystem: {
          ...v2Receipt.categoryCompleteness.filesystem,
          categoryDigestSha256: "0".repeat(64)
        }
      }
    };
    const badFsCheck = await verifyJcWitnessReceipt(badFsDigestReceipt, {
      trustedWitnessKeys: { "witness-key-v2": publicKeyPem }
    });
    expect(badFsCheck.valid).toBe(false);
  });

  it("enforces write-once WORM semantics in ImmutableFsWormSink and S3ObjectLockWormSink", async () => {
    const { publicKeyPem, privateKeyPem } = makeEd25519Keys();
    const registry = new ObserverKeyRegistry();
    await registry.registerKey({
      keyId: "witness-key-1",
      observerId: "witness-host-1",
      publicKeyPem,
      registeredAt: "1970-01-01T00:00:00.000Z"
    });

    const receipt1 = await signWitnessReceipt(baseReceiptBody(), privateKeyPem);
    const receipt2 = await signWitnessReceipt(
      baseReceiptBody({
        attemptId: "att-2",
        previousEvidenceHash: receipt1.evidenceHash
      }),
      privateKeyPem
    );

    const store = new RecorderStore({ enabled: true });
    const ing1 = await ingestJcWitnessReceipt(store, receipt1, {
      keyRegistry: registry,
      ingestedAt: "2026-11-13T00:00:10.000Z"
    });
    const ing2 = await ingestJcWitnessReceipt(store, receipt2, {
      keyRegistry: registry,
      ingestedAt: "2026-11-13T00:00:11.000Z"
    });
    if (
      ing1.ingestResult?.status !== "created" ||
      ing2.ingestResult?.status !== "created"
    ) {
      throw new Error("expected created");
    }
    const ev1 = ing1.ingestResult.event;
    const ev2 = ing2.ingestResult.event;
    const meta1 = store.persistenceMetadataFor(ev1.eventId)!;
    const meta2 = store.persistenceMetadataFor(ev2.eventId)!;

    const env1: WormReceiptEnvelope = {
      schema: "acs.black-box.worm-envelope.v1",
      seq: 1,
      eventId: ev1.eventId,
      previousHash: ev1.evidence.previousHash,
      eventHash: ev1.evidence.eventHash,
      payloadSha256: ev1.evidence.payloadSha256,
      evidenceHash: receipt1.evidenceHash,
      receiptSchema: receipt1.schemaVersion,
      receipt: receipt1,
      recorderEvent: ev1,
      producerKey: meta1.producerKey,
      fingerprint: meta1.fingerprint,
      observerKeyId: "witness-key-1",
      observerPublicKeyPem: publicKeyPem,
      anchoredAt: "2026-11-13T00:00:10.000Z"
    };
    const env2: WormReceiptEnvelope = {
      schema: "acs.black-box.worm-envelope.v1",
      seq: 2,
      eventId: ev2.eventId,
      previousHash: ev2.evidence.previousHash,
      eventHash: ev2.evidence.eventHash,
      payloadSha256: ev2.evidence.payloadSha256,
      evidenceHash: receipt2.evidenceHash,
      receiptSchema: receipt2.schemaVersion,
      receipt: receipt2,
      recorderEvent: ev2,
      producerKey: meta2.producerKey,
      fingerprint: meta2.fingerprint,
      observerKeyId: "witness-key-1",
      observerPublicKeyPem: publicKeyPem,
      anchoredAt: "2026-11-13T00:00:11.000Z"
    };

    // 1. Test ImmutableFsWormSink
    const wormDir = mkdtempSync(join(tmpdir(), "abbr-worm-fs-"));
    try {
      const fsSink = new ImmutableFsWormSink({ rootDir: wormDir, keyRegistry: registry });

      // Sequence gap (anchoring seq 2 before seq 1) is rejected
      await expect(fsSink.putReceiptEnvelope(env2)).rejects.toThrow(
        WormTamperOrConflictError
      );

      // Anchor seq 1 + head, then seq 2 + head
      const put1 = await fsSink.putReceiptEnvelope(env1);
      expect(put1.status).toBe("anchored");
      await fsSink.putChainHeadAnchor({
        schema: "acs.black-box.worm-head.v1",
        seq: 1,
        headHash: ev1.evidence.eventHash,
        evidenceHash: receipt1.evidenceHash,
        anchoredAt: env1.anchoredAt
      });

      // Idempotent duplicate put of seq 1 returns duplicate
      const put1Dup = await fsSink.putReceiptEnvelope(env1);
      expect(put1Dup.status).toBe("duplicate");

      // Conflicting overwrite of seq 1 is rejected
      await expect(
        fsSink.putReceiptEnvelope({ ...env2, seq: 1, previousHash: GENESIS_HASH })
      ).rejects.toThrow(WormTamperOrConflictError);

      const put2 = await fsSink.putReceiptEnvelope(env2);
      expect(put2.status).toBe("anchored");
      await fsSink.putChainHeadAnchor({
        schema: "acs.black-box.worm-head.v1",
        seq: 2,
        headHash: ev2.evidence.eventHash,
        evidenceHash: receipt2.evidenceHash,
        anchoredAt: env2.anchoredAt
      });

      const report = await fsSink.verifySinkIntegrity(registry);
      expect(report.valid).toBe(true);
      expect(report.receiptCount).toBe(2);
      expect(report.headSeq).toBe(2);

      // Simulate out-of-band file corruption in WORM directory -> verifySinkIntegrity detects it
      const seq1Path = join(wormDir, put1.objectKey);
      chmodSync(seq1Path, 0o644);
      writeFileSync(seq1Path, JSON.stringify({ ...env1, evidenceHash: "0".repeat(64) }), "utf8");
      const tamperedReport = await fsSink.verifySinkIntegrity(registry);
      expect(tamperedReport.valid).toBe(false);
    } finally {
      rmSync(wormDir, { recursive: true, force: true });
    }

    // 2. Test S3ObjectLockWormSink with disposable Object Lock handler
    const s3Mock = createS3ObjectLockTestHandler();
    const s3Sink = new S3ObjectLockWormSink({
      endpointUrl: "https://worm.s3.local",
      bucket: "acs-evidence",
      retentionMode: "COMPLIANCE",
      keyRegistry: registry,
      fetchImpl: s3Mock.fetchImpl
    });

    const s3Put1 = await s3Sink.putReceiptEnvelope(env1);
    expect(s3Put1.status).toBe("anchored");
    await s3Sink.putChainHeadAnchor({
      schema: "acs.black-box.worm-head.v1",
      seq: 1,
      headHash: ev1.evidence.eventHash,
      evidenceHash: receipt1.evidenceHash,
      anchoredAt: env1.anchoredAt
    });

    // Idempotent retry over S3 Object Lock (If-None-Match: * returns 412, verified identical -> duplicate)
    const s3Put1Dup = await s3Sink.putReceiptEnvelope(env1);
    expect(s3Put1Dup.status).toBe("duplicate");

    // DELETE on COMPLIANCE-locked S3 object is rejected with 403
    const delRes = await s3Mock.fetchImpl(
      "https://worm.s3.local/acs-evidence/acs-black-box/receipts/seq-00000001.json",
      { method: "DELETE" }
    );
    expect(delRes.status).toBe(403);

    const s3Report = await s3Sink.verifySinkIntegrity(registry);
    expect(s3Report.valid).toBe(true);
    expect(s3Report.receiptCount).toBe(1);
  });
});
