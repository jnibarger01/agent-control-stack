import { ControlStackError } from "@agent-control-stack/shared";
import {
  approvalBundleRevisionSchema,
  identifierSchema,
  overallBundleRisk,
  type ApprovalBundleRevision,
  type ProposedChange
} from "./contracts.js";
import { approvalChangeDigests, approvalManifestHash } from "./manifest.js";

/**
 * Bundle revisions and delta calculation.
 *
 * A revision is immutable. Creating revision N+1 never mutates revision N; it records
 * `parentManifestHash` and a freshly computed `manifestHash`, which is what makes
 * "previously approved" a verifiable claim rather than a hopeful one.
 */

export const createApprovalBundleRevisionInputSchema = approvalBundleRevisionSchema
  .omit({ revision: true, manifestHash: true, status: true, createdAt: true })
  .extend({
    revision: z.number().int().positive().optional(),
    scope: approvalBundleRevisionSchema.shape.scope.default({}),
    baseState: approvalBundleRevisionSchema.shape.baseState.default({})
  })
  .strict();

import { z } from "zod";

export type CreateApprovalBundleRevisionInput = z.input<typeof createApprovalBundleRevisionInputSchema>;

export interface ReviseApprovalBundleInput {
  bundleId: string;
  /** The revision the caller believes is current. Optimistic concurrency. */
  expectedRevision: number;
  title?: string;
  rationale?: string;
  changes: ProposedChange[];
  scope?: ApprovalBundleRevision["scope"];
  baseState?: ApprovalBundleRevision["baseState"];
  createdByActorId: string;
  now?: Date;
}

function assertUniqueChangeIds(changes: readonly ProposedChange[], bundleId: string): void {
  const seen = new Set<string>();
  for (const change of changes) {
    if (seen.has(change.id)) {
      throw new ControlStackError(
        "approval_bundle_duplicate_change",
        `approval bundle ${bundleId} has duplicate change id ${change.id}`
      );
    }
    seen.add(change.id);
  }
}

/**
 * Reject a dependency that names a change not in the same revision, and any cycle.
 *
 * A dangling or cyclic dependency would make "approve selected" ambiguous, so it is
 * refused at revision-creation time rather than discovered later at approval time.
 */
export function assertChangeDependenciesResolvable(changes: readonly ProposedChange[], bundleId: string): void {
  const ids = new Set(changes.map((change) => change.id));
  for (const change of changes) {
    for (const dependency of change.dependsOn) {
      if (!ids.has(dependency)) {
        throw new ControlStackError(
          "approval_bundle_dependency_unknown",
          `approval bundle ${bundleId} change ${change.id} depends on unknown change ${dependency}`
        );
      }
      if (dependency === change.id) {
        throw new ControlStackError(
          "approval_bundle_dependency_cycle",
          `approval bundle ${bundleId} change ${change.id} depends on itself`
        );
      }
    }
  }

  // Depth-first cycle detection over dependsOn.
  const state = new Map<string, "visiting" | "done">();
  const visit = (id: string, trail: readonly string[]): void => {
    const current = state.get(id);
    if (current === "done") {
      return;
    }
    if (current === "visiting") {
      throw new ControlStackError(
        "approval_bundle_dependency_cycle",
        `approval bundle ${bundleId} has a dependency cycle: ${[...trail, id].join(" -> ")}`
      );
    }
    state.set(id, "visiting");
    const change = changes.find((candidate) => candidate.id === id);
    for (const dependency of change?.dependsOn ?? []) {
      visit(dependency, [...trail, id]);
    }
    state.set(id, "done");
  };
  for (const change of changes) {
    visit(change.id, []);
  }
}

/** Expand a change's `dependsOn` to every change it transitively requires. */
export function transitiveChangeDependencies(changes: readonly ProposedChange[], changeId: string): string[] {
  const byId = new Map(changes.map((change) => [change.id, change]));
  const seen = new Set<string>();
  const stack = [...(byId.get(changeId)?.dependsOn ?? [])];
  while (stack.length > 0) {
    const next = stack.pop() as string;
    if (seen.has(next)) {
      continue;
    }
    seen.add(next);
    for (const dependency of byId.get(next)?.dependsOn ?? []) {
      if (!seen.has(dependency)) {
        stack.push(dependency);
      }
    }
  }
  return [...seen].sort((left, right) => left.localeCompare(right, "en"));
}

/**
 * Build revision 1 of a bundle.
 */
export function createApprovalBundleRevision(
  input: CreateApprovalBundleRevisionInput,
  now: Date = new Date()
): ApprovalBundleRevision {
  const parsed = createApprovalBundleRevisionInputSchema.parse(input);
  assertUniqueChangeIds(parsed.changes, parsed.bundleId);
  assertChangeDependenciesResolvable(parsed.changes, parsed.bundleId);

  const draft: ApprovalBundleRevision = {
    bundleId: parsed.bundleId,
    missionId: parsed.missionId,
    executionId: parsed.executionId,
    agentId: parsed.agentId,
    title: parsed.title,
    rationale: parsed.rationale,
    revision: 1,
    changes: parsed.changes,
    scope: parsed.scope ?? {},
    baseState: parsed.baseState ?? {},
    manifestHash: "",
    status: "draft",
    createdAt: now.toISOString(),
    createdByActorId: parsed.createdByActorId
  };
  if (parsed.expiresAt !== undefined) {
    draft.expiresAt = parsed.expiresAt;
  }
  return { ...draft, manifestHash: approvalManifestHash(draft) };
}

/**
 * Build the next revision of an existing bundle.
 *
 * The caller must state which revision it believes is current. A mismatch is a
 * conflict, not something to silently overwrite, so two agents revising the same
 * bundle concurrently cannot corrupt its history.
 */
