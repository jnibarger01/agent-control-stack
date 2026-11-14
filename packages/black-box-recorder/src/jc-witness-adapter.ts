import { canonicalJson, sha256Hex } from "./canonical.js";
import type { ObserverKeyRegistry } from "./key-lifecycle.js";
import { importTrustedKey } from "./provenance.js";
import type { RecorderStore } from "./store.js";
import type { IngestDraft, IngestResult, TrustLevel } from "./types.js";

export const JC_KERNEL_WITNESS_SCHEMA_VERSION_V1 = "jc.kernel-witness.receipt.v1" as const;
export const JC_KERNEL_WITNESS_SCHEMA_VERSION_V2 = "jc.kernel-witness.receipt.v2" as const;
export const JC_KERNEL_WITNESS_SCHEMA_VERSION = JC_KERNEL_WITNESS_SCHEMA_VERSION_V1;

export type JcWitnessCategory = "process" | "filesystem" | "network";

export type JcWitnessKernelEvent = {
  seq: number;
  timestampNs: number;
  cgroupId: number;
  eventType: "FORK" | "EXEC" | "EXIT";
  pid: number;
  tgid: number;
  ppid: number;
  childPid: number;
  childTgid: number;
  uid: number;
  gid: number;
  exitCode: number;
  comm: string;
};

export type JcWitnessProcessNode = {
  pid: number;
  tgid: number;
  ppid: number;
  comm: string;
  uid: number;
  gid: number;
  forkedAtNs: number;
  execedAtNs: number;
  exitedAtNs: number;
  exitCode: number;
  children: JcWitnessProcessNode[];
};

export type JcWitnessFilesystemOp =
  | "CREATE"
  | "MODIFY"
  | "DELETE"
  | "RENAME"
  | "TRUNCATE"
  | "MKDIR"
  | "RMDIR"
  | "OPENAT"
  | "MMAP_WRITE"
  | "IO_URING";

export type JcWitnessFilesystemEvent = {
  seq: number;
  timestampNs: number;
  cgroupId: number;
  pid: number;
  tgid: number;
  comm: string;
  uid: number;
  gid: number;
  op: JcWitnessFilesystemOp;
  phase: "attempted" | "completed";
  succeeded: boolean;
  resultErrno: number;
  bytes: number;
  flags: number;
  dev: number;
  inode: number;
  mountId: number;
  pathDigest: string;
  pathDigestKeyId: string;
  displayPath: string | null;
  targetPathDigest: string | null;
  targetDisplayPath: string | null;
  targetInode: number;
};

export type JcWitnessNetworkOutcome =
  | "attempted"
  | "connected"
  | "refused"
  | "timed_out"
  | "unreachable"
  | "in_progress"
  | "failed"
  | "incomplete";

export type JcWitnessNetworkEvent = {
  seq: number;
  timestampNs: number;
  cgroupId: number;
  pid: number;
  tgid: number;
  comm: string;
  sockCookie: number;
  af: "INET" | "INET6";
  proto: "TCP" | "UDP";
  op: "CONNECT" | "SENDMSG" | "STATE_CHANGE";
  phase: "attempted" | "completed" | "state_change";
  stateTransition: string | null;
  outcome: JcWitnessNetworkOutcome;
  errnoVal: number;
  remoteAddrDigest: string;
  displayRemoteAddr: string | null;
  remotePort: number;
  localPort: number;
  bytes: number;
};

export type JcWitnessObservationScope = {
  policyRequired: JcWitnessCategory[];
  requested: JcWitnessCategory[];
  active: JcWitnessCategory[];
};

export type JcWitnessCategoryStatus = {
  category: JcWitnessCategory;
  enabled: boolean;
  status: "complete" | "partial" | "incomplete" | "unsupported" | "failed";
  eventCount: number;
  droppedEvents: number;
  sequenceGaps: number;
  firstSeq: number | null;
  lastSeq: number | null;
  categoryDigestSha256: string;
  incompleteReasons: string[];
  unsupportedOperations: string[];
};

export type JcWitnessCategoryCompletenessMap = {
  process: JcWitnessCategoryStatus;
  filesystem: JcWitnessCategoryStatus;
  network: JcWitnessCategoryStatus;
};

