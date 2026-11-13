import { canonicalJson, sha256Hex } from "./canonical.js";
import type { ObserverKeyRegistry } from "./key-lifecycle.js";
import { importTrustedKey } from "./provenance.js";
import type { RecorderStore } from "./store.js";
import type { IngestDraft, IngestResult, TrustLevel } from "./types.js";

export const JC_KERNEL_WITNESS_SCHEMA_VERSION = "jc.kernel-witness.receipt.v1" as const;

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

export type JcKernelWitnessReceiptV1 = {
  schemaVersion: typeof JC_KERNEL_WITNESS_SCHEMA_VERSION;
  observerVersion: string;
  observerMode: "live" | "synthetic" | "replay";
  observerId: string;
  workItemId: string;
  attemptId: string;
  leaseId: string;
  invocationHash: string;
  cgroupId: number;
  cgroupPath: string;
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

export type VerifyJcWitnessOptions = {
  trustedWitnessKeys?: Record<string, string>;
  keyRegistry?: ObserverKeyRegistry;
  allowRotatedHistorical?: boolean;
  expectedPreviousEvidenceHash?: string | null;
  seenEvidenceHashes?: Set<string>;
  requireAcsAnchor?: boolean;
  acsAnchorVerified?: boolean;
  requireLiveMode?: boolean;
};

export type WitnessVerificationResult =
  | {
      valid: true;
      observed: boolean;
      trustLevel: "independently_verified" | "untrusted_claim";
      reasons: string[];
      receipt: JcKernelWitnessReceiptV1;
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

export function isJcKernelWitnessReceiptV1(value: unknown): value is JcKernelWitnessReceiptV1 {
  if (!isRecord(value)) return false;
  if (value.schemaVersion !== JC_KERNEL_WITNESS_SCHEMA_VERSION) return false;
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

export function witnessCanonicalBody(receipt: JcKernelWitnessReceiptV1): string {
  const body = { ...receipt } as Record<string, unknown>;
  delete body.evidenceHash;
  delete body.signature;
  return canonicalJson(body);
}

export async function verifyJcWitnessReceipt(
  rawReceipt: unknown,
  options: VerifyJcWitnessOptions
): Promise<WitnessVerificationResult> {
  if (!isJcKernelWitnessReceiptV1(rawReceipt)) {
    return {
      valid: false,
      observed: false,
      trustLevel: "untrusted_claim",
      reasons: ["invalid jc.kernel-witness.receipt.v1 schema or missing correlation IDs"]
    };
  }

  const receipt = rawReceipt;
  const canonicalBody = witnessCanonicalBody(receipt);
  const recomputedHash = await sha256Hex(canonicalBody);
  if (recomputedHash !== receipt.evidenceHash) {
    return {
      valid: false,
      observed: false,
      trustLevel: "untrusted_claim",
      reasons: ["evidenceHash mismatch (tampered receipt)"]
    };
  }

  let keyPem: string | undefined;
  if (options.keyRegistry) {
    const receiptTs = new Date(Math.floor(receipt.endTimeNs / 1_000_000)).toISOString();
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
    sigValid = await crypto.subtle.verify(
      "Ed25519",
      key,
      base64ToBytes(receipt.signature) as BufferSource,
      new TextEncoder().encode(canonicalBody) as BufferSource
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
  receipt: JcKernelWitnessReceiptV1,
  verification: Extract<WitnessVerificationResult, { valid: true }>,
  ingestedAt: string
): IngestDraft {
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
    sourceTimestamp: new Date(Math.floor(receipt.endTimeNs / 1_000_000)).toISOString(),
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
      observed: verification.observed
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
