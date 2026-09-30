import { createHash } from "node:crypto";
import { strictCanonicalJsonV1 } from "@agent-control-stack/shared";
import { APPROVAL_BUNDLE_SCHEMA_VERSION, type ApprovalBundleRevision, type ProposedChange } from "./contracts.js";

/**
 * Canonical manifest + manifest hashing.
 *
 * The manifest is the only thing an approval is allowed to be about. It must contain
 * every field that can change what a reviewer believed they were authorizing, and
 * nothing that is merely lifecycle bookkeeping.
 *
 * `strictCanonicalJsonV1` is used rather than `canonicalJson` on purpose: it throws on
 * `undefined`, non-finite numbers, symbols, cycles, accessors and non-plain objects.
 * A manifest that cannot be canonicalized therefore cannot be hashed, and a change
 * that cannot be hashed can never be approved.
 */

export const APPROVAL_BUNDLE_MANIFEST_DOMAIN = "acs:approval-bundle-manifest:v1";
export const APPROVAL_BUNDLE_CHANGE_DOMAIN = "acs:approval-bundle-change:v1";

/**
 * The authorization-relevant projection of a single change.
 *
 * Note what is *not* here: `id` and `summary`. A change is identified by its digest
 * rather than by its id, so re-labelling a change cannot make a modified change look
 * unchanged, and two revisions that describe the same operation produce the same
 * digest regardless of how the agent happened to number it.
 */
export interface CanonicalChange {
  type: ProposedChange["type"];
  target: string;
  action: { kind: string; description: string; params: Record<string, unknown> };
  command?: string[];
  cwd?: string;
  paths?: string[];
  risk: ProposedChange["risk"];
  destructive: boolean;
  network: boolean;
  dependsOn: string[];
  metadata?: Record<string, unknown>;
}

export interface CanonicalApprovalManifest {
  schemaVersion: typeof APPROVAL_BUNDLE_SCHEMA_VERSION;
  bundleId: string;
  missionId: string;
  executionId: string;
  agentId: string;
  revision: number;
  title: string;
  rationale: string;
  changes: CanonicalChange[];
  scope: ApprovalBundleRevision["scope"];
  baseState: ApprovalBundleRevision["baseState"];
  parentManifestHash?: string;
}

function canonicalizeChange(change: ProposedChange): CanonicalChange {
  // Optional collections are omitted when absent rather than set to `undefined`,
  // because the strict canonical serializer rejects an explicitly-undefined property.
  // An empty array is still preserved, so a change that explicitly cleared a path list
  // stays distinguishable from one that never mentioned it.
  const canonical: CanonicalChange = {
    type: change.type,
    target: change.target,
    action: {
      kind: change.action.kind,
      description: change.action.description,
      params: { ...change.action.params }
    },
    risk: change.risk,
    destructive: change.destructive,
    network: change.network,
    dependsOn: [...change.dependsOn]
  };
  if (change.command !== undefined) {
    canonical.command = [...change.command];
  }
  if (change.cwd !== undefined) {
    canonical.cwd = change.cwd;
  }
  if (change.paths !== undefined) {
    canonical.paths = [...change.paths];
  }
  if (change.metadata !== undefined) {
    canonical.metadata = { ...change.metadata };
  }
  return canonical;
}

/**
 * Build the canonical manifest for one bundle revision.
 *
 * `status`, `createdAt`, `createdByActorId`, `expiresAt`, approval decisions and the
 * manifest hash itself are excluded on purpose: they record what happened, not what
 * was authorized. Including them would make the hash change every time the bundle
 * moved, which would make an approval impossible to keep bound to it.
 */
export function canonicalApprovalManifest(revision: ApprovalBundleRevision): CanonicalApprovalManifest {
  const canonical: CanonicalApprovalManifest = {
    schemaVersion: APPROVAL_BUNDLE_SCHEMA_VERSION,
    bundleId: revision.bundleId,
    missionId: revision.missionId,
    executionId: revision.executionId,
    agentId: revision.agentId,
    revision: revision.revision,
    title: revision.title,
    rationale: revision.rationale,
    changes: revision.changes.map(canonicalizeChange),
    scope: { ...revision.scope },
    baseState: { ...revision.baseState }
  };
  if (revision.parentManifestHash !== undefined) {
    canonical.parentManifestHash = revision.parentManifestHash;
  }
  return canonical;
}

/** Stable serialization of a manifest. Throws on anything not representable. */
export function serializeApprovalManifest(revision: ApprovalBundleRevision): string {
  return strictCanonicalJsonV1(canonicalApprovalManifest(revision));
}

/**
 * Domain-separated hash of a manifest document.
 *
 * Domain separation keeps this hash from ever colliding with, or being confused for,
 * an `actionHash`, a `planHash` or a `requestHash` computed elsewhere in ACS.
 */
export function approvalManifestHashFromCanonical(manifest: CanonicalApprovalManifest): string {
  return createHash("sha256")
    .update(APPROVAL_BUNDLE_MANIFEST_DOMAIN, "utf8")
    .update("\0", "utf8")
    .update(strictCanonicalJsonV1(manifest), "utf8")
    .digest("hex");
}

/** Hash of one bundle revision's manifest. */
export function approvalManifestHash(revision: ApprovalBundleRevision): string {
  return approvalManifestHashFromCanonical(canonicalApprovalManifest(revision));
}

/**
 * Hash of a single change inside the manifest. This is what delta calculation
 * compares, and what "unchanged since approval" means.
 */
export function approvalChangeDigest(change: ProposedChange): string {
  return createHash("sha256")
    .update(APPROVAL_BUNDLE_CHANGE_DOMAIN, "utf8")
    .update("\0", "utf8")
    .update(strictCanonicalJsonV1(canonicalizeChange(change)), "utf8")
    .digest("hex");
}

/** Every change id paired with its digest, for a revision. */
export function approvalChangeDigests(revision: ApprovalBundleRevision): Map<string, string> {
  const digests = new Map<string, string>();
  for (const change of revision.changes) {
    if (digests.has(change.id)) {
      throw new Error(`approval bundle ${revision.bundleId} has duplicate change id ${change.id}`);
    }
    digests.set(change.id, approvalChangeDigest(change));
  }
  return digests;
}

/**
 * Recompute the manifest hash of a stored revision and compare it with the stored
 * value. A mismatch means the persisted revision was tampered with after the fact and
 * must never be treated as approved.
 */
export function verifyApprovalManifest(
  revision: ApprovalBundleRevision
): { ok: true } | { ok: false; code: "approval_manifest_tampered"; expected: string; actual: string } {
  const actual = approvalManifestHash(revision);
  if (actual !== revision.manifestHash) {
    return { ok: false, code: "approval_manifest_tampered", expected: revision.manifestHash, actual };
  }
  return { ok: true };
}
