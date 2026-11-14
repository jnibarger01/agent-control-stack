import {
  isJcKernelWitnessReceiptV2,
  verifyJcWitnessReceipt,
  type JcWitnessCategory,
  type VerifyJcWitnessOptions
} from "@agent-control-stack/black-box-recorder";
import {
  EVIDENCE_SCHEMA_VERSION,
  contentHash,
  eventId,
  stageOf,
  type EvidenceEvent
} from "../model.js";

const MIN_WALLCLOCK_NS = 946_684_800_000_000_000;

export type WitnessEvidenceOptions = VerifyJcWitnessOptions & {
  now: Date;
  acsAttemptIds?: ReadonlySet<string>;
  acsLeaseIds?: ReadonlySet<string>;
  requiredWitnessScope?: readonly JcWitnessCategory[];
};

export async function witnessReceiptToEvidence(
  rawReceipt: unknown,
  options: WitnessEvidenceOptions
): Promise<EvidenceEvent> {
  const verification = await verifyJcWitnessReceipt(rawReceipt, {
    ...options,
    requiredCategories:
      options.requiredWitnessScope ?? options.requiredCategories
  });

  if (!verification.valid) {
    const rawObj =
      typeof rawReceipt === "object" && rawReceipt !== null
        ? (rawReceipt as Record<string, unknown>)
        : {};
    const workItemId =
      typeof rawObj.workItemId === "string" && rawObj.workItemId.length > 0
        ? rawObj.workItemId
        : null;
    const hashPrefix =
      typeof rawObj.evidenceHash === "string" &&
      /^[a-f0-9]{16,64}$/u.test(rawObj.evidenceHash)
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
      source: {
        system: "jc_kernel_witness",
        component: "kernel-witness",
        instance: null
      },
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
  const attemptMatches =
    !options.acsAttemptIds || options.acsAttemptIds.has(r.attemptId);
  const leaseMatches =
    !options.acsLeaseIds || options.acsLeaseIds.has(r.leaseId);

  const isV2 = isJcKernelWitnessReceiptV2(r);
  const activeScope: readonly JcWitnessCategory[] = isV2
    ? r.observationScope.active
    : ["process"];
  const policyRequiredScope: readonly JcWitnessCategory[] = isV2
    ? r.observationScope.policyRequired
    : ["process"];
  const effectiveRequired =
    options.requiredWitnessScope ??
    options.requiredCategories ??
    policyRequiredScope;

  const processStatus = isV2
    ? r.categoryCompleteness.process.status
    : r.status === "complete"
      ? "complete"
      : "incomplete";
  const fsStatus = isV2
    ? r.categoryCompleteness.filesystem.status
    : "unsupported";
  const netStatus = isV2
    ? r.categoryCompleteness.network.status
    : "unsupported";

  const scopeInsufficient = effectiveRequired.some(
    (cat) => !activeScope.includes(cat)
  );
  const fsIncomplete =
    (effectiveRequired.includes("filesystem") ||
      activeScope.includes("filesystem")) &&
    fsStatus !== "complete";
  const netIncomplete =
    (effectiveRequired.includes("network") ||
      activeScope.includes("network")) &&
    netStatus !== "complete";

  const fullyObserved =
    verification.observed &&
    attemptMatches &&
    leaseMatches &&
    !scopeInsufficient &&
    !fsIncomplete &&
    !netIncomplete;

  const eventType = fullyObserved ? "witness.observed" : "witness.incomplete";
  const flags: string[] = [];
  if (!fullyObserved) flags.push("witness_incomplete");
  if (!attemptMatches || !leaseMatches) {
    flags.push("witness_correlation_mismatch");
  }
  if (scopeInsufficient) flags.push("witness_scope_insufficient");
  if (fsIncomplete) flags.push("witness_filesystem_incomplete");
  if (netIncomplete) flags.push("witness_network_incomplete");

  const timestampIso =
    isV2 && typeof r.signedAtUtc === "string"
      ? r.signedAtUtc
      : r.endTimeNs >= MIN_WALLCLOCK_NS
        ? new Date(Math.floor(r.endTimeNs / 1_000_000)).toISOString()
        : options.now.toISOString();

  const rootNode = r.processTree[0] ?? null;
  const rootExitCode =
    rootNode && typeof rootNode.exitCode === "number"
      ? rootNode.exitCode
      : null;

  const ev: EvidenceEvent = {
    schema_version: EVIDENCE_SCHEMA_VERSION,
    event_id: eventId(
      "witness",
      `${r.workItemId}.${r.attemptId}.${r.evidenceHash.slice(0, 16)}`
    ),
    trace_id: null,
    request_id: null,
    work_item_id: r.workItemId,
    span_id: null,
    parent_span_id: null,
    timestamp: timestampIso,
    observed_at: options.now.toISOString(),
    actor: { id: r.observerId, type: "system" },
    source: {
      system: "jc_kernel_witness",
      component: "kernel-witness",
      instance: r.observerId
    },
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
      basis: fullyObserved
        ? "jc_kernel_witness_ed25519_anchored"
        : "jc_kernel_witness_incomplete_or_unanchored",
      hash_verified: true,
      chain: fullyObserved ? "verified" : "not_chained",
      content_hash: ""
    },
    causes: [],
    facts: {
      witness_valid: true,
      witness_observed: fullyObserved,
      witness_schema_version: r.schemaVersion,
      witness_mode: r.observerMode,
      witness_status: r.status,
      witness_attempt_id: r.attemptId,
      witness_lease_id: r.leaseId,
      witness_invocation_hash: r.invocationHash,
      witness_evidence_hash: r.evidenceHash,
      witness_cgroup_id: r.cgroupId,
      witness_dropped_events: r.droppedEvents,
      witness_sequence_gaps: r.sequenceGaps,
      witness_root_exit_code: rootExitCode,
      witness_scope_active: activeScope.join(","),
      witness_scope_required: effectiveRequired.join(","),
      witness_process_status: processStatus,
      witness_fs_status: fsStatus,
      witness_net_status: netStatus,
      witness_fs_events: isV2 ? r.filesystemEvents.length : 0,
      witness_net_events: isV2 ? r.networkEvents.length : 0,
      witness_fs_dropped: isV2
        ? r.categoryCompleteness.filesystem.droppedEvents
        : 0,
      witness_net_dropped: isV2
        ? r.categoryCompleteness.network.droppedEvents
        : 0
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

export async function witnessReceiptToCategoryEvidence(
  rawReceipt: unknown,
  options: WitnessEvidenceOptions
): Promise<EvidenceEvent[]> {
  const main = await witnessReceiptToEvidence(rawReceipt, options);
  const out: EvidenceEvent[] = [main];
  if (main.event_type !== "witness.observed") return out;

  const verification = await verifyJcWitnessReceipt(rawReceipt, options);
  if (!verification.valid || !isJcKernelWitnessReceiptV2(verification.receipt)) {
    return out;
  }

  const r = verification.receipt;
  for (const fsEv of r.filesystemEvents.slice(0, 50)) {
    const ev: EvidenceEvent = {
      schema_version: EVIDENCE_SCHEMA_VERSION,
      event_id: eventId(
        "witness",
        `fs.${r.evidenceHash.slice(0, 12)}.${fsEv.seq}`
      ),
      trace_id: null,
      request_id: null,
      work_item_id: r.workItemId,
      span_id: null,
      parent_span_id: null,
      timestamp: main.timestamp,
      observed_at: options.now.toISOString(),
      actor: { id: r.observerId, type: "system" },
      source: {
        system: "jc_kernel_witness",
        component: "kernel-witness",
        instance: r.observerId
      },
      event_type: "witness.fs.observed",
      stage: stageOf("witness.fs.observed"),
      decision: null,
      tool_name: null,
      capability_id: null,
      release_sha: null,
      status: fsEv.resultErrno === 0 ? "ok" : "error",
      evidence_ref: `witness://receipt/${r.evidenceHash}#fs-${fsEv.seq}`,
      integrity: {
        trust: "observed",
        basis: "jc_kernel_witness_ed25519_anchored",
        hash_verified: true,
        chain: "verified",
        content_hash: ""
      },
      causes: [main.event_id],
      facts: {
        fs_seq: fsEv.seq,
        fs_op: fsEv.op,
        fs_pid: fsEv.pid,
        fs_path_hash: fsEv.pathDigest,
        fs_result: fsEv.resultErrno
      },
      refs: {
        attempt_id: r.attemptId,
        lease_id: r.leaseId
      },
      untrusted: {
        path: (fsEv.displayPath ?? "").slice(0, 200),
        ...(fsEv.targetDisplayPath
          ? { targetPath: fsEv.targetDisplayPath.slice(0, 200) }
          : {})
      },
      flags: []
    };
    ev.integrity.content_hash = contentHash({ ...ev, observed_at: undefined });
    out.push(ev);
  }

  for (const netEv of r.networkEvents.slice(0, 50)) {
    const ev: EvidenceEvent = {
      schema_version: EVIDENCE_SCHEMA_VERSION,
      event_id: eventId(
        "witness",
        `net.${r.evidenceHash.slice(0, 12)}.${netEv.seq}`
      ),
      trace_id: null,
      request_id: null,
      work_item_id: r.workItemId,
      span_id: null,
      parent_span_id: null,
      timestamp: main.timestamp,
      observed_at: options.now.toISOString(),
      actor: { id: r.observerId, type: "system" },
      source: {
        system: "jc_kernel_witness",
        component: "kernel-witness",
        instance: r.observerId
      },
      event_type: "witness.net.observed",
      stage: stageOf("witness.net.observed"),
      decision: null,
      tool_name: null,
      capability_id: null,
      release_sha: null,
      status: netEv.errnoVal === 0 ? "ok" : "error",
      evidence_ref: `witness://receipt/${r.evidenceHash}#net-${netEv.seq}`,
      integrity: {
        trust: "observed",
        basis: "jc_kernel_witness_ed25519_anchored",
        hash_verified: true,
        chain: "verified",
        content_hash: ""
      },
      causes: [main.event_id],
      facts: {
        net_seq: netEv.seq,
        net_op: netEv.op,
        net_pid: netEv.pid,
        net_family: netEv.af,
        net_proto: netEv.proto,
        net_remote_addr: (
          netEv.displayRemoteAddr ?? netEv.remoteAddrDigest
        ).slice(0, 120),
        net_remote_port: netEv.remotePort,
        net_bytes: netEv.bytes,
        net_result: netEv.errnoVal
      },
      refs: {
        attempt_id: r.attemptId,
        lease_id: r.leaseId
      },
      untrusted: {},
      flags: []
    };
    ev.integrity.content_hash = contentHash({ ...ev, observed_at: undefined });
    out.push(ev);
  }

  return out;
}