export type JcKernelWitnessReceiptV1 = {
  schemaVersion: typeof JC_KERNEL_WITNESS_SCHEMA_VERSION_V1;
  observerVersion: string;
  observerMode: "live" | "synthetic" | "replay";
  observerId: string;
  workItemId: string;
  attemptId: string;
  leaseId: string;
  invocationHash: string;
  cgroupId: number;
  cgroupPath: string;
  rootPid?: number;
  startTimeNs: number;
  endTimeNs: number;
  status: "complete" | "incomplete" | "failed";
  incompleteReasons: string[];
  events: JcWitnessKernelEvent[];
  processTree: JcWitnessProcessNode[];
  eventCounts: { total: number; fork: number; exec: number; exit: number };
  droppedEvents: number;
  sequenceGaps: number;
  previousEvidenceHash: string | null;
  acsAnchorRef: string | null;
  signingKeyId: string;
  evidenceHash: string;
  signature: string;
};

export type JcKernelWitnessReceiptV2 = {
  schemaVersion: typeof JC_KERNEL_WITNESS_SCHEMA_VERSION_V2;
  observerVersion: string;
  observerMode: "live" | "synthetic" | "replay";
  observerId: string;
  workItemId: string;
  attemptId: string;
  leaseId: string;
  invocationHash: string;
  cgroupId: number;
  cgroupPath: string;
  rootPid?: number;
  startTimeNs: number;
  endTimeNs: number;
  signedAtUtc: string;
  status: "complete" | "incomplete" | "failed";
  incompleteReasons: string[];
  events: JcWitnessKernelEvent[];
  processTree: JcWitnessProcessNode[];
  eventCounts: {
    total: number;
    fork: number;
    exec: number;
    exit: number;
    filesystem: number;
    network: number;
  };
  observationScope: JcWitnessObservationScope;
  categoryCompleteness: JcWitnessCategoryCompletenessMap;
  filesystemEvents: JcWitnessFilesystemEvent[];
  networkEvents: JcWitnessNetworkEvent[];
  droppedEvents: number;
  sequenceGaps: number;
  previousEvidenceHash: string | null;
  acsAnchorRef: string | null;
  signingKeyId: string;
  evidenceHash: string;
  signature: string;
};

export type JcKernelWitnessReceipt = JcKernelWitnessReceiptV1 | JcKernelWitnessReceiptV2;

export type VerifyJcWitnessOptions = {
  trustedWitnessKeys?: Record<string, string>;
  keyRegistry?: ObserverKeyRegistry;
  allowRotatedHistorical?: boolean;
  receiptTimestampIso?: string;
  ingestedAt?: string;
  expectedPreviousEvidenceHash?: string | null;
  seenEvidenceHashes?: Set<string>;
  requireAcsAnchor?: boolean;
  acsAnchorVerified?: boolean;
  requireLiveMode?: boolean;
  requiredCategories?: readonly JcWitnessCategory[];
};

export type WitnessVerificationResult =
  | {
      valid: true;
      observed: boolean;
      trustLevel: "independently_verified" | "untrusted_claim";
      reasons: string[];
      receipt: JcKernelWitnessReceipt;
    }
  | {
      valid: false;
      observed: false;
      trustLevel: "untrusted_claim";
      reasons: string[];
    };

export type WitnessIngestResult = {
  accepted: boolean;
  observed: boolean;
  trustLevel: TrustLevel;
  reason?: string;
  reasons: string[];
  ingestResult?: IngestResult;
};

