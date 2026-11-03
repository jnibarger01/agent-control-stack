import { generateKeyPairSync } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { summarize } from "./analyze.js";
import { toRecorderDraft, type AcsExecutionRow } from "./acs-emitter.js";
import { signRecordDraft } from "./signing.js";
import { RecorderStore } from "./store.js";
import type { IngestDraft } from "./types.js";
import * as publicApi from "./index.js";

// Keys are generated in memory for each run. No key material is committed, bundled, or logged.
const acs = generateKeyPairSync("ed25519");
const rogue = generateKeyPairSync("ed25519");
const trustedPem = acs.publicKey.export({ format: "pem", type: "spki" }).toString();
const acsPrivatePem = acs.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const roguePrivatePem = rogue.privateKey.export({ format: "pem", type: "pkcs8" }).toString();

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

async function ingestAll(
  rows: AcsExecutionRow[],
  sign: (d: IngestDraft) => IngestDraft,
  options: { enabled?: boolean } = {}
) {
  const store = new RecorderStore({ enabled: options.enabled ?? true, trustedKeys: { "acs-1": trustedPem } });
  for (const r of rows) {
    const draft = await toRecorderDraft(r);
    await store.ingest(sign(draft));
  }
  return store;
}

const withAcs = (d: IngestDraft) => signRecordDraft(d, acsPrivatePem, "acs-1");
const withRogue = (d: IngestDraft) => signRecordDraft(d, roguePrivatePem, "acs-1");
const unsigned = (d: IngestDraft) => d;

const runRow = (store: RecorderStore) => summarize(store).find((item) => item.runId === "wi-1");

describe("ACS-signed execution evidence", () => {
  test("a complete chain signed by the ACS key establishes allowed and verified", async () => {
    const row = runRow(await ingestAll([GRANT, EXEC, VERIFY], withAcs));
    expect(row?.authorization.state).toBe("allowed");
    expect(row?.verification.state).toBe("verified");
  });

  test("forged records signed by another key establish nothing", async () => {
    const row = runRow(await ingestAll([GRANT, EXEC, VERIFY], withRogue));
    expect(row?.authorization.state).not.toBe("allowed");
    expect(row?.verification.state).not.toBe("verified");
  });

  test("unsigned records establish nothing, even with complete context", async () => {
    const row = runRow(await ingestAll([GRANT, EXEC, VERIFY], unsigned));
    expect(row?.authorization.state).not.toBe("allowed");
    expect(row?.verification.state).not.toBe("verified");
  });

  test("a grant recorded after its execution is stale and does not authorize it", async () => {
    const late = row({
      ...GRANT,
      name: "execution.authorization_granted",
      producerEventId: "g2",
      at: "2026-11-03T10:00:09.000Z"
    });
    const row2 = runRow(await ingestAll([late, EXEC], withAcs));
    expect(row2?.authorization.state).not.toBe("allowed");
  });

  test("a grant for a different decision does not authorize this execution", async () => {
    const other = row({ ...GRANT, requestId: "req-other", producerEventId: "g3" });
    const r = runRow(await ingestAll([other, EXEC], withAcs));
    expect(r?.authorization.state).not.toBe("allowed");
  });

  test("a grant for the same decision but a different tool invocation does not authorize this capability", async () => {
    const otherCall = row({ ...GRANT, invocationFingerprint: "inv-other", producerEventId: "g4" });
    const r = runRow(await ingestAll([otherCall, EXEC], withAcs));
    expect(r?.authorization.state).not.toBe("allowed");
  });

  test("a verification that names an execution from another run does not verify this run", async () => {
    const foreign = row({ ...VERIFY, verifiesProducerEventId: "x-from-elsewhere" });
    const r = runRow(await ingestAll([GRANT, EXEC, foreign], withAcs));
    expect(r?.verification.state).not.toBe("verified");
  });

  test("tampering with a signed record after signing invalidates it", async () => {
    const store = new RecorderStore({ enabled: true, trustedKeys: { "acs-1": trustedPem } });
    const signed = withAcs(await toRecorderDraft(EXEC));
    const tampered = { ...signed, metadata: { ...signed.metadata, outcome: "failed" } };
    const result = await store.ingest(tampered);
    expect(result.status === "created" && result.event.trustLevel).toBe("untrusted_claim");
  });

  test("replaying a signed row under another run is rejected by the signature", async () => {
    const store = new RecorderStore({ enabled: true, trustedKeys: { "acs-1": trustedPem } });
    const signed = withAcs(await toRecorderDraft(EXEC));
    const replay = { ...signed, runId: "wi-other", missionId: "wi-other" };
    const result = await store.ingest(replay);
    expect(result.status === "created" && result.event.trustLevel).toBe("untrusted_claim");
  });

  test("with the ingestion flag off, nothing is recorded even when signed", async () => {
    const store = await ingestAll([GRANT, EXEC, VERIFY], withAcs, { enabled: false });
    expect(store.events.size).toBe(0);
  });

  test("the public API exposes no signing function, so the key path cannot reach the browser bundle", () => {
    expect(Object.keys(publicApi)).not.toContain("signRecordDraft");
    expect(Object.keys(publicApi)).toContain("toRecorderDraft");
  });

  test("no private key material exists in package source or the bundled snapshot", () => {
    const dir = new URL(".", import.meta.url);
    const files = readdirSync(dir).filter((name) => /\.(ts|json)$/.test(name) && !name.endsWith(".test.ts"));
    for (const name of [...files, "snapshot.json"]) {
      const text = readFileSync(new URL(name, dir), "utf8");
      expect(text, name).not.toMatch(/BEGIN (?:ENCRYPTED )?PRIVATE KEY/);
    }
  });
});
