import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, test } from "vitest";
import { canonicalJson } from "./canonical.js";
import { summarize } from "./analyze.js";
import { signedPayload } from "./provenance.js";
import { RecorderStore } from "./store.js";
import type { IngestDraft } from "./types.js";

const acs = generateKeyPairSync("ed25519");
const pem = acs.publicKey.export({ format: "pem", type: "spki" }).toString();

function signed(draft: IngestDraft): IngestDraft {
  const signature = sign(null, Buffer.from(canonicalJson(signedPayload(draft))), acs.privateKey).toString("base64");
  return { ...draft, provenance: { keyId: "acs-1", signature } };
}

const at = (n: number) => `2026-11-03T09:00:${String(n).padStart(2, "0")}.000Z`;

function draft(partial: Partial<IngestDraft> & Pick<IngestDraft, "producerEventId" | "eventType">): IngestDraft {
  return {
    component: "acs-gateway",
    identityRef: "acs-audit-log",
    runId: "run-b",
    missionId: "run-b",
    correlationId: "c-b",
    parentEventId: null,
    sourceTimestamp: partial.eventType.startsWith("verification.") ? at(4) : at(1),
    ingestedAt: at(2),
    trustLevel: "acs_authoritative",
    metadata: {},
    ...partial
  };
}

async function runWith(drafts: IngestDraft[]) {
  const store = new RecorderStore({ enabled: true, trustedKeys: { "acs-1": pem } });
  for (const d of drafts) await store.ingest(d);
  const row = summarize(store).find((item) => item.runId === "run-b");
  return row;
}

const execution = (id: string, decisionId: string) =>
  draft({
    producerEventId: id,
    eventType: "execution.completed",
    sourceTimestamp: at(3),
    metadata: { outcome: "succeeded", decisionId, capabilityId: "cap-1", actor: "jace", actionHash: "action-1" }
  });

describe("authorization and verification are bound to their context", () => {
  test("a valid signature on an authorization with the matching decision and actor is honoured", async () => {
    const row = await runWith([
      signed(
        draft({
          producerEventId: "a1",
          eventType: "authorization.allowed",
          metadata: { decisionId: "d1", actor: "jace", capabilityId: "cap-1", actionHash: "action-1" }
        })
      ),
      signed(execution("e1", "d1"))
    ]);
    expect(row?.authorization.state).toBe("allowed");
  });

  test("a stale or late grant does not authorize an execution that happened before it", async () => {
    const row = await runWith([
      signed(
        draft({
          producerEventId: "a9",
          eventType: "authorization.allowed",
          sourceTimestamp: at(5),
          metadata: { decisionId: "d1", actor: "jace", capabilityId: "cap-1", actionHash: "action-1" }
        })
      ),
      signed(execution("e9", "d1"))
    ]);
    expect(row?.authorization.state).not.toBe("allowed");
  });

  test("a signed authorization with no decision or actor is not authorization", async () => {
    const row = await runWith([
      signed(draft({ producerEventId: "a2", eventType: "authorization.allowed", metadata: {} }))
    ]);
    expect(row?.authorization.state).not.toBe("allowed");
  });

  test("an unsigned authorization claim is never authorization, even with full context", async () => {
    const row = await runWith([
      draft({
        producerEventId: "a3",
        eventType: "authorization.allowed",
        trustLevel: "acs_authoritative",
        metadata: { decisionId: "d1", actor: "jace", capabilityId: "cap-1", actionHash: "action-1" }
      })
    ]);
    expect(row?.authorization.state).not.toBe("allowed");
  });

  test("a validly signed authorization for a different decision does not authorize this execution", async () => {
    const row = await runWith([
      signed(
        draft({
          producerEventId: "a4",
          eventType: "authorization.allowed",
          metadata: { decisionId: "d-other", actor: "jace", capabilityId: "cap-1", actionHash: "action-1" }
        })
      ),
      signed(execution("e4", "d1"))
    ]);
    expect(row?.authorization.state).not.toBe("allowed");
  });

  test("a signed verification.passed bound to an execution in the same run verifies it", async () => {
    const store = new RecorderStore({ enabled: true, trustedKeys: { "acs-1": pem } });
    const ex = await store.ingest(signed(execution("e8", "d1")));
    expect(ex.status).toBe("created");
    if (ex.status !== "created") return;
    await store.ingest(
      signed(
        draft({
          producerEventId: "v8",
          eventType: "verification.passed",
          metadata: { executionEventId: ex.event.eventId }
        })
      )
    );
    const row = summarize(store).find((item) => item.runId === "run-b");
    expect(row?.verification.state).toBe("verified");
  });

  test("a signed verification.passed that names no execution does not verify the run", async () => {
    const row = await runWith([
      signed(execution("e5", "d1")),
      signed(draft({ producerEventId: "v5", eventType: "verification.passed", metadata: {} }))
    ]);
    expect(row?.verification.state).not.toBe("verified");
  });

  test("a signed verification.passed bound to an execution in another run does not verify this run", async () => {
    const row = await runWith([
      signed(execution("e6", "d1")),
      signed(
        draft({
          producerEventId: "v6",
          eventType: "verification.passed",
          metadata: { executionEventId: "some-other-run-event" }
        })
      )
    ]);
    expect(row?.verification.state).not.toBe("verified");
  });

  test("an unsigned verification.passed cannot verify a run", async () => {
    const row = await runWith([
      signed(execution("e7", "d1")),
      draft({ producerEventId: "v7", eventType: "verification.passed", trustLevel: "untrusted_claim", metadata: {} })
    ]);
    expect(row?.verification.state).not.toBe("verified");
  });
});