const SHA256_RE = /^[a-f0-9]{64}$/u;
const YEAR_2000_NS = 946_684_800_000_000_000;
const WITNESS_CATEGORIES: ReadonlySet<string> = new Set(["process", "filesystem", "network"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function hasCommonReceiptFields(value: Record<string, unknown>): boolean {
  if (!isNonEmptyString(value.observerVersion) || !isNonEmptyString(value.observerId)) return false;
  if (value.observerMode !== "live" && value.observerMode !== "synthetic" && value.observerMode !== "replay") {
    return false;
  }
  if (
    !isNonEmptyString(value.workItemId) ||
    !isNonEmptyString(value.attemptId) ||
    !isNonEmptyString(value.leaseId) ||
    !isNonEmptyString(value.invocationHash)
  ) {
    return false;
  }
  if (typeof value.cgroupId !== "number" || !Number.isFinite(value.cgroupId) || !isNonEmptyString(value.cgroupPath)) {
    return false;
  }
  if (typeof value.startTimeNs !== "number" || typeof value.endTimeNs !== "number") return false;
  if (value.status !== "complete" && value.status !== "incomplete" && value.status !== "failed") return false;
  if (!Array.isArray(value.incompleteReasons) || !Array.isArray(value.events) || !Array.isArray(value.processTree)) {
    return false;
  }
  if (!isRecord(value.eventCounts)) return false;
  if (typeof value.droppedEvents !== "number" || typeof value.sequenceGaps !== "number") return false;
  if (value.previousEvidenceHash !== null && !isNonEmptyString(value.previousEvidenceHash)) return false;
  if (value.acsAnchorRef !== null && !isNonEmptyString(value.acsAnchorRef)) return false;
  if (!isNonEmptyString(value.signingKeyId) || typeof value.evidenceHash !== "string" || !SHA256_RE.test(value.evidenceHash)) {
    return false;
  }
  if (!isNonEmptyString(value.signature)) return false;
  return true;
}

export function isJcKernelWitnessReceiptV1(value: unknown): value is JcKernelWitnessReceiptV1 {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== JC_KERNEL_WITNESS_SCHEMA_VERSION_V1) return false;
  return hasCommonReceiptFields(value);
}

function isValidCategoryStatus(value: unknown, expectedCategory: JcWitnessCategory): value is JcWitnessCategoryStatus {
  if (!isRecord(value)) return false;
  if (value.category !== expectedCategory) return false;
  if (typeof value.enabled !== "boolean") return false;
  if (
    value.status !== "complete" &&
    value.status !== "partial" &&
    value.status !== "incomplete" &&
    value.status !== "unsupported" &&
    value.status !== "failed"
  ) {
    return false;
  }
  if (
    typeof value.eventCount !== "number" ||
    typeof value.droppedEvents !== "number" ||
    typeof value.sequenceGaps !== "number"
  ) {
    return false;
  }
  if (value.firstSeq !== null && typeof value.firstSeq !== "number") return false;
  if (value.lastSeq !== null && typeof value.lastSeq !== "number") return false;
  if (typeof value.categoryDigestSha256 !== "string" || !SHA256_RE.test(value.categoryDigestSha256)) return false;
  if (!Array.isArray(value.incompleteReasons) || !Array.isArray(value.unsupportedOperations)) return false;
  return true;
}

export function isJcKernelWitnessReceiptV2(value: unknown): value is JcKernelWitnessReceiptV2 {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== JC_KERNEL_WITNESS_SCHEMA_VERSION_V2) return false;
  if (!hasCommonReceiptFields(value)) return false;
  if (!isNonEmptyString(value.signedAtUtc) || Number.isNaN(Date.parse(value.signedAtUtc))) return false;
  if (!isRecord(value.observationScope)) return false;
  const scope = value.observationScope;
  if (
    !Array.isArray(scope.policyRequired) ||
    !Array.isArray(scope.requested) ||
    !Array.isArray(scope.active) ||
    !scope.policyRequired.every((c) => typeof c === "string" && WITNESS_CATEGORIES.has(c)) ||
    !scope.requested.every((c) => typeof c === "string" && WITNESS_CATEGORIES.has(c)) ||
    !scope.active.every((c) => typeof c === "string" && WITNESS_CATEGORIES.has(c))
  ) {
    return false;
  }
  if (!isRecord(value.categoryCompleteness)) return false;
  const cc = value.categoryCompleteness;
  if (
    !isValidCategoryStatus(cc.process, "process") ||
    !isValidCategoryStatus(cc.filesystem, "filesystem") ||
    !isValidCategoryStatus(cc.network, "network")
  ) {
    return false;
  }
  if (!Array.isArray(value.filesystemEvents) || !Array.isArray(value.networkEvents)) return false;
  return true;
}

