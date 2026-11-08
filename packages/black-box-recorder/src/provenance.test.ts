import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, test } from "vitest";
import { canonicalJson } from "./canonical.js";
import { RecorderStore } from "./store.js";
import { signedPayload } from "./provenance.js";
import type { IngestDraft } from "./types.js";

const acs = generateKeyPairSync("ed25519");
const rogue = generateKeyPairSync("ed25519");
const pem = (key: typeof acs) => key.publicKey.export({ format: "pem", type: "spki" }).toString();

const base: IngestDraft = {
  producerEventId: "evt-p",
  component: "acs-gateway",
  identityRef: "acs-audit-log",
  eventType: "work_item.approved",
  runId: "run-p",
  missionId: "run-p",
  correlationId: "c-p",
  parentEventId: null,
  sourceTimestamp: "2026-11-03T09:00:00.000Z",
  ingestedAt: "2026-11-03T09:00:01.000Z",
  trustLevel: "acs_authoritative",
  metadata: { sequence: 1 }
};

function signed(draft: IngestDraft, key: typeof acs = acs, keyId = "acs-1"): IngestDraft {
  const signature = sign(null, Buffer.from(canonicalJson(signedPayload(draft))), key.privateKey).toString("base64");
  return { ...draft, provenance: { keyId, signature } };
}

const store = () => new RecorderStore({ enabled: true, trustedKeys: { "acs-1": pem(acs) } });

describe("authenticated provenance", () => {
  test("an ACS-signed authoritative record keeps its trust level", async () => {
    const result = await store().ingest(signed(base));
    expect(result.status === "created" && result.event.trustLevel).toBe("acs_authoritative");
  });

  test("an unsigned claim of ACS authority is downgraded", async () => {
    const result = await store().ingest(base);
    expect(result.status === "created" && result.event.trustLevel).toBe("untrusted_claim");
  });

  test("a signature from a key the recorder does not trust is downgraded", async () => {
    const result = await store().ingest(signed(base, rogue, "acs-1"));
    expect(result.status === "created" && result.event.trustLevel).toBe("untrusted_claim");
  });

  test("an unknown key id is downgraded even with a valid signature", async () => {
    const result = await store().ingest(signed(base, acs, "unknown-key"));
    expect(result.status === "created" && result.event.trustLevel).toBe("untrusted_claim");
  });

  test("tampering with signed metadata invalidates the signature", async () => {
    const tampered = { ...signed(base), metadata: { sequence: 1, approved: true } };
    const result = await store().ingest(tampered);
    expect(result.status === "created" && result.event.trustLevel).toBe("untrusted_claim");
  });

  test("replaying a signed record under a different run is rejected by the signature", async () => {
    const replayed = { ...signed(base), runId: "run-other", missionId: "run-other" };
    const result = await store().ingest(replayed);
    expect(result.status === "created" && result.event.trustLevel).toBe("untrusted_claim");
  });

  test("replaying the identical signed record is idempotent, not a second record", async () => {
    const s = store();
    const first = await s.ingest(signed(base));
    const again = await s.ingest(signed(base));
    expect(first.status).toBe("created");
    expect(again.status).toBe("duplicate");
    expect(s.events.size).toBe(1);
  });

  test("a signature does not cover a different producer event id", async () => {
    const moved = { ...signed(base), producerEventId: "evt-other" };
    const result = await store().ingest(moved);
    expect(result.status === "created" && result.event.trustLevel).toBe("untrusted_claim");
  });
});
