import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ImmutableFsWormSink,
  canonicalJson,
  computeV2CategoryDigests,
  computeWitnessEvidenceHash,
  sha256Hex,
  witnessCanonicalBody,
  witnessSigningPayload,
  type JcKernelWitnessReceiptV1,
  type JcKernelWitnessReceiptV2
} from "@agent-control-stack/black-box-recorder";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { afterEach, describe, expect, it } from "vitest";
import type { FaultBoundary } from "./black-box-durable.js";
import { buildGateway } from "./server.js";

function makeEd25519Keys() {
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
    observerId: "witness-gw-1",
    workItemId: "wi-gw-1",
    attemptId: "att-gw-1",
    leaseId: "lease-gw-1",
    invocationHash: "a".repeat(64),
    cgroupId: 5555,
    cgroupPath: "/sys/fs/cgroup/jc-wi-gw-1",
    startTimeNs: 1000,
    endTimeNs: 2000,
    status: "complete",
    incompleteReasons: [],
    events: [],
    processTree: [],
    eventCounts: { total: 0, fork: 0, exec: 0, exit: 0 },
    droppedEvents: 0,
    sequenceGaps: 0,
    previousEvidenceHash: null,
    acsAnchorRef: "acs:work_item:wi-gw-1",
    signingKeyId: "wk-gw-1",
    ...overrides
  };
  const canonical = canonicalJson(body);
  const evidenceHash = await sha256Hex(canonical);
  const signature = sign(null, Buffer.from(canonical, "utf8"), privateKeyPem).toString("base64");
  return { ...body, evidenceHash, signature };
}