export function isJcKernelWitnessReceipt(value: unknown): value is JcKernelWitnessReceipt {
  return isJcKernelWitnessReceiptV1(value) || isJcKernelWitnessReceiptV2(value);
}

export type JcKernelWitnessReceiptBody =
  | JcKernelWitnessReceipt
  | Omit<JcKernelWitnessReceiptV1, "evidenceHash" | "signature">
  | Omit<JcKernelWitnessReceiptV2, "evidenceHash" | "signature">;

export function witnessCanonicalBody(receipt: JcKernelWitnessReceiptBody): string {
  const body = { ...receipt } as Record<string, unknown>;
  delete body.evidenceHash;
  delete body.signature;
  return canonicalJson(body);
}

export async function computeV2CategoryDigests(receipt: {
  processTree: readonly JcWitnessProcessNode[];
  filesystemEvents: readonly JcWitnessFilesystemEvent[];
  networkEvents: readonly JcWitnessNetworkEvent[];
}): Promise<{ process: string; filesystem: string; network: string }> {
  const [process, filesystem, network] = await Promise.all([
    sha256Hex(`jc.kernel-witness.category.process.v2:${canonicalJson(receipt.processTree)}`),
    sha256Hex(`jc.kernel-witness.category.filesystem.v2:${canonicalJson(receipt.filesystemEvents)}`),
    sha256Hex(`jc.kernel-witness.category.network.v2:${canonicalJson(receipt.networkEvents)}`)
  ]);
  return { process, filesystem, network };
}

export async function computeWitnessEvidenceHash(receipt: JcKernelWitnessReceiptBody): Promise<string> {
  const canonicalBody = witnessCanonicalBody(receipt);
  if (receipt.schemaVersion === JC_KERNEL_WITNESS_SCHEMA_VERSION_V2) {
    return sha256Hex(`jc.kernel-witness.receipt.v2:${canonicalBody}`);
  }
  return sha256Hex(canonicalBody);
}

export function witnessSigningPayload(
  receipt: JcKernelWitnessReceiptBody & { evidenceHash: string },
  canonicalBody?: string
): string {
  const body = canonicalBody ?? witnessCanonicalBody(receipt);
  if (receipt.schemaVersion === JC_KERNEL_WITNESS_SCHEMA_VERSION_V2) {
    return `jc.kernel-witness.sig.v2:${receipt.evidenceHash}:${body}`;
  }
  return body;
}

export function resolveReceiptWallClockTimestamp(
  receipt: JcKernelWitnessReceipt,
  options?: { receiptTimestampIso?: string; ingestedAt?: string }
): string | undefined {
  if (receipt.schemaVersion === JC_KERNEL_WITNESS_SCHEMA_VERSION_V2) {
    return receipt.signedAtUtc;
  }
  if (options?.receiptTimestampIso) {
    return options.receiptTimestampIso;
  }
  // Only convert endTimeNs when it represents wall-clock epoch nanoseconds (>= year 2000).
  // Monotonic bpf_ktime_get_ns() values since boot must never be interpreted as 1970 wall-clock dates.
  if (receipt.endTimeNs >= YEAR_2000_NS) {
    return new Date(Math.floor(receipt.endTimeNs / 1_000_000)).toISOString();
  }
  return options?.ingestedAt;
}

