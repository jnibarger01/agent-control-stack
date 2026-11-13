import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, sha256Hex, type JcKernelWitnessReceiptV1 } from "@agent-control-stack/black-box-recorder";
import { canonicalTraceJson, traceSha256 } from "@agent-control-stack/work-items";
import { afterEach, describe, expect, it } from "vitest";
import { correlate } from "../src/correlate.js";
import { buildGapReport } from "../src/gaps.js";
import {
  EVIDENCE_SCHEMA_VERSION,
  contentHash,
  eventId,
  stageOf,
  type EvidenceEvent
} from "../src/model.js";
import { JcTraceReader } from "../src/sources/jc-trace.js";
import { witnessReceiptToEvidence } from "../src/sources/witness.js";
import { verifyAssertions } from "../src/verify.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

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
    observerId: "witness-1",
    workItemId: "wi-1",
    attemptId: "att-1",
    leaseId: "lease-1",
    invocationHash: "a".repeat(64),
    cgroupId: 1001,
    cgroupPath: "/sys/fs/cgroup/jc-wi-1",
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
    acsAnchorRef: "acs:audit:1",
    signingKeyId: "wk-1",
    ...overrides
  };
  const canonical = canonicalJson(body);
  const evidenceHash = await sha256Hex(canonical);
  const signature = sign(null, Buffer.from(canonical, "utf8"), privateKeyPem).toString("base64");
  return { ...body, evidenceHash, signature };
}

function makeAcsState(workItemId: string, status = "succeeded"): EvidenceEvent {
  const ev: EvidenceEvent = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    event_id: eventId("acs", `state.${workItemId}`),
    trace_id: null,
    request_id: null,
    work_item_id: workItemId,
    span_id: null,
    parent_span_id: null,
    timestamp: "2026-11-13T00:00:00.000Z",
    observed_at: "2026-11-13T00:00:01.000Z",
    actor: { id: "acs", type: "system" },
    source: { system: "acs", component: "store", instance: null },
    event_type: "lifecycle.state",
    stage: stageOf("lifecycle.state"),
    decision: null,
    tool_name: null,
    capability_id: null,
    release_sha: null,
    status,
    evidence_ref: `acs://work_items/${workItemId}`,
    integrity: {
      trust: "authoritative",
      basis: "acs_db",
      hash_verified: true,
      chain: "verified",
      content_hash: ""
    },
    causes: [],
    facts: {
      audit_events: 2,
      audit_chain_broken: 0,
      trace_chain_broken: 0,
      audit_tail_truncated: false,
      audit_rows_missing: false,
      trace_tail_truncated: false,
      audit_head_unproven: false,
      trace_head_unproven: false
    },
    refs: {},
    untrusted: {},
    flags: []
  };
  ev.integrity.content_hash = contentHash({ ...ev, observed_at: undefined });
  return ev;
}

function makeValidationPass(workItemId: string): EvidenceEvent {
  const ev: EvidenceEvent = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    event_id: eventId("acs", `val.${workItemId}`),
    trace_id: null,
    request_id: null,
    work_item_id: workItemId,
    span_id: null,
    parent_span_id: null,
    timestamp: "2026-11-13T00:00:01.000Z",
    observed_at: "2026-11-13T00:00:01.000Z",
    actor: { id: "validator", type: "system" },
    source: { system: "acs", component: "validator", instance: null },
    event_type: "observation.validation_run",
    stage: stageOf("observation.validation_run"),
    decision: null,
    tool_name: null,
    capability_id: null,
    release_sha: null,
    status: "passed",
    evidence_ref: `acs://validation/${workItemId}`,
    integrity: {
      trust: "observed",
      basis: "acs_validation",
      hash_verified: true,
      chain: "verified",
      content_hash: ""
    },
    causes: [],
    facts: { passed: true },
    refs: {},
    untrusted: {},
    flags: []
  };
  ev.integrity.content_hash = contentHash({ ...ev, observed_at: undefined });
  return ev;
}

