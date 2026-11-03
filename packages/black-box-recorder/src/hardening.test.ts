import { describe, expect, test } from "vitest";
import { RecorderStore } from "./store.js";
import type { IngestDraft } from "./types.js";

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