export async function verifyJcWitnessReceipt(
  rawReceipt: unknown,
  options: VerifyJcWitnessOptions
): Promise<WitnessVerificationResult> {
  if (!isJcKernelWitnessReceipt(rawReceipt)) {
    return {
      valid: false,
      observed: false,
      trustLevel: "untrusted_claim",
      reasons: ["invalid jc.kernel-witness.receipt schema or missing correlation IDs"]
    };
  }

  const receipt = rawReceipt;
  const canonicalBody = witnessCanonicalBody(receipt);
  const recomputedHash = await computeWitnessEvidenceHash(receipt);
  if (recomputedHash !== receipt.evidenceHash) {
    return {
      valid: false,
      observed: false,
      trustLevel: "untrusted_claim",
      reasons: ["evidenceHash mismatch (tampered receipt)"]
    };
  }

  if (receipt.schemaVersion === JC_KERNEL_WITNESS_SCHEMA_VERSION_V2) {
    const digests = await computeV2CategoryDigests(receipt);
    if (
      receipt.categoryCompleteness.process.categoryDigestSha256 !== digests.process ||
      receipt.categoryCompleteness.filesystem.categoryDigestSha256 !== digests.filesystem ||
      receipt.categoryCompleteness.network.categoryDigestSha256 !== digests.network
    ) {
      return {
        valid: false,
        observed: false,
        trustLevel: "untrusted_claim",
        reasons: ["categoryDigestSha256 mismatch (tampered category events)"]
      };
    }
  }

  let keyPem: string | undefined;
  if (options.keyRegistry) {
    const receiptTs = resolveReceiptWallClockTimestamp(receipt, options);
    const evalRes = options.keyRegistry.evaluateKey(receipt.signingKeyId, {
      allowRotatedHistorical: options.allowRotatedHistorical,
      receiptTimestampIso: receiptTs
    });
    if (!evalRes.allowed) {
      return {
        valid: false,
        observed: false,
        trustLevel: "untrusted_claim",
        reasons: [evalRes.reason]
      };
    }
    keyPem = evalRes.record.publicKeyPem;
  } else {
    keyPem = options.trustedWitnessKeys?.[receipt.signingKeyId];
  }

  if (!keyPem) {
    return {
      valid: false,
      observed: false,
      trustLevel: "untrusted_claim",
      reasons: [`untrusted or unknown signingKeyId '${receipt.signingKeyId}'`]
    };
  }

  let sigValid = false;
  try {
    const key = await importTrustedKey(keyPem);
    const sigPayload = witnessSigningPayload(receipt, canonicalBody);
    sigValid = await crypto.subtle.verify(
      "Ed25519",
      key,
      base64ToBytes(receipt.signature) as BufferSource,
      new TextEncoder().encode(sigPayload) as BufferSource
    );
  } catch {
    sigValid = false;
  }
  if (!sigValid) {
    return {
      valid: false,
      observed: false,
      trustLevel: "untrusted_claim",
      reasons: ["invalid Ed25519 signature"]
    };
  }

  if (options.seenEvidenceHashes?.has(receipt.evidenceHash)) {
    return {
      valid: false,
      observed: false,
      trustLevel: "untrusted_claim",
      reasons: ["replayed witness receipt (duplicate evidenceHash)"]
    };
  }

  if (
    options.expectedPreviousEvidenceHash !== undefined &&
    receipt.previousEvidenceHash !== options.expectedPreviousEvidenceHash
  ) {
    return {
      valid: false,
      observed: false,
      trustLevel: "untrusted_claim",
      reasons: ["previousEvidenceHash chain mismatch"]
    };
  }

  const downgradeReasons: string[] = [];
  if (receipt.status !== "complete") {
    downgradeReasons.push(`receipt status is '${receipt.status}'`);
  }
  if (receipt.droppedEvents > 0) {
    downgradeReasons.push(`droppedEvents=${receipt.droppedEvents}`);
  }
  if (receipt.sequenceGaps > 0) {
    downgradeReasons.push(`sequenceGaps=${receipt.sequenceGaps}`);
  }
  if (receipt.incompleteReasons.length > 0) {
    downgradeReasons.push(`incompleteReasons: ${receipt.incompleteReasons.join(",")}`);
  }
  if (options.requireLiveMode && receipt.observerMode !== "live") {
    downgradeReasons.push(`observerMode '${receipt.observerMode}' is not live`);
  }

  if (receipt.schemaVersion === JC_KERNEL_WITNESS_SCHEMA_VERSION_V2) {
    const requiredCategories = options.requiredCategories ?? receipt.observationScope.policyRequired;
    for (const cat of requiredCategories) {
      if (!receipt.observationScope.active.includes(cat)) {
        downgradeReasons.push(`required category '${cat}' is not active in observationScope`);
      }
      const catStatus = receipt.categoryCompleteness[cat];
      if (!catStatus.enabled || catStatus.status !== "complete") {
        downgradeReasons.push(`category '${cat}' status is '${catStatus.status}'`);
      }
      if (catStatus.droppedEvents > 0) {
        downgradeReasons.push(`category '${cat}' droppedEvents=${catStatus.droppedEvents}`);
      }
      if (catStatus.sequenceGaps > 0) {
        downgradeReasons.push(`category '${cat}' sequenceGaps=${catStatus.sequenceGaps}`);
      }
      if (catStatus.unsupportedOperations.length > 0) {
        downgradeReasons.push(`category '${cat}' unsupportedOperations=${catStatus.unsupportedOperations.join(",")}`);
      }
    }
  } else if (options.requiredCategories && options.requiredCategories.some((c) => c !== "process")) {
    downgradeReasons.push(
      `v1 receipt only covers 'process'; policy requires: ${options.requiredCategories.join(",")}`
    );
  }

  const requireAnchor = options.requireAcsAnchor ?? true;
  const anchorVerified = options.acsAnchorVerified ?? true;
  if (requireAnchor && (!receipt.acsAnchorRef || receipt.acsAnchorRef.length === 0 || !anchorVerified)) {
    downgradeReasons.push(
      !anchorVerified
        ? "acsAnchorRef does not resolve to an existing ACS work item/mission"
        : "missing acsAnchorRef (unanchored observation)"
    );
  }

  const observed = downgradeReasons.length === 0;
  return {
    valid: true,
    observed,
    trustLevel: observed ? "independently_verified" : "untrusted_claim",
    reasons: downgradeReasons,
    receipt
  };
}