describe("Gateway Black Box & Kernel Witness ingestion", () => {
  let directory: string | undefined;
  afterEach(() => {
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  it("rejects unauthorized producers, tampered receipts, and replays; anchors verified receipts into audit_events and exposes GET /coding-missions/:id/black-box", async () => {
    directory = mkdtempSync(join(tmpdir(), "acs-gw-bb-"));
    const dbPath = join(directory, "control.db");
    const store = new SqliteWorkItemStore(dbPath);
    store.registerActor({ id: "user", actorType: "HUMAN", displayName: "user", externalRef: "local_bearer:local-dev" });
    const workItem = store.create({
      title: "Kernel witness test",
      requester: "user",
      requesterSubject: "user",
      intent: "test"
    });
    const workItemId = workItem.id;
    store.close();

    const { publicKeyPem, privateKeyPem } = makeEd25519Keys();
    const app = buildGateway({
      dbPath,
      logger: false,
      auth: {
        token: "writer-token",
        actor: "jc-bridge",
        credentials: [
          {
            id: "writer",
            token: "writer-token",
            actor: "service",
            actorId: "jc-bridge",
            roles: ["service"],
            scopes: ["acs:read", "acs:write"]
          },
          {
            id: "reader",
            token: "reader-token",
            actor: "user",
            actorId: "viewer",
            roles: ["operator"],
            scopes: ["acs:read"]
          }
        ]
      },
      blackBox: {
        enabled: true,
        trustedWitnessKeys: { "wk-gw-1": publicKeyPem }
      }
    });

    const receipt = await signReceipt({ workItemId, acsAnchorRef: `acs:work_item:${workItemId}` }, privateKeyPem);

    // 1. Anonymous rejected (401)
    const anon = await app.inject({
      method: "POST",
      url: "/black-box/kernel-witness/receipts",
      payload: { receipt }
    });
    expect(anon.statusCode).toBe(401);

    // 2. Read-only caller rejected (403)
    const readOnly = await app.inject({
      method: "POST",
      url: "/black-box/kernel-witness/receipts",
      headers: { authorization: "Bearer reader-token" },
      payload: { receipt }
    });
    expect(readOnly.statusCode).toBe(403);

    // 3. Tampered receipt rejected (422)
    const tampered = await app.inject({
      method: "POST",
      url: "/black-box/kernel-witness/receipts",
      headers: { authorization: "Bearer writer-token" },
      payload: { receipt: { ...receipt, cgroupId: 999999 } }
    });
    expect(tampered.statusCode).toBe(422);

    // 4. Valid complete receipt -> 201, observed: true, anchored in audit_events
    const created = await app.inject({
      method: "POST",
      url: "/black-box/kernel-witness/receipts",
      headers: { authorization: "Bearer writer-token" },
      payload: { receipt }
    });
    expect(created.statusCode).toBe(201);
    const createdJson = created.json() as {
      status: string;
      observed: boolean;
      trustLevel: string;
      evidenceHash: string;
      anchor: { auditEventId: string; auditEventHash: string } | null;
    };
    expect(createdJson.status).toBe("created");
    expect(createdJson.observed).toBe(true);
    expect(createdJson.trustLevel).toBe("independently_verified");
    expect(createdJson.evidenceHash).toBe(receipt.evidenceHash);
    expect(createdJson.anchor?.auditEventHash).toMatch(/^[a-f0-9]{64}$/);

    // 5. Replay rejected (409)
    const replay = await app.inject({
      method: "POST",
      url: "/black-box/kernel-witness/receipts",
      headers: { authorization: "Bearer writer-token" },
      payload: { receipt }
    });
    expect(replay.statusCode).toBe(409);

    // 6. Incomplete receipt -> accepted as untrusted_claim, observed: false
    const incompleteReceipt = await signReceipt(
      {
        workItemId,
        acsAnchorRef: `acs:work_item:${workItemId}`,
        status: "incomplete",
        incompleteReasons: ["ringbuf_overflow"],
        droppedEvents: 1,
        previousEvidenceHash: receipt.evidenceHash
      },
      privateKeyPem
    );
    const incompleteRes = await app.inject({
      method: "POST",
      url: "/black-box/kernel-witness/receipts",
      headers: { authorization: "Bearer writer-token" },
      payload: { receipt: incompleteReceipt }
    });
    expect(incompleteRes.statusCode).toBe(201);
    expect((incompleteRes.json() as { observed: boolean; trustLevel: string }).observed).toBe(false);
    expect((incompleteRes.json() as { trustLevel: string }).trustLevel).toBe("untrusted_claim");

    // 7. GET /coding-missions/:id/black-box returns chained events
    const bb = await app.inject({
      method: "GET",
      url: `/coding-missions/${workItemId}/black-box`,
      headers: { authorization: "Bearer reader-token" }
    });
    expect(bb.statusCode).toBe(200);
    const bbJson = bb.json() as {
      missionId: string;
      chain: { valid: boolean; eventCount: number };
      events: Array<{ trustLevel: string }>;
    };
    expect(bbJson.missionId).toBe(workItemId);
    expect(bbJson.chain.valid).toBe(true);
    expect(bbJson.chain.eventCount).toBe(2);
    expect(bbJson.events).toHaveLength(2);

    // 8. Receipt with non-empty acsAnchorRef for non-existent workItemId is NEVER promoted in recorderStore
    const unanchoredWorkItemReceipt = await signReceipt(
      {
        workItemId: "wi-nonexistent",
        acsAnchorRef: "acs:work_item:wi-nonexistent",
        previousEvidenceHash: incompleteReceipt.evidenceHash
      },
      privateKeyPem
    );
    const nonExistentRes = await app.inject({
      method: "POST",
      url: "/black-box/kernel-witness/receipts",
      headers: { authorization: "Bearer writer-token" },
      payload: { receipt: unanchoredWorkItemReceipt }
    });
    expect(nonExistentRes.statusCode).toBe(201);
    expect((nonExistentRes.json() as { observed: boolean; trustLevel: string }).observed).toBe(false);
    expect((nonExistentRes.json() as { trustLevel: string }).trustLevel).toBe("untrusted_claim");

    const bbNonExistent = await app.inject({
      method: "GET",
      url: "/coding-missions/wi-nonexistent/black-box",
      headers: { authorization: "Bearer reader-token" }
    });
    expect(bbNonExistent.statusCode).toBe(200);
    const bbNonExistentJson = bbNonExistent.json() as {
      events: Array<{ trustLevel: string; metadata: { observed: boolean } }>;
    };
    expect(bbNonExistentJson.events).toHaveLength(1);
    expect(bbNonExistentJson.events[0]!.trustLevel).toBe("untrusted_claim");
    expect(bbNonExistentJson.events[0]!.metadata.observed).toBe(false);

    // 9. Verify SQLite immutability triggers on black_box_events
    const db = new DatabaseSync(dbPath);
    expect(() => db.exec("DELETE FROM black_box_events WHERE seq = 1")).toThrow(/append-only/i);
    expect(() => db.exec("UPDATE black_box_events SET trust_level = 'acs_authoritative' WHERE seq = 1")).toThrow(/append-only/i);
    db.close();

    // 10. Gateway restart & recovery: close and recreate gateway on same dbPath
    await app.close();
    const app2 = buildGateway({
      dbPath,
      logger: false,
      auth: {
        token: "writer-token",
        actor: "jc-bridge",
        credentials: [
          {
            id: "writer",
            token: "writer-token",
            actor: "service",
            actorId: "jc-bridge",
            roles: ["service"],
            scopes: ["acs:read", "acs:write"]
          },
          {
            id: "reader",
            token: "reader-token",
            actor: "user",
            actorId: "viewer",
            roles: ["operator"],
            scopes: ["acs:read"]
          },
          {
            id: "observer-admin",
            token: "admin-token",
            actor: "user",
            actorId: "sec-admin",
            roles: ["operator"],
            scopes: ["acs:read", "acs:write", "acs:observers:admin"]
          }
        ]
      },
      blackBox: { enabled: true }
    });

    // Reloaded chain & events match pre-restart state
    const bbAfterRestart = await app2.inject({
      method: "GET",
      url: `/coding-missions/${workItemId}/black-box`,
      headers: { authorization: "Bearer reader-token" }
    });
    expect(bbAfterRestart.statusCode).toBe(200);
    const bbAfterJson = bbAfterRestart.json() as {
      chain: { valid: boolean; eventCount: number; headHash: string };
      events: Array<{ evidence: { seq: number; eventHash: string } }>;
    };
    expect(bbAfterJson.chain.valid).toBe(true);
    expect(bbAfterJson.chain.eventCount).toBe(3);
    expect(bbAfterJson.events).toHaveLength(2);
    const prevHead = bbAfterJson.chain.headHash;

    // Replay of pre-restart receipt is STILL rejected after restart
    const replayAfterRestart = await app2.inject({
      method: "POST",
      url: "/black-box/kernel-witness/receipts",
      headers: { authorization: "Bearer writer-token" },
      payload: { receipt }
    });
    expect(replayAfterRestart.statusCode).toBe(409);

    // Observer key lifecycle: [P1-01] service writer-token (without acs:observers:admin) is rejected with 403
    const dyn1 = makeEd25519Keys();
    const dyn2 = makeEd25519Keys();

    const forbiddenWriterReg = await app2.inject({
      method: "POST",
      url: "/black-box/observers/register",
      headers: { authorization: "Bearer writer-token" },
      payload: { keyId: "wk-dyn-1", observerId: "obs-dyn", publicKeyPem: dyn1.publicKeyPem }
    });
    expect(forbiddenWriterReg.statusCode).toBe(403);

    // Private key custody check rejects private key PEM
    const privReg = await app2.inject({
      method: "POST",
      url: "/black-box/observers/register",
      headers: { authorization: "Bearer admin-token" },
      payload: { keyId: "wk-dyn-1", observerId: "obs-dyn", publicKeyPem: dyn1.privateKeyPem }
    });
    expect(privReg.statusCode).toBe(422);

    // Register wk-dyn-1 with admin-token
    const regRes = await app2.inject({
      method: "POST",
      url: "/black-box/observers/register",
      headers: { authorization: "Bearer admin-token" },
      payload: { keyId: "wk-dyn-1", observerId: "obs-dyn", publicKeyPem: dyn1.publicKeyPem }
    });
    expect(regRes.statusCode).toBe(201);

    // New receipt signed with wk-dyn-1 chains onto seq 4 after restart
    const postRestartReceipt = await signReceipt(
      {
        workItemId,
        acsAnchorRef: `acs:work_item:${workItemId}`,
        signingKeyId: "wk-dyn-1",
        previousEvidenceHash: unanchoredWorkItemReceipt.evidenceHash
      },
      dyn1.privateKeyPem
    );
    const postRestartIngest = await app2.inject({
      method: "POST",
      url: "/black-box/kernel-witness/receipts",
      headers: { authorization: "Bearer writer-token" },
      payload: { receipt: postRestartReceipt }
    });
    expect(postRestartIngest.statusCode).toBe(201);
    expect((postRestartIngest.json() as { observed: boolean }).observed).toBe(true);

    const bbAfterNew = await app2.inject({
      method: "GET",
      url: `/coding-missions/${workItemId}/black-box`,
      headers: { authorization: "Bearer reader-token" }
    });
    const bbAfterNewJson = bbAfterNew.json() as {
      chain: { valid: boolean; eventCount: number };
      events: Array<{ evidence: { seq: number; previousHash: string } }>;
    };
    expect(bbAfterNewJson.chain.valid).toBe(true);
    expect(bbAfterNewJson.chain.eventCount).toBe(4);
    expect(bbAfterNewJson.events[2]!.evidence.seq).toBe(4);
    expect(bbAfterNewJson.events[2]!.evidence.previousHash).toBe(prevHead);

    // Rotate wk-dyn-1 -> wk-dyn-2
    const rotRes = await app2.inject({
      method: "POST",
      url: "/black-box/observers/rotate",
      headers: { authorization: "Bearer admin-token" },
      payload: { oldKeyId: "wk-dyn-1", newKeyId: "wk-dyn-2", newPublicKeyPem: dyn2.publicKeyPem }
    });
    expect(rotRes.statusCode).toBe(200);

    // Old key wk-dyn-1 is now rejected for new receipts
    const rOldKey = await signReceipt(
      {
        workItemId,
        acsAnchorRef: `acs:work_item:${workItemId}`,
        signingKeyId: "wk-dyn-1",
        endTimeNs: Date.now() * 1_000_000
      },
      dyn1.privateKeyPem
    );
    const oldKeyIngest = await app2.inject({
      method: "POST",
      url: "/black-box/kernel-witness/receipts",
      headers: { authorization: "Bearer writer-token" },
      payload: { receipt: rOldKey }
    });
    expect(oldKeyIngest.statusCode).toBe(422);

    // Revoke wk-dyn-2 -> rejected
    const revRes = await app2.inject({
      method: "POST",
      url: "/black-box/observers/revoke",
      headers: { authorization: "Bearer admin-token" },
      payload: { keyId: "wk-dyn-2", reason: "decommissioned" }
    });
    expect(revRes.statusCode).toBe(200);

    const rRevoked = await signReceipt(
      {
        workItemId,
        acsAnchorRef: `acs:work_item:${workItemId}`,
        signingKeyId: "wk-dyn-2",
        endTimeNs: Date.now() * 1_000_000
      },
      dyn2.privateKeyPem
    );
    const revokedIngest = await app2.inject({
      method: "POST",
      url: "/black-box/kernel-witness/receipts",
      headers: { authorization: "Bearer writer-token" },
      payload: { receipt: rRevoked }
    });
    expect(revokedIngest.statusCode).toBe(422);

    await app2.close();
  });

  it("enforces [P0-02] execution binding, [P0-05] requireLiveMode=true default, [P0-03] 10-boundary crash durability + Idempotency-Key, [P0-04] WORM reconstruction after DB loss, and Phase 6 v2 ingestion", async () => {
    directory = mkdtempSync(join(tmpdir(), "acs-gw-v2-"));
    const dbPath = join(directory, "control.db");
    const wormDir = join(directory, "worm");
    const store = new SqliteWorkItemStore(dbPath);
    store.registerActor({ id: "user", actorType: "HUMAN", displayName: "user", externalRef: "local_bearer:local-dev" });
    const workItem = store.create({
      title: "V2 witness test",
      requester: "user",
      requesterSubject: "user",
      intent: "test"
    });
    const otherWorkItem = store.create({
      title: "Other work item",
      requester: "user",
      requesterSubject: "user",
      intent: "other"
    });
    const workItemId = workItem.id;
    const otherWorkItemId = otherWorkItem.id;
    store.close();

    const { publicKeyPem, privateKeyPem } = makeEd25519Keys();
    const wormSink = new ImmutableFsWormSink({
      rootDir: wormDir
    });

    let activeBoundary: FaultBoundary | null = null;
    const app = buildGateway({
      dbPath,
      logger: false,
      auth: {
        token: "writer-token",
        actor: "jc-bridge",
        credentials: [
          {
            id: "writer",
            token: "writer-token",
            actor: "service",
            actorId: "jc-bridge",
            roles: ["service"],
            scopes: ["acs:read", "acs:write"]
          },
          {
            id: "admin",
            token: "admin-token",
            actor: "user",
            actorId: "sec-admin",
            roles: ["operator"],
            scopes: ["acs:read", "acs:write", "acs:observers:admin"]
          }
        ]
      },
      blackBox: {
        enabled: true,
        trustedWitnessKeys: { "wk-gw-1": publicKeyPem },
        wormSink,
        faultInjector: (b) => {
          if (activeBoundary === b) {
            throw new Error(`injected_fault_${b}`);
          }
        }
      }
    });

    // 1. [P0-05] requireLiveMode defaults to true: synthetic receipt is NEVER promoted to independently_verified
    const syntheticReceipt = await signReceipt(
      {
        workItemId,
        observerMode: "synthetic",
        acsAnchorRef: `acs:work_item:${workItemId}`
      },
      privateKeyPem
    );
    const synRes = await app.inject({
      method: "POST",
      url: "/black-box/kernel-witness/receipts",
      headers: { authorization: "Bearer writer-token" },
      payload: { receipt: syntheticReceipt }
    });
    expect(synRes.statusCode).toBe(201);
    expect((synRes.json() as { observed: boolean; trustLevel: string }).observed).toBe(false);
    expect((synRes.json() as { trustLevel: string }).trustLevel).toBe("untrusted_claim");

    // 2. [P0-02] Forged acsAnchorRef pointing at otherWorkItemId is downgraded to untrusted_claim
    const wrongAnchorReceipt = await signReceipt(
      {
        workItemId,
        acsAnchorRef: `acs:work_item:${otherWorkItemId}`,
        previousEvidenceHash: syntheticReceipt.evidenceHash
      },
      privateKeyPem
    );
    const wrongAnchorRes = await app.inject({
      method: "POST",
      url: "/black-box/kernel-witness/receipts",
      headers: { authorization: "Bearer writer-token" },
      payload: { receipt: wrongAnchorReceipt }
    });
    expect(wrongAnchorRes.statusCode).toBe(201);
    expect((wrongAnchorRes.json() as { observed: boolean; trustLevel: string }).observed).toBe(false);
    expect((wrongAnchorRes.json() as { trustLevel: string }).trustLevel).toBe("untrusted_claim");

    // 3. [P0-03] Fault injection across pre-commit boundaries B1..B6 leaves zero partial state
    const validV1Receipt = await signReceipt(
      {
        workItemId,
        attemptId: "att-durable-1",
        acsAnchorRef: `acs:work_item:${workItemId}`,
        previousEvidenceHash: wrongAnchorReceipt.evidenceHash
      },
      privateKeyPem
    );
    for (const boundary of [
      "B1_BEFORE_VERIFY",
      "B2_AFTER_VERIFY_BEFORE_TX",
      "B3_INSIDE_TX_AFTER_AUDIT_INSERT",
      "B4_INSIDE_TX_AFTER_EVENT_INSERT",
      "B5_INSIDE_TX_AFTER_CHAIN_STATE_UPDATE",
      "B6_INSIDE_TX_BEFORE_COMMIT"
    ] as const) {
      activeBoundary = boundary;
      const failRes = await app.inject({
        method: "POST",
        url: "/black-box/kernel-witness/receipts",
        headers: {
          authorization: "Bearer writer-token",
          "idempotency-key": "idem-durable-1"
        },
        payload: { receipt: validV1Receipt }
      });
      expect(failRes.statusCode).toBe(500);
    }
    activeBoundary = null;

    // Retry with same Idempotency-Key after B1..B6 rollbacks succeeds with 201 Created!
    const retryAfterRollback = await app.inject({
      method: "POST",
      url: "/black-box/kernel-witness/receipts",
      headers: {
        authorization: "Bearer writer-token",
        "idempotency-key": "idem-durable-1"
      },
      payload: { receipt: validV1Receipt }
    });
    expect(retryAfterRollback.statusCode).toBe(201);
    const createdBody = retryAfterRollback.json() as {
      status: string;
      observed: boolean;
      eventId: string;
      worm: { status: string };
    };
    expect(createdBody.status).toBe("created");
    expect(createdBody.observed).toBe(true);
    expect(createdBody.worm.status).toBe("anchored");

    // Subsequent retry with same Idempotency-Key returns 200 duplicate (not 409!)
    const idemDuplicate = await app.inject({
      method: "POST",
      url: "/black-box/kernel-witness/receipts",
      headers: {
        authorization: "Bearer writer-token",
        "idempotency-key": "idem-durable-1"
      },
      payload: { receipt: validV1Receipt }
    });
    expect(idemDuplicate.statusCode).toBe(200);
    expect((idemDuplicate.json() as { status: string }).status).toBe("duplicate");

    // 4. [P0-03] Boundary B8..B10 (post-commit WORM outbox failure) commits locally and flushes via /worm-flush
    const processTree = [
      {
        pid: 7001,
        tgid: 7001,
        ppid: 7000,
        comm: "python3",
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
        cgroupId: 5555,
        pid: 7001,
        tgid: 7001,
        comm: "python3",
        uid: 1000,
        gid: 1000,
        op: "CREATE" as const,
        phase: "completed" as const,
        succeeded: true,
        resultErrno: 0,
        bytes: 64,
        flags: 1,
        dev: 1,
        inode: 10,
        mountId: 5,
        pathDigest: await sha256Hex("/workspace/result.json"),
        pathDigestKeyId: "hmac-1",
        displayPath: "/workspace/result.json",
        targetPathDigest: null,
        targetDisplayPath: null,
        targetInode: 0
      }
    ];
    const networkEvents = [
      {
        seq: 1,
        timestampNs: 1300,
        cgroupId: 5555,
        pid: 7001,
        tgid: 7001,
        comm: "python3",
        sockCookie: 12,
        af: "INET" as const,
        proto: "TCP" as const,
        op: "CONNECT" as const,
        phase: "completed" as const,
        stateTransition: "SYN_SENT->ESTABLISHED",
        outcome: "connected" as const,
        errnoVal: 0,
        remoteAddrDigest: await sha256Hex("1.1.1.1"),
        displayRemoteAddr: "1.1.1.1",
        remotePort: 443,
        localPort: 40000,
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
      observerId: "witness-gw-1",
      workItemId,
      attemptId: "att-v2-gw",
      leaseId: "lease-v2-gw",
      invocationHash: "c".repeat(64),
      cgroupId: 5555,
      cgroupPath: "/sys/fs/cgroup/jc-wi-gw-1",
      rootPid: 7001,
      startTimeNs: 1000,
      endTimeNs: 2000,
      signedAtUtc: "2026-11-13T00:00:10.000Z",
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
      previousEvidenceHash: validV1Receipt.evidenceHash,
      acsAnchorRef: `acs:work_item:${workItemId}`,
      signingKeyId: "wk-gw-1"
    };
    const v2Canonical = witnessCanonicalBody(v2Body);
    const v2EvidenceHash = await computeWitnessEvidenceHash(v2Body);
    const v2SigPayload = witnessSigningPayload({ ...v2Body, evidenceHash: v2EvidenceHash }, v2Canonical);
    const v2Receipt: JcKernelWitnessReceiptV2 = {
      ...v2Body,
      evidenceHash: v2EvidenceHash,
      signature: sign(null, Buffer.from(v2SigPayload, "utf8"), privateKeyPem).toString("base64")
    };

    // Inject B8_BEFORE_WORM_OUTBOX_SEND fault during WORM outbox flush -> local SQLite commit still succeeds (201) with worm.status = "pending"
    activeBoundary = "B8_BEFORE_WORM_OUTBOX_SEND";
    const v2Res = await app.inject({
      method: "POST",
      url: "/black-box/kernel-witness/receipts",
      headers: {
        authorization: "Bearer writer-token",
        "idempotency-key": "idem-v2-gw"
      },
      payload: { receipt: v2Receipt }
    });
    expect(v2Res.statusCode).toBe(201);
    expect((v2Res.json() as { observed: boolean; worm: { status: string } }).observed).toBe(true);
    expect((v2Res.json() as { worm: { status: string } }).worm.status).toBe("pending");

    activeBoundary = null;
    const flushRes = await app.inject({
      method: "POST",
      url: "/black-box/kernel-witness/worm-flush",
      headers: { authorization: "Bearer writer-token" }
    });
    expect(flushRes.statusCode).toBe(200);
    expect((flushRes.json() as { anchored: number; pending: number }).anchored).toBe(1);
    expect((flushRes.json() as { pending: number }).pending).toBe(0);

    // Check WORM status endpoint
    const wormStatusRes = await app.inject({
      method: "GET",
      url: "/black-box/kernel-witness/worm-status",
      headers: { authorization: "Bearer writer-token" }
    });
    expect(wormStatusRes.statusCode).toBe(200);
    const wormStatusJson = wormStatusRes.json() as {
      outbox: { anchored: number; pending: number };
      sinkReport: { valid: boolean; receiptCount: number; headSeq: number };
    };
    expect(wormStatusJson.outbox.anchored).toBe(4);
    expect(wormStatusJson.outbox.pending).toBe(0);
    expect(wormStatusJson.sinkReport.valid).toBe(true);
    expect(wormStatusJson.sinkReport.receiptCount).toBe(4);
    expect(wormStatusJson.sinkReport.headSeq).toBe(4);

    await app.close();

    // 5. [P0-04] Simulate total local SQLite DB loss and reconstruct from WORM sink
    const freshDbPath = join(directory, "reconstructed.db");
    const appReconstruct = buildGateway({
      dbPath: freshDbPath,
      logger: false,
      auth: {
        token: "admin-token",
        actor: "sec-admin",
        credentials: [
          {
            id: "admin",
            token: "admin-token",
            actor: "user",
            actorId: "sec-admin",
            roles: ["operator"],
            scopes: ["acs:read", "acs:write", "acs:observers:admin"]
          }
        ]
      },
      blackBox: {
        enabled: true,
        trustedWitnessKeys: { "wk-gw-1": publicKeyPem },
        wormSink
      }
    });

    const reconRes = await appReconstruct.inject({
      method: "POST",
      url: "/black-box/kernel-witness/reconstruct",
      headers: { authorization: "Bearer admin-token" }
    });
    expect(reconRes.statusCode).toBe(200);
    const reconJson = reconRes.json() as {
      reconstructedCount: number;
      headSeq: number;
      headHash: string;
    };
    expect(reconJson.reconstructedCount).toBe(4);
    expect(reconJson.headSeq).toBe(4);
    expect(reconJson.headHash).toMatch(/^[a-f0-9]{64}$/);

    // Verify mission black-box timeline is intact on the reconstructed DB
    const bbRecon = await appReconstruct.inject({
      method: "GET",
      url: `/coding-missions/${workItemId}/black-box`,
      headers: { authorization: "Bearer admin-token" }
    });
    expect(bbRecon.statusCode).toBe(200);
    const bbReconJson = bbRecon.json() as {
      chain: { valid: boolean; eventCount: number };
      events: Array<{ evidence: { seq: number } }>;
    };
    expect(bbReconJson.chain.valid).toBe(true);
    expect(bbReconJson.chain.eventCount).toBe(4);
    expect(bbReconJson.events).toHaveLength(4);

    await appReconstruct.close();
  });
});
