import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, test } from "vitest";
import { summarize } from "./analyze.js";
import { toRecorderDraft, type AcsExecutionRow } from "./acs-emitter.js";
import { canonicalJson } from "./canonical.js";
import { signedPayload } from "./provenance.js";
import { recorderEventIdFor, RecorderStore } from "./store.js";
import type { IngestDraft } from "./types.js";

// Test-only key, generated in memory. Never a production or capability-signing credential.
const acs = generateKeyPairSync("ed25519");
const trustedPem = acs.publicKey.export({ format: "pem", type: "spki" }).toString();
const acsPrivate = acs.privateKey;

const sig = (d: IngestDraft): IngestDraft => {
  const signature = sign(null, Buffer.from(canonicalJson(signedPayload(d)), "utf8"), acsPrivate).toString("base64");
  return { ...d, provenance: { keyId: "acs-1", signature } };
};

const row = (over: Partial<AcsExecutionRow> & Pick<AcsExecutionRow, "name" | "producerEventId">): AcsExecutionRow => ({
  requestId: "req-1",
  workItemId: "wi-1",
  workerId: "worker-1",
  actionHash: "ah-1",
  invocationFingerprint: "inv-1",
  toolName: "read_file",
  at: "2026-11-03T10:00:01.000Z",
  ...over
});

const GRANT = row({ name: "execution.authorization_granted", producerEventId: "g1", at: "2026-11-03T10:00:01.000Z" });
const EXEC = row({
  name: "execution.completed",
  producerEventId: "x1",
  at: "2026-11-03T10:00:02.000Z",
  outcome: "succeeded"
});
const VERIFY = row({
  name: "verification.finished",
  producerEventId: "v1",
  at: "2026-11-03T10:00:03.000Z",
  verification: "passed",
  verifiesProducerEventId: "x1"
});

const newStore = () => new RecorderStore({ enabled: true, trustedKeys: { "acs-1": trustedPem } });
const runRow = (s: RecorderStore) => summarize(s).find((item) => item.runId === "wi-1");

describe("adversarial: forged or downgraded evidence must not establish outcomes", () => {
  test("A1: a signed pass cannot verify an execution that the signed record says failed", async () => {
    const s = newStore();
    await s.ingest(sig(await toRecorderDraft(GRANT)));
    await s.ingest(sig(await toRecorderDraft({ ...EXEC, outcome: "failed" })));
    await s.ingest(sig(await toRecorderDraft(VERIFY)));
    expect(runRow(s)?.verification.state).not.toBe("verified");
  });

  test("A2: an unsigned row cannot be the execution that a signed verification points at", async () => {
    const s = newStore();
    // Attacker occupies the execution's producer id first with an unsigned row.
    const fake = await toRecorderDraft({ ...EXEC, workItemId: "wi-1" });
    await s.ingest({ ...fake, trustLevel: "untrusted_claim" });
    await s.ingest(sig(await toRecorderDraft(GRANT)));
    await s.ingest(sig(await toRecorderDraft(VERIFY)));
    expect(runRow(s)?.verification.state).not.toBe("verified");
  });

  test("A3: unsigned junk in a run cannot poison a valid, granted execution into UNKNOWN", async () => {
    const s = newStore();
    await s.ingest(sig(await toRecorderDraft(GRANT)));
    await s.ingest(sig(await toRecorderDraft(EXEC)));
    await s.ingest(sig(await toRecorderDraft(VERIFY)));
    // Unsigned, unbound "execution" claim injected into the same run.
    await s.ingest({
      producerEventId: "junk-1",
      component: "attacker",
      eventType: "execution.started",
      runId: "wi-1",
      missionId: "wi-1",
      correlationId: "req-1",
      parentEventId: null,
      sourceTimestamp: "2026-11-03T10:00:02.500Z",
      ingestedAt: "2026-11-03T10:00:02.500Z",
      trustLevel: "acs_authoritative",
      metadata: {}
    });
    expect(runRow(s)?.authorization.state).toBe("allowed");
  });

  test("A4: an unsigned claim that occupies a producer id cannot block the authoritative record for that id", async () => {
    const s = newStore();
    const unsignedGrant = await toRecorderDraft(GRANT);
    await s.ingest({ ...unsignedGrant, metadata: { ...unsignedGrant.metadata, capabilityId: "forged" } });
    const real = await s.ingest(sig(await toRecorderDraft(GRANT)));
    expect(real.status).toBe("created");
    expect(real.status === "created" && real.event.trustLevel).toBe("acs_authoritative");
  });

  test("A5: an authoritative execution is still found by its id when an unsigned row shares that id", async () => {
    const s = newStore();
    const unsignedExec = await toRecorderDraft(EXEC);
    await s.ingest({
      ...unsignedExec,
      trustLevel: "untrusted_claim",
      metadata: { ...unsignedExec.metadata, outcome: "succeeded" }
    });
    await s.ingest(sig(await toRecorderDraft(EXEC)));
    const authoritativeId = await recorderEventIdFor("acs-execution", EXEC.producerEventId);
    expect(s.events.get(authoritativeId)?.trustLevel).toBe("acs_authoritative");
  });
});

describe("adversarial: resource limits", () => {
  test("A6: oversized identity and reference fields are truncated, not stored whole", async () => {
    const s = newStore();
    const huge = "x".repeat(200_000);
    await s.ingest({
      producerEventId: huge,
      component: huge,
      identityRef: huge,
      instanceId: huge,
      eventType: huge,
      runId: huge,
      missionId: huge,
      correlationId: huge,
      parentEventId: huge,
      sourceTimestamp: huge,
      ingestedAt: "2026-11-03T10:00:00.000Z",
      trustLevel: "untrusted_claim",
      metadata: {},
      sourceRecordRef: huge
    });
    const [event] = s.events.values();
    expect(JSON.stringify(event).length).toBeLessThan(10_000);
  });
});