describe("LoopTrace Query JC correlation & Witness verification", () => {
  it("preserves attemptId and leaseId from JC LoopTrace records and flags missing/conflicting IDs", () => {
    const dir = mkdtempSync(join(tmpdir(), "ltq-jc-corr-"));
    dirs.push(dir);

    const runId = "jc-mcp-123-1000";
    const ev1Base = {
      run_id: runId,
      seq: 0,
      ts: "2026-11-13T00:00:00.000Z",
      type: "tool_call_finished",
      payload: {
        tool: "start_process",
        argumentsSha256: "b".repeat(64),
        ok: true,
        workItemId: "wi-1",
        attemptId: "att-1",
        leaseId: "lease-1"
      },
      redacted: false,
      prev_hash: "0".repeat(64)
    };
    const ev1 = { ...ev1Base, hash: traceSha256(`${ev1Base.prev_hash}\n${canonicalTraceJson(ev1Base)}`) };

    const ev2Base = {
      run_id: runId,
      seq: 1,
      ts: "2026-11-13T00:00:01.000Z",
      type: "tool_call_finished",
      payload: {
        tool: "start_process",
        argumentsSha256: "c".repeat(64),
        ok: true,
        workItemId: "wi-1"
        // missing attemptId & leaseId
      },
      redacted: false,
      prev_hash: ev1.hash
    };
    const ev2 = { ...ev2Base, hash: traceSha256(`${ev2Base.prev_hash}\n${canonicalTraceJson(ev2Base)}`) };

    writeFileSync(join(dir, `${runId}.jsonl`), `${JSON.stringify(ev1)}\n${JSON.stringify(ev2)}\n`, "utf8");

    const reader = new JcTraceReader([dir], () => new Date("2026-11-13T00:00:05.000Z"));
    const res = reader.collect("wi-1");
    const finished = res.events.filter((e) => e.event_type === "jc.tool.finished");
    expect(finished).toHaveLength(2);
    expect(finished[0]!.facts.jc_attempt_id).toBe("att-1");
    expect(finished[0]!.facts.jc_lease_id).toBe("lease-1");
    expect(finished[0]!.refs.attempt_id).toBe("att-1");
    expect(finished[0]!.refs.lease_id).toBe("lease-1");
    expect(finished[1]!.flags).toContain("jc_missing_correlation_ids");
  });

  it("never produces PASS when witness observation is incomplete or has forged provenance", async () => {
    const { publicKeyPem, privateKeyPem } = makeEd25519Keys();
    const now = new Date("2026-11-13T00:00:05.000Z");

    // 1. Complete, signed, anchored witness -> PASS is allowed when validation passes
    const completeReceipt = await signReceipt({}, privateKeyPem);
    const completeEv = await witnessReceiptToEvidence(completeReceipt, {
      trustedWitnessKeys: { "wk-1": publicKeyPem },
      now
    });
    expect(completeEv.event_type).toBe("witness.observed");
    expect(completeEv.integrity.trust).toBe("observed");

    // 2. Incomplete witness -> downgrades PASS to INCONCLUSIVE
    const incompleteReceipt = await signReceipt(
      { status: "incomplete", incompleteReasons: ["ringbuf_overflow"], droppedEvents: 2 },
      privateKeyPem
    );
    const incompleteEv = await witnessReceiptToEvidence(incompleteReceipt, {
      trustedWitnessKeys: { "wk-1": publicKeyPem },
      now
    });
    expect(incompleteEv.event_type).toBe("witness.incomplete");
    expect(incompleteEv.integrity.trust).toBe("asserted");

    const baseEvents = [makeAcsState("wi-1"), makeValidationPass("wi-1"), incompleteEv];
    const corrIncomplete = correlate(baseEvents);
    const viewIncomplete = {
      events: corrIncomplete.events,
      state: baseEvents[0]!,
      status: "succeeded",
      of: (t: EvidenceEvent["event_type"]) => corrIncomplete.events.filter((e) => e.event_type === t),
      refs: (...es: Array<EvidenceEvent | undefined>) => es.filter(Boolean).map((e) => e!.evidence_ref)
    };
    const resIncomplete = await verifyAssertions(
      [{ type: "operation_completed" }],
      viewIncomplete as never,
      corrIncomplete,
      [{ source: "acs", status: "ok", detail: "" }],
      { releaseRoots: [], healthTargets: [], now }
    );
    expect(resIncomplete[0]!.verdict).toBe("INCONCLUSIVE");

    // 3. Forged provenance witness -> fails closed with ERROR (never PASS)
    const forgedReceipt = { ...completeReceipt, cgroupId: 999999 };
    const forgedEv = await witnessReceiptToEvidence(forgedReceipt, {
      trustedWitnessKeys: { "wk-1": publicKeyPem },
      now
    });
    expect(forgedEv.integrity.hash_verified).toBe(false);
    expect(forgedEv.integrity.chain).toBe("broken");

    const forgedEvents = [makeAcsState("wi-1"), makeValidationPass("wi-1"), forgedEv];
    const corrForged = correlate(forgedEvents);
    const viewForged = {
      events: corrForged.events,
      state: forgedEvents[0]!,
      status: "succeeded",
      of: (t: EvidenceEvent["event_type"]) => corrForged.events.filter((e) => e.event_type === t),
      refs: (...es: Array<EvidenceEvent | undefined>) => es.filter(Boolean).map((e) => e!.evidence_ref)
    };
    const resForged = await verifyAssertions(
      [{ type: "operation_completed" }],
      viewForged as never,
      corrForged,
      [{ source: "acs", status: "ok", detail: "" }],
      { releaseRoots: [], healthTargets: [], now }
    );
    expect(resForged[0]!.verdict).toBe("ERROR");

    const gaps = buildGapReport(viewForged as never, corrForged, [{ source: "acs", status: "ok", detail: "" }], now);
    expect(gaps.gaps.some((g) => g.code === "WITNESS_PROVENANCE_INVALID")).toBe(true);
  });
});
