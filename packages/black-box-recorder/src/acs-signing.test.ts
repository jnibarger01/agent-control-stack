import { generateKeyPairSync } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { summarize, summarizeRun } from "./analyze.js";
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

  test("a signed verification row with no verdict cannot verify a run", async () => {
    const store = await ingestAll([GRANT, EXEC, { ...VERIFY, verification: undefined }], withAcs);
    expect(runRow(store)?.verification.state).toBe("unverified");
    expect(store.findings.some((finding) => finding.ruleId === "abbr.unverified-success")).toBe(true);
  });

  test.each([
    ["a start", { ...EXEC, name: "execution.started" }, VERIFY],
    ["a later execution", EXEC, { ...VERIFY, at: "2026-11-03T10:00:01.000Z" }],
    ["an unrelated action", EXEC, { ...VERIFY, actionHash: "other-action" }],
    ["an unrelated capability", EXEC, { ...VERIFY, invocationFingerprint: "other-capability" }]
  ])("a trusted pass cannot verify %s", async (_label, execution, verification) => {
    const store = await ingestAll([GRANT, execution, verification], withAcs);
    expect(runRow(store)?.verification.state).toBe("unverified");
  });

  test("distinct run IDs that redact identically cannot share signed evidence", async () => {
    const store = await ingestAll([
      { ...GRANT, workItemId: "sk-synthetic-run-grant" },
      { ...EXEC, workItemId: "sk-synthetic-run-exec" },
      { ...VERIFY, workItemId: "sk-synthetic-run-verify" }
    ], withAcs);
    const runs = summarize(store);
    expect(runs).toHaveLength(3);
    expect(runs.some((run) => run.verification.state === "verified")).toBe(false);
  });

  test("a validator reference cannot alias a different redacted producer ID", async () => {
    const store = await ingestAll([
      GRANT,
      { ...EXEC, producerEventId: "sk-synthetic-record-alpha" },
      { ...VERIFY, verifiesProducerEventId: "sk-synthetic-record-bravo" }
    ], withAcs);
    expect(runRow(store)?.verification.state).toBe("unverified");
  });

  test("the public summary uses stored records even when supplied copies claim higher trust", async () => {
    const store = await ingestAll([GRANT, EXEC, VERIFY], unsigned);
    const copied = store.eventsFor("wi-1").map((event) => ({ ...event, trustLevel: "acs_authoritative" as const }));
    expect(summarizeRun("wi-1", copied, store).authorization.state).toBe("unknown");
  });

  test("an authorization request preceding its grant is not executed work", async () => {
    const requested = { ...GRANT, name: "execution.authorization_requested", producerEventId: "request", at: "2026-11-03T10:00:00.000Z" };
    const store = await ingestAll([requested, GRANT, EXEC, VERIFY], withAcs);
    expect(runRow(store)?.authorization.state).toBe("allowed");
  });

  test("mutating the caller's draft during ingestion cannot mix signed and unsigned fields", async () => {
    const store = await ingestAll([], withAcs);
    const signed = withAcs(await toRecorderDraft(GRANT));
    const mutable = { ...signed, metadata: { ...signed.metadata, actor: "forged-worker" } };
    const pending = store.ingest(mutable);
    mutable.metadata = signed.metadata as typeof mutable.metadata;
    const result = await pending;
    if (result.status !== "created") throw new Error("fixture event missing");
    expect(result.event.trustLevel).toBe("untrusted_claim");
    expect(runRow(store)?.authorization.state).toBe("unknown");
  });

  test("redacted actor fields cannot make distinct trusted identities match", async () => {
    const store = await ingestAll([
      { ...GRANT, workerId: "Bearer synthetic-actor-credential-a" },
      { ...EXEC, workerId: "Bearer synthetic-actor-credential-b" }
    ], withAcs);
    expect(runRow(store)?.authorization.state).toBe("unknown");
  });

  test("authorization binds both the execution actor and the action hash", async () => {
    for (const execution of [{ ...EXEC, workerId: "other-worker" }, { ...EXEC, actionHash: "other-action" }]) {
      const store = await ingestAll([GRANT, execution], withAcs);
      expect(runRow(store)?.authorization.state).toBe("unknown");
      expect(store.findings.some((finding) => finding.ruleId === "abbr.missing-authorization")).toBe(true);
    }
  });

  test("a later capability cannot inherit the earlier grant time of another capability", async () => {
    const later = { ...GRANT, producerEventId: "later", invocationFingerprint: "inv-2", at: "2026-11-03T10:00:09.000Z" };
    const store = await ingestAll([GRANT, later, { ...EXEC, invocationFingerprint: "inv-2" }], withAcs);
    expect(runRow(store)?.authorization.state).toBe("unknown");
  });

  test("unsigned negative claims cannot override a signed chain or its evidence references", async () => {
    const store = await ingestAll([GRANT, EXEC, VERIFY], withAcs);
    const before = runRow(store);
    await store.ingest(await toRecorderDraft({ ...GRANT, name: "execution.authorization_denied", producerEventId: "denied" }));
    await store.ingest(await toRecorderDraft({ ...VERIFY, producerEventId: "failed", verification: "failed" }));
    const after = runRow(store);
    expect(after?.authorization).toEqual(before?.authorization);
    expect(after?.verification).toEqual(before?.verification);
    expect(store.findings.some((finding) => finding.ruleId === "abbr.validator-failed")).toBe(false);
  });

  test("negative verdicts must bind to the run's authenticated execution", async () => {
    const denial = { ...GRANT, name: "execution.authorization_denied", producerEventId: "denied", workerId: "other-worker" };
    const failure = { ...VERIFY, producerEventId: "failed", verification: "failed" as const, verifiesProducerEventId: "missing" };
    const store = await ingestAll([denial, failure, GRANT, EXEC, VERIFY], withAcs);
    const result = runRow(store);
    expect(result?.authorization.state).toBe("allowed");
    expect(result?.verification.state).toBe("verified");
    expect(result?.authorization.evidenceEventId).toBe(store.eventsFor("wi-1").find((event) => event.source.producerEventId === "g1")?.eventId);
    expect(result?.verification.evidenceEventId).toBe(store.eventsFor("wi-1").find((event) => event.source.producerEventId === "v1")?.eventId);
  });

  test("verification covers every authenticated successful execution", async () => {
    const second = { ...EXEC, producerEventId: "x2", at: "2026-11-03T10:00:04.000Z" };
    const store = await ingestAll([GRANT, EXEC, VERIFY, second], withAcs);
    expect(runRow(store)?.verification.state).toBe("unverified");
    expect(store.findings.some((finding) => finding.ruleId === "abbr.unverified-success")).toBe(true);
    await store.ingest(withAcs(await toRecorderDraft({ ...VERIFY, producerEventId: "v2", verifiesProducerEventId: "x2", at: "2026-11-03T10:00:05.000Z" })));
    expect(runRow(store)?.verification.state).toBe("verified");
  });

  test("an execution's declared success can be verified without redundant outcome metadata", async () => {
    const store = await ingestAll([GRANT, { ...EXEC, outcome: undefined }, VERIFY], withAcs);
    expect(runRow(store)?.verification.state).toBe("verified");
  });

  test("authenticated producers constrain grants and can supply an execution for independent verification", async () => {
    const store = await ingestAll([GRANT], withAcs);
    const execution = await toRecorderDraft({ ...EXEC, workerId: "other-worker" });
    await store.ingest(execution);
    const accepted = await store.ingest(withAcs({ ...execution, trustLevel: "authenticated_producer" }));
    expect(accepted.status).toBe("created");
    if (accepted.status !== "created") throw new Error("authenticated execution was not stored");
    const verification = await toRecorderDraft(VERIFY);
    await store.ingest(withAcs({ ...verification, metadata: { ...verification.metadata, executionEventId: accepted.event.eventId } }));
    expect(runRow(store)?.authorization.state).toBe("unknown");
    expect(runRow(store)?.verification.state).toBe("verified");
  });

  test("a trusted failure bound to the execution takes precedence over a trusted pass", async () => {
    const failure = { ...VERIFY, producerEventId: "failed", verification: "failed" as const };
    const store = await ingestAll([GRANT, EXEC, VERIFY, failure], withAcs);
    expect(runRow(store)?.verification.state).toBe("failed");
    expect(store.findings.some((finding) => finding.ruleId === "abbr.validator-failed")).toBe(true);
    expect(store.findings.some((finding) => finding.ruleId === "abbr.unverified-success")).toBe(false);
  });

  test("conflicted trusted grants, executions and validator records cannot support a pass", async () => {
    const conflictingPass = await ingestAll([GRANT, EXEC, VERIFY, { ...VERIFY, verification: "failed" }], withAcs);
    expect(runRow(conflictingPass)).toMatchObject({ verification: { state: "unverified" }, evidence: { completeness: "unverifiable" } });
    const conflictingGrant = await ingestAll([GRANT, EXEC, VERIFY, { ...GRANT, actionHash: "conflicting-action" }], withAcs);
    expect(runRow(conflictingGrant)?.authorization.state).toBe("unknown");
    const conflictingExecution = await ingestAll([GRANT, EXEC, VERIFY, { ...EXEC, outcome: "failed" }], withAcs);
    expect(runRow(conflictingExecution)).toMatchObject({ authorization: { state: "unknown" }, verification: { state: "unverified" } });
  });

  test("ACS tool completion events close the recorded start", async () => {
    const start = { ...EXEC, name: "execution.started", producerEventId: "start", outcome: undefined };
    const end = { ...EXEC, name: "desktop_commander.tool_succeeded", producerEventId: "end" };
    const store = await ingestAll([GRANT, start, end], withAcs);
    expect(runRow(store)?.terminalAt).toBe(end.at);
    expect(runRow(store)?.observedState).toBe("completed");
  });

  test("a reused attempt ID cannot close a start with contradictory trusted bindings", async () => {
    const store = await ingestAll([GRANT], withAcs);
    const start = await toRecorderDraft({ ...EXEC, name: "execution.started", producerEventId: "start", outcome: undefined });
    const end = await toRecorderDraft({ ...EXEC, name: "desktop_commander.tool_succeeded", workerId: "other-worker" });
    for (const draft of [start, end]) await store.ingest(withAcs({ ...draft, metadata: { ...draft.metadata, attemptId: "one" } }));
    expect(runRow(store)).toMatchObject({ observedState: "running", terminalAt: null });
  });

  test("a bare producer ID cannot close a start from another producer namespace", async () => {
    const store = await ingestAll([GRANT, { ...EXEC, name: "execution.started", producerEventId: "start", outcome: undefined }], withAcs);
    const end = await toRecorderDraft(EXEC);
    await store.ingest(withAcs({ ...end, component: "another-producer", trustLevel: "authenticated_producer", parentEventId: "start", metadata: { outcome: "succeeded" } }));
    expect(runRow(store)).toMatchObject({ observedState: "running", terminalAt: null });
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
