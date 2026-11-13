import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalJson,
  sha256Hex,
  type JcKernelWitnessReceiptV1
} from "@agent-control-stack/black-box-recorder";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { afterEach, describe, expect, it } from "vitest";
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
  });
});