export function reviseApprovalBundle(
  previous: ApprovalBundleRevision,
  input: ReviseApprovalBundleInput
): ApprovalBundleRevision {
  if (input.expectedRevision !== previous.revision) {
    throw new ControlStackError(
      "approval_bundle_revision_conflict",
      `approval bundle ${previous.bundleId} is at revision ${previous.revision}, not ${input.expectedRevision}`
    );
  }
  if (previous.status === "rejected" || previous.status === "invalidated") {
    throw new ControlStackError(
      "approval_bundle_not_revisable",
      `approval bundle ${previous.bundleId} is ${previous.status} and cannot be revised`
    );
  }
  assertUniqueChangeIds(input.changes, previous.bundleId);
  assertChangeDependenciesResolvable(input.changes, previous.bundleId);

  const next: ApprovalBundleRevision = {
    bundleId: previous.bundleId,
    missionId: previous.missionId,
    executionId: previous.executionId,
    agentId: previous.agentId,
    title: input.title ?? previous.title,
    rationale: input.rationale ?? previous.rationale,
    revision: previous.revision + 1,
    changes: input.changes,
    scope: input.scope ?? previous.scope,
    baseState: input.baseState ?? previous.baseState,
    parentManifestHash: previous.manifestHash,
    manifestHash: "",
    status: "modified",
    createdAt: (input.now ?? new Date()).toISOString(),
    createdByActorId: input.createdByActorId
  };
  if (previous.expiresAt !== undefined) {
    next.expiresAt = previous.expiresAt;
  }
  return { ...next, manifestHash: approvalManifestHash(next) };
}

// ---------------------------------------------------------------------------
// Delta
// ---------------------------------------------------------------------------

export type ApprovalDeltaClass = "unchanged" | "modified" | "added" | "removed";

export interface ApprovalDeltaEntry {
  changeId: string;
  digest: string;
  classification: ApprovalDeltaClass;
  /** Digest of the same change in the previous revision, when it existed. */
  previousDigest?: string;
  change?: ProposedChange;
}

export interface ApprovalDelta {
  fromRevision: number;
  toRevision: number;
  fromManifestHash: string;
  toManifestHash: string;
  /** Carried over from the previous approval; does not need re-approval. */
  unchanged: ApprovalDeltaEntry[];
  /** Present in both revisions but with a different digest. Must be re-approved. */
  modified: ApprovalDeltaEntry[];
  /** Not present in the previous revision. Must be approved. */
  added: ApprovalDeltaEntry[];
  /** Present in the previous revision only. Narrowing; nothing to approve. */
  removed: ApprovalDeltaEntry[];
  /** Added + modified: exactly the set a delta approval must cover. */
  requiresApproval: ApprovalDeltaEntry[];
}

/**
 * Classify a proposed revision against the last approved one.
 *
 * Comparison is by change *digest*, not by change id, so the same logical operation
 * is recognised as unchanged even if the agent renumbered it, and a change that was
 * altered in any authorization-relevant way is never mistaken for the old one.
 */
export function approvalDelta(previous: ApprovalBundleRevision, next: ApprovalBundleRevision): ApprovalDelta {
  if (previous.bundleId !== next.bundleId) {
    throw new ControlStackError(
      "approval_bundle_mismatch",
      `cannot diff bundles ${previous.bundleId} and ${next.bundleId}`
    );
  }
  const previousDigests = approvalChangeDigests(previous);
  const nextDigests = approvalChangeDigests(next);
  const nextById = new Map(next.changes.map((change) => [change.id, change]));

  const unchanged: ApprovalDeltaEntry[] = [];
  const modified: ApprovalDeltaEntry[] = [];
  const added: ApprovalDeltaEntry[] = [];
  const removed: ApprovalDeltaEntry[] = [];

  for (const [changeId, digest] of nextDigests) {
    const previousDigest = previousDigests.get(changeId);
    const change = nextById.get(changeId);
    if (previousDigest === undefined) {
      const entry: ApprovalDeltaEntry = { changeId, digest, classification: "added" };
      if (change) {
        entry.change = change;
      }
      added.push(entry);
    } else if (previousDigest === digest) {
      const entry: ApprovalDeltaEntry = {
        changeId,
        digest,
        classification: "unchanged",
        previousDigest
      };
      if (change) {
        entry.change = change;
      }
      unchanged.push(entry);
    } else {
      const entry: ApprovalDeltaEntry = {
        changeId,
        digest,
        classification: "modified",
        previousDigest
      };
      if (change) {
        entry.change = change;
      }
      modified.push(entry);
    }
  }
  for (const [changeId, digest] of previousDigests) {
    if (!nextDigests.has(changeId)) {
      removed.push({ changeId, digest, classification: "removed" });
    }
  }

  const byId = (left: ApprovalDeltaEntry, right: ApprovalDeltaEntry): number =>
    left.changeId.localeCompare(right.changeId, "en");

  unchanged.sort(byId);
  modified.sort(byId);
  added.sort(byId);
  removed.sort(byId);

  return {
    fromRevision: previous.revision,
    toRevision: next.revision,
    fromManifestHash: previous.manifestHash,
    toManifestHash: next.manifestHash,
    unchanged,
    modified,
    added,
    removed,
    requiresApproval: [...added, ...modified].sort(byId)
  };
}

/** Convenience: the highest risk a delta introduces, for the "Risk" tab. */
export function deltaRisk(delta: ApprovalDelta): ProposedChange["risk"] {
  return overallBundleRisk(
    delta.requiresApproval
      .map((entry) => entry.change)
      .filter((change): change is ProposedChange => change !== undefined)
  );
}
