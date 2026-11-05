import { describe, expect, test } from "vitest";
import { exportRun, orderEvents, recomputeFindings, summarize } from "./analyze.js";
import { envelopeForDigest, sha256Hex } from "./canonical.js";
import { RecorderStore } from "./store.js";
import type { IngestDraft, RecorderEvent } from "./types.js";

const base: IngestDraft = {
  producerEventId: "evt-h",
  component: "acs-gateway",
  identityRef: "acs-audit-log",
  eventType: "mission.created",
  runId: "run-h",
  missionId: "run-h",
  correlationId: "c-h",
  parentEventId: null,
  sourceTimestamp: "2026-10-21T09:00:00.000Z",
  ingestedAt: "2026-10-21T09:00:01.000Z",
  trustLevel: "untrusted_claim",
  metadata: { sequence: 1 }
};

const JWT = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload1234.sigvalue";

describe("recorder hardening", () => {
  test("redacts secrets in identity and reference fields, not only metadata", async () => {
    const store = new RecorderStore({ enabled: true });
    await store.ingest({
      ...base,
      identityRef: "sk-live-abcdef123456",
      sourceRecordRef: `Bearer aaa.bbb.ccc`,
      instanceId: JWT,
      releaseId: "release-1"
    });
    const [event] = store.events.values();
    const text = JSON.stringify(event);
    expect(text).not.toContain("sk-live");
    expect(text).not.toContain("Bearer aaa");
    expect(text).not.toContain("eyJhbGci");
    expect(event?.source.identityRef).toBe("[redacted]");
    expect(event?.source.instanceId).toBe("[redacted]");
    expect(event?.source.releaseId).toBe("release-1");
  });

  test("an unauthenticated producer cannot claim ACS or independent authority", async () => {
    const store = new RecorderStore({ enabled: true });
    const result = await store.ingest({ ...base, trustLevel: "acs_authoritative" });
    expect(result.status).toBe("created");
    expect(result.status === "created" && result.event.trustLevel).toBe("untrusted_claim");
    expect(result.status === "created" && result.event.evidence.integrityStatus).toBe("unverifiable");
  });

  test("a trust grant from the caller's authority is honoured", async () => {
    const store = new RecorderStore({ enabled: true, grantTrust: () => true });
    const result = await store.ingest({ ...base, trustLevel: "acs_authoritative" });
    expect(result.status === "created" && result.event.trustLevel).toBe("acs_authoritative");
  });

  test("stored records are immutable", async () => {
    const store = new RecorderStore({ enabled: true });
    await store.ingest(base);
    const [event] = store.events.values();
    expect(Object.isFrozen(event)).toBe(true);
    expect(() => {
      (event!.metadata as Record<string, unknown>).sequence = 99;
    }).toThrow(TypeError);
    expect(() => {
      (event!.source as { component: string }).component = "forged";
    }).toThrow(TypeError);
  });

  test("a caller cannot replace or remove records through the public event view", async () => {
    const store = new RecorderStore({ enabled: true });
    const result = await store.ingest(base);
    if (result.status !== "created") throw new Error("fixture event missing");
    const exposed = store.events as Map<string, RecorderEvent>;
    exposed.clear();
    exposed.set(result.event.eventId, { ...result.event, trustLevel: "acs_authoritative" });
    expect(store.events.get(result.event.eventId)).toBe(result.event);
  });

  test("annotations are redacted before appearing in summaries or exports", async () => {
    const store = new RecorderStore({ enabled: true });
    await store.ingest(base);
    store.annotate("run-h", { instruction: "Inspect with Authorization: Bearer synthetic-credential-123" });
    const bundle = await exportRun(store, "run-h");
    expect(bundle.summary.instruction).toContain("[redacted]");
    expect(JSON.stringify(bundle)).not.toContain("synthetic-credential-123");
  });

  test("exports redact metadata keys and refuse unknown identifiers without echoing them", async () => {
    const store = new RecorderStore({ enabled: true });
    const key = "Bearer synthetic-private-object-key";
    await store.ingest({ ...base, metadata: { [key]: "value" } });
    expect(JSON.stringify(await exportRun(store, "run-h"))).not.toContain("synthetic-private-object-key");
    await expect(exportRun(store, key)).rejects.toThrow("Recorder run was not found");
  });

  test("malformed structural fields are rejected without throwing", async () => {
    const store = new RecorderStore({ enabled: true });
    expect((await store.ingest({ ...base, runId: 42 as unknown as string })).status).toBe("rejected");
    expect((await store.ingest({ ...base, trustLevel: "fictitious" as IngestDraft["trustLevel"] })).status).toBe("rejected");
    expect(store.events.size).toBe(0);
  });

  test("non-text metadata cannot break summary labels", async () => {
    const store = new RecorderStore({ enabled: true });
    await store.ingest({ ...base, metadata: { coverage: {}, tool: {} } });
    expect(summarize(store)[0]).toMatchObject({ coverage: "unknown", tool: "unknown" });
  });

  test("distinct producer identities cannot alias at a NUL delimiter", async () => {
    const store = new RecorderStore({ enabled: true });
    const first = await store.ingest({ ...base, component: "one\0two", producerEventId: "three" });
    const second = await store.ingest({ ...base, component: "one", producerEventId: "two\0three" });
    expect(first.status).toBe("created");
    expect(second.status).toBe("created");
    expect(store.events.size).toBe(2);
  });

  test("malformed Unicode IDs cannot overwrite each other through UTF-8 replacement", async () => {
    const store = new RecorderStore({ enabled: true });
    for (const producerEventId of ["\uD800", "\uD801"]) {
      expect((await store.ingest({ ...base, producerEventId })).status).toBe("created");
    }
    expect(store.events.size).toBe(2);
  });

  test("retry time does not create a conflict, while changed redacted content still does", async () => {
    const store = new RecorderStore({ enabled: true });
    const draft = { ...base, metadata: { token: "synthetic-one" } };
    const first = await store.ingest(draft);
    expect(first.status).toBe("created");
    expect((await store.ingest({ ...draft, ingestedAt: "2026-10-21T09:00:10.000Z" })).status).toBe("duplicate");
    expect((await store.ingest({ ...draft, metadata: { token: "synthetic-two" } })).status).toBe("conflict");
    expect(JSON.stringify(await exportRun(store, "run-h"))).not.toContain("synthetic-");
  });

  test("the stored digest can be independently recomputed from the exported event", async () => {
    const store = new RecorderStore({ enabled: true });
    await store.ingest({ ...base, metadata: { sparse: Array(1) } });
    const bundle = await exportRun(store, "run-h");
    const [event] = JSON.parse(JSON.stringify(bundle.events)) as RecorderEvent[];
    expect(await sha256Hex(envelopeForDigest(event!))).toBe(event!.evidence.payloadSha256);
  });

  test("unscoped records get separate summaries and exports", async () => {
    const store = new RecorderStore({ enabled: true });
    await store.ingest({ ...base, runId: null });
    await store.ingest({ ...base, runId: null, producerEventId: "evt-other" });
    const runs = summarize(store);
    expect(runs).toHaveLength(2);
    for (const { runId } of runs) expect((await exportRun(store, runId)).events).toHaveLength(1);
  });

  test("source ordering and summary timestamps account for timezone offsets", async () => {
    const store = new RecorderStore({ enabled: true });
    const earlier = "2026-10-21T14:00:00.000+05:00";
    const later = "2026-10-21T10:00:00.000Z";
    await store.ingest({ ...base, sourceTimestamp: later });
    await store.ingest({ ...base, producerEventId: "evt-earlier", sourceTimestamp: earlier });
    expect(orderEvents(store.eventsFor("run-h"), "source").map((event) => event.sourceTimestamp)).toEqual([earlier, later]);
    expect(summarize(store)[0]).toMatchObject({ startedAt: earlier, latestAt: later });
  });

  test("an earlier completion cannot hide an open attempt that ages past its observation window", async () => {
    const store = new RecorderStore({ enabled: true });
    const start = { ...base, eventType: "execution.started", metadata: { attemptId: "one" } };
    await store.ingest(start);
    await store.ingest({ ...start, eventType: "execution.completed", producerEventId: "evt-end", parentEventId: start.producerEventId });
    const second = await store.ingest({ ...start, producerEventId: "evt-next", metadata: { attemptId: "two" } });
    if (second.status !== "created") throw new Error("fixture event missing");
    const early = recomputeFindings(store, 120_000, Date.parse("2026-10-21T09:01:00Z"));
    expect(early.some((finding) => finding.ruleId === "abbr.missing-terminal")).toBe(false);
    const late = recomputeFindings(store, 120_000, Date.parse("2026-10-21T09:03:00Z"));
    const gap = late.find((finding) => finding.ruleId === "abbr.missing-terminal");
    expect(gap?.relatedEventIds).toEqual([second.event.eventId]);
    expect(summarize(store)[0]).toMatchObject({ observedState: "running", terminalAt: null });
  });

  test("the ingestion flag is enforced at ingest time", async () => {
    const store = new RecorderStore({ enabled: false });
    const result = await store.ingest(base);
    expect(result.status).toBe("disabled");
    expect(store.events.size).toBe(0);
  });

  test("retention is bounded: a full store rejects new records instead of growing", async () => {
    const store = new RecorderStore({ enabled: true, maxEvents: 2 });
    for (const id of ["a", "b", "c"]) await store.ingest({ ...base, producerEventId: id });
    expect(store.events.size).toBe(2);
    const third = await store.ingest({ ...base, producerEventId: "c" });
    expect(third.status).toBe("rejected");
  });

  test("run annotations are capped: a new run beyond the cap is refused, an existing run still updates", () => {
    const store = new RecorderStore({ enabled: true, maxRuns: 2 });
    expect(store.annotate("r1", { agent: "a" })).toBe(true);
    expect(store.annotate("r2", { agent: "b" })).toBe(true);
    expect(store.annotate("r3", { agent: "c" })).toBe(false);
    expect(store.annotations.has("r3")).toBe(false);
    expect(store.annotate("r1", { tool: "t" })).toBe(true);
    expect(store.annotations.size).toBe(2);
  });

  test("conflicts are capped with the same bound as records", async () => {
    const store = new RecorderStore({ enabled: true, maxEvents: 1 });
    await store.ingest(base);
    for (let i = 0; i < 5; i++) await store.ingest({ ...base, metadata: { sequence: 100 + i } });
    expect(store.conflicts.length).toBe(1);
    expect(store.events.size).toBe(1);
  });

  test("retention of conflict details cannot hide a different run's integrity failure", async () => {
    const store = new RecorderStore({ enabled: true, maxEvents: 2 });
    const other = { ...base, producerEventId: "evt-other", runId: "run-other" };
    await store.ingest(base);
    await store.ingest(other);
    await store.ingest({ ...base, metadata: { sequence: 10 } });
    await store.ingest({ ...base, metadata: { sequence: 20 } });
    expect((await store.ingest({ ...other, metadata: { sequence: 30 } })).status).toBe("conflict");
    expect(store.conflicts.length).toBe(2);
    expect(summarize(store).find((run) => run.runId === "run-other")?.evidence.completeness).toBe("unverifiable");
  });

  test("duplicate detection digests redacted content, so a secret cannot be recovered from the digest", async () => {
    const one = new RecorderStore({ enabled: true });
    const two = new RecorderStore({ enabled: true });
    const a = await one.ingest({ ...base, identityRef: "sk-live-aaaaaaaa1111" });
    const b = await two.ingest({ ...base, identityRef: "sk-live-bbbbbbbb2222" });
    expect(a.status === "created" && b.status === "created").toBe(true);
    if (a.status !== "created" || b.status !== "created") return;
    expect(a.event.evidence.payloadSha256).toBe(b.event.evidence.payloadSha256);
    expect(JSON.stringify(a.event)).not.toContain("sk-live");
  });
});