export function toWitnessRecorderDraft(
  receipt: JcKernelWitnessReceipt,
  verification: Extract<WitnessVerificationResult, { valid: true }>,
  ingestedAt: string
): IngestDraft {
  const sourceTimestamp = resolveReceiptWallClockTimestamp(receipt) ?? null;
  const v2Metadata =
    receipt.schemaVersion === JC_KERNEL_WITNESS_SCHEMA_VERSION_V2
      ? {
          signedAtUtc: receipt.signedAtUtc,
          observationScope: receipt.observationScope,
          categoryCompleteness: receipt.categoryCompleteness,
          filesystemEventCount: receipt.filesystemEvents.length,
          networkEventCount: receipt.networkEvents.length
        }
      : {};
  return {
    component: "jc-kernel-witness",
    instanceId: receipt.observerId,
    releaseId: receipt.observerVersion,
    identityRef: receipt.signingKeyId,
    producerEventId: `${receipt.workItemId}:${receipt.attemptId}:${receipt.evidenceHash}`,
    eventType: verification.observed ? "witness.observation.verified" : "witness.observation.incomplete",
    runId: receipt.workItemId,
    missionId: receipt.workItemId,
    correlationId: receipt.attemptId,
    parentEventId: null,
    sourceTimestamp,
    ingestedAt,
    trustLevel: verification.trustLevel,
    sourceRecordRef: receipt.acsAnchorRef,
    metadata: {
      schemaVersion: receipt.schemaVersion,
      workItemId: receipt.workItemId,
      attemptId: receipt.attemptId,
      leaseId: receipt.leaseId,
      invocationHash: receipt.invocationHash,
      observerId: receipt.observerId,
      observerMode: receipt.observerMode,
      cgroupId: receipt.cgroupId,
      cgroupPath: receipt.cgroupPath,
      startTimeNs: receipt.startTimeNs,
      endTimeNs: receipt.endTimeNs,
      status: receipt.status,
      incompleteReasons: receipt.incompleteReasons,
      eventCounts: receipt.eventCounts,
      droppedEvents: receipt.droppedEvents,
      sequenceGaps: receipt.sequenceGaps,
      evidenceHash: receipt.evidenceHash,
      previousEvidenceHash: receipt.previousEvidenceHash,
      acsAnchorRef: receipt.acsAnchorRef,
      signingKeyId: receipt.signingKeyId,
      processTreeCount: receipt.processTree.length,
      observed: verification.observed,
      ...v2Metadata
    }
  };
}

export async function ingestJcWitnessReceipt(
  store: RecorderStore,
  rawReceipt: unknown,
  options: VerifyJcWitnessOptions & { ingestedAt?: string }
): Promise<WitnessIngestResult> {
  return store.ingestWitnessReceipt(rawReceipt, options);
}
