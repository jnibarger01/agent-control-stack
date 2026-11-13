import {
  verifyJcWitnessReceipt,
  type VerifyJcWitnessOptions
} from "@agent-control-stack/black-box-recorder";
import {
  EVIDENCE_SCHEMA_VERSION,
  contentHash,
  eventId,
  stageOf,
  type EvidenceEvent
} from "../model.js";

export type WitnessEvidenceOptions = VerifyJcWitnessOptions & {
  now: Date;
  acsAttemptIds?: ReadonlySet<string>;
  acsLeaseIds?: ReadonlySet<string>;
};

export async function witnessReceiptToEvidence(
  rawReceipt: unknown,
  options: WitnessEvidenceOptions
): Promise<EvidenceEvent> {
  const verification = await verifyJcWitnessReceipt(rawReceipt, options);

  if (!verification.valid) {
    const rawObj = typeof rawReceipt === "object" && rawReceipt !== null ? (rawReceipt as Record<string, unknown>) : {};
    const workItemId = typeof rawObj.workItemId === "string" && rawObj.workItemId.length > 0 ? rawObj.workItemId : null;
    const hashPrefix =
      typeof rawObj.evidenceHash === "string" && /^[a-f0-9]{16,64}$/u.test(rawObj.evidenceHash)
        ? rawObj.evidenceHash.slice(0, 16)
        : "invalid";
    const ev: EvidenceEvent = {
      schema_version: EVIDENCE_SCHEMA_VERSION,
      event_id: eventId("witness", `forged.${hashPrefix}`),
      trace_id: null,
      request_id: null,
      work_item_id: workItemId,
      span_id: null,
      parent_span_id: null,
      timestamp: null,
      observed_at: options.now.toISOString(),
      actor: { id: "jc-kernel-witness", type: "system" },
      source: { system: "jc_kernel_witness", component: "kernel-witness", instance: null },
      event_type: "witness.incomplete",
      stage: stageOf("witness.incomplete"),
      decision: null,
      tool_name: null,
      capability_id: null,
      release_sha: null,
      status: "forged_or_tampered",
      evidence_ref: `witness://receipt/${hashPrefix}`,
      integrity: {
        trust: "asserted",
        basis: "jc_kernel_witness_verification_failed",
        hash_verified: false,
        chain: "broken",
        content_hash: ""
      },
      causes: [],
      facts: {
        witness_valid: false,
        witness_reason: verification.reasons.join("; ").slice(0, 180)
      },
      refs: {},
      untrusted: {},
      flags: ["witness_forged_or_tampered"]
    };
    ev.integrity.content_hash = contentHash({ ...ev, observed_at: undefined });
    return ev;
  }

  const r = verification.receipt;
  const attemptMatches = !options.acsAttemptIds || options.acsAttemptIds.has(r.attemptId);
  const leaseMatches = !options.acsLeaseIds || options.acsLeaseIds.has(r.leaseId);
  const fullyObserved = verification.observed && attemptMatches && leaseMatches;
  const eventType = fullyObserved ? "witness.observed" : "witness.incomplete";
  const flags: string[] = [];
  if (!fullyObserved) flags.push("witness_incomplete");
  if (!attemptMatches || !leaseMatches) flags.push("witness_correlation_mismatch");

  const ev: EvidenceEvent = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    event_id: eventId("witness", `${r.workItemId}.${r.attemptId}.${r.evidenceHash.slice(0, 16)}`),
    trace_id: null,
    request_id: null,
    work_item_id: r.workItemId,
    span_id: null,
    parent_span_id: null,
    timestamp: new Date(Math.floor(r.endTimeNs / 1_000_000)).toISOString(),
    observed_at: options.now.toISOString(),
    actor: { id: r.observerId, type: "system" },
    source: { system: "jc_kernel_witness", component: "kernel-witness", instance: r.observerId },
    event_type: eventType,
    stage: stageOf(eventType),
    decision: null,
    tool_name: null,
    capability_id: null,
    release_sha: null,
    status: fullyObserved ? "observed" : r.status,
    evidence_ref: `witness://receipt/${r.evidenceHash}`,
    integrity: {
      trust: fullyObserved ? "observed" : "asserted",
      basis: fullyObserved ? "jc_kernel_witness_ed25519_anchored" : "jc_kernel_witness_incomplete_or_unanchored",
      hash_verified: true,
      chain: fullyObserved ? "verified" : "not_chained",
      content_hash: ""
    },
    causes: [],
    facts: {
      witness_valid: true,
      witness_observed: fullyObserved,
      witness_mode: r.observerMode,
      witness_status: r.status,
      witness_attempt_id: r.attemptId,
      witness_lease_id: r.leaseId,
      witness_invocation_hash: r.invocationHash,
      witness_evidence_hash: r.evidenceHash,
      witness_cgroup_id: r.cgroupId,
      witness_dropped_events: r.droppedEvents,
      witness_sequence_gaps: r.sequenceGaps
    },
    refs: {
      attempt_id: r.attemptId,
      lease_id: r.leaseId,
      ...(r.acsAnchorRef ? { acs_anchor_ref: r.acsAnchorRef } : {})
    },
    untrusted: {},
    flags
  };
  ev.integrity.content_hash = contentHash({ ...ev, observed_at: undefined });
  return ev;
}
