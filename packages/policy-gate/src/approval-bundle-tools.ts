import { z } from "zod";
import { ControlStackError, stableHash } from "@agent-control-stack/shared";
import {
  activeGrantCovers,
  approvalChangeDigest,
  approvalDelta,
  assertSelectionDependenciesSatisfied,
  createApprovalBundleRevision,
  overallBundleRisk,
  reviseApprovalBundle,
  verifyApprovalManifest,
  type ApprovalBundle,
  type ApprovalBundleRevision,
  type ApprovalDelta,
  type ApprovalDecision,
  type ApprovalGrantRecord,
  type ProposedChange
} from "@agent-control-stack/approval-bundles";
import type { ActionRequest, WorkItem, WorkItemStore } from "@agent-control-stack/work-items";
import { actionFingerprint } from "./fingerprint.js";
import { evaluatePolicy, policyContextFromAction, type PolicyContext, type PolicyDecision } from "./policy.js";
import type { PolicyEngine } from "./policy.js";
import { approvalStrategySchema, type ApprovalStrategy } from "@agent-control-stack/work-items";
import { ensureExecutionPlan } from "./tools.js";

/**
 * Policy Gate integration for approval bundles.
 *
 * This is where a bundle stops being a document and becomes a decision. Two rules
 * govern everything below:
 *
 * 1. **The action hash is the only thing a grant is ever bound to.** It is produced
 *    here by `actionFingerprint`, the same function the rest of Policy Gate uses. A
 *    bundle therefore cannot authorize an operation the policy engine would not
 *    already fingerprint, and any edit to the operation produces a hash that matches
 *    no grant.
 *
 * 2. **Policy stays authoritative.** A bundle never overrides a `deny`. Approval can
 *    only turn `require_approval` into `allow`; it can never turn `deny` into
 *    anything else, and it can never mint a grant for an action Policy Gate rejects.
 *
 * The authoritative `execution_plan_approvals` rows are minted through the existing
 * `grantExecutionPlanApproval`, so every downstream verifier
 * (`attempt_lease_approvals` triggers, `authorizeJaceCommanderExecution`, the
 * capability registries) keeps working exactly as before.
 */

const planTransition = { via: "policy_gate" } as const;

/** How a change's shape was inferred from its action kind. */
const changeTypeByActionKind: Record<string, ProposedChange["type"]> = {
  "fs.write": "file_write",
  "fs.patch": "file_write",
  "fs.move": "file_write",
  "fs.delete": "destructive_action",
  shell: "command",
  "privileged.exec": "other_privileged_action",
  "service.restart": "service_restart",
  "service.control": "service_control",
  deploy: "deployment",
  "config.write": "config_change",
  "net.write": "external_write"
};

function changeTypeFor(action: ActionRequest, declared?: ProposedChange["type"]): ProposedChange["type"] {
  if (declared) {
    return declared;
  }
  return changeTypeByActionKind[action.kind] ?? "other_privileged_action";
}

/**
 * Derive the Policy Gate context a bundle change will be evaluated under.
 *
 * Exported so a bundle change and the live operation it authorizes are guaranteed to
 * be fingerprinted from the same inputs, rather than from two look-alike code paths.
 */
export function policyContextForBundleChange(
  workItem: WorkItem,
  change: Pick<ProposedChange, "action" | "command" | "cwd" | "paths" | "destructive" | "network">,
  actor: string,
  operation: "create" | "claim" | "approve" = "claim"
): PolicyContext {
  return policyContextFromAction(workItem, change.action, actor, operation);
}

/** The action hash a change is authorized as. */
export function bundleChangeActionHash(workItem: WorkItem, change: ProposedChange): string {
  return actionFingerprint(policyContextForBundleChange(workItem, change, workItem.requester));
}

/**
 * Build a bundle revision covering every policy-required action of a work item.
 *
 * Only actions Policy Gate actually required approval for are included. Bundling an
 * action that never needed approval would misrepresent the blast radius to a reviewer.
 */
export function buildBundleFromWorkItem(input: {
  store: WorkItemStore;
  policy: PolicyEngine;
  workItem: WorkItem;
  bundleId: string;
  title?: string;
  rationale?: string;
  scope?: ApprovalBundleRevision["scope"];
  baseState?: ApprovalBundleRevision["baseState"];
  createdByActorId: string;
  now?: Date;
}): { revision: ApprovalBundleRevision; requiredActionHashes: string[] } {
  const { store, policy, workItem } = input;
  const executionPlan = ensureExecutionPlan(store, workItem, input.createdByActorId);
  const evaluations = policy.evaluateWorkItem(workItem, workItem.requester, "create");
  // Deny is checked first: a work item policy rejects is not a bundle awaiting review,
  // and reporting it as "nothing to approve" would hide a hard block behind a
  // recoverable-sounding error.
  const denied = evaluations.find((evaluation) => evaluation.decision.decision === "deny");
  if (denied) {
    throw new ControlStackError(
      "approval_bundle_policy_denied",
      `work item ${workItem.id} is denied by policy (${denied.decision.matchedRules.join(", ")}) and cannot be bundled for approval`
    );
  }
  const required = evaluations.filter((evaluation) => evaluation.decision.decision === "require_approval");
  if (required.length === 0) {
    throw new ControlStackError(
      "approval_bundle_nothing_to_approve",
      `work item ${workItem.id} has no policy-required actions to bundle`
    );
  }

  const changes: ProposedChange[] = required.map((evaluation, index) => {
    const action = evaluation.action;
    const context = evaluation.context;
    const risk = context.risk;
    return {
      id: `change-${String(index + 1).padStart(3, "0")}`,
      type: changeTypeFor(action),
      summary: action.description,
      target: primaryTarget(context),
      action: {
        kind: action.kind,
        description: action.description,
        params: { ...action.params }
      },
      actionHash: evaluation.actionHash,
      ...(context.command ? { command: [...context.command] } : {}),
      ...(context.cwd ? { cwd: context.cwd } : {}),
      ...(context.paths ? { paths: [...context.paths] } : {}),
      risk,
      destructive: context.destructive === true,
      network: context.network === true,
      dependsOn: []
    };
  });

  const revision = createApprovalBundleRevision(
    {
      bundleId: input.bundleId,
      missionId: workItem.id,
      // The bundle is bound to the immutable, authoritative ACS execution plan.
      executionId: executionPlan.planId,
      agentId: workItem.requesterSubject ?? workItem.requester,
      title: input.title ?? workItem.title,
      rationale: input.rationale ?? workItem.intent,
      changes,
      scope: input.scope ?? {},
      baseState: input.baseState ?? {},
      createdByActorId: input.createdByActorId
    },
    input.now
  );
  return { revision, requiredActionHashes: required.map((evaluation) => evaluation.actionHash) };
}

/**
 * Create the deterministic pending proposal for this work item's current plan, or
 * return the proposal already associated with it. This operation persists review
 * state only; execution-plan approvals are created exclusively by gateApproveBundle.
 */
export function createOrReuseBundleProposal(input: {
  store: WorkItemStore;
  policy: PolicyEngine;
  workItem: WorkItem;
  createdByActorId: string;
  title?: string;
  rationale?: string;
  now?: Date;
}): ApprovalBundle {
  const plan = ensureExecutionPlan(input.store, input.workItem, input.createdByActorId);
  const bundleId = `bundle-${stableHash({
    domain: "acs:approval-bundle-for-plan:v1",
    workItemId: input.workItem.id,
    planId: plan.planId
  }).slice(0, 40)}`;
  const existing = input.store.getApprovalBundle(bundleId);
  if (existing) {
    if (
      existing.missionId !== input.workItem.id ||
      existing.executionId !== plan.planId ||
      existing.agentId !== (input.workItem.requesterSubject ?? input.workItem.requester)
    ) {
      throw new ControlStackError(
        "approval_bundle_binding_mismatch",
        `existing proposal ${bundleId} does not match the authoritative work item and execution plan`
      );
    }
    return existing;
  }

  const { revision } = buildBundleFromWorkItem({
    ...input,
    bundleId,
    createdByActorId: input.createdByActorId
  });
  input.store.createApprovalBundle({ ...revision, status: "pending" });
  const created = input.store.getApprovalBundle(bundleId);
  if (!created) {
    throw new ControlStackError(
      "approval_bundle_persistence_failed",
      `proposal ${bundleId} was not available after its transaction committed`
    );
  }
  return created;
}

function primaryTarget(context: PolicyContext): string {
  if (context.paths && context.paths.length > 0) {
    return context.paths[0] as string;
  }
  if (context.command && context.command.length > 0) {
    return context.command.join(" ");
  }
  if (context.cwd) {
    return context.cwd;
  }
  const namedPath = ["sourcePath", "destinationPath", "targetPath", "outputPath", "templatePath"].find(
    (key) => typeof context.action.params[key] === "string"
  );
  if (namedPath) {
    return context.action.params[namedPath] as string;
  }
  return context.action.kind;
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export const bundleDecisionInputSchema = z
  .object({
    bundleId: z.string().min(1),
    revision: z.number().int().positive(),
    kind: z.enum(["approve_all", "approve_selected", "reject", "invalidate"]),
    approvedBy: z.string().min(1),
    reason: z.string().min(1).max(2_000),
    changeIds: z.array(z.string().min(1)).max(512).optional(),
    now: z.date().optional()
  })
  .strict();

export type BundleDecisionInput = z.infer<typeof bundleDecisionInputSchema>;

export interface BundleDecisionResult {
  decision: ApprovalDecision;
  bundle: ApprovalBundle;
  /** Authoritative plan approvals minted, keyed by change id. */
  approvalIdsByChange: Record<string, string>;
  /** Changes the reviewer selected but that policy still denies. */
  deniedChangeIds: string[];
}

export function gateApproveBundle(store: WorkItemStore, policy: PolicyEngine, rawInput: unknown): BundleDecisionResult {
  // All authoritative plan approvals and bundle decision/grant rows commit or roll
  // back together. A late policy or integrity failure must not leave orphaned plan
  // approvals that can be consumed outside the bundle review record.
  return store.withTransaction(() => gateApproveBundleInTransaction(store, policy, rawInput));
}

/**
 * Apply a human decision to one bundle revision.
 *
 * `approve_all` and `approve_selected` mint one `execution_plan_approvals` row per
 * selected change. The bundle then records which row stands for which change. The
 * bundle itself confers nothing.
 */
function gateApproveBundleInTransaction(
  store: WorkItemStore,
  policy: PolicyEngine,
  rawInput: unknown
): BundleDecisionResult {
  const input = bundleDecisionInputSchema.parse(rawInput);
  const bundle = store.getApprovalBundle(input.bundleId);
  if (!bundle) {
    throw new ControlStackError("approval_bundle_not_found", `approval bundle not found: ${input.bundleId}`);
  }
  if (bundle.revision !== input.revision) {
    throw new ControlStackError(
      "approval_bundle_revision_conflict",
      `approval bundle ${input.bundleId} is at revision ${bundle.revision}, not ${input.revision}`
    );
  }
  // A stored revision whose manifest no longer hashes to its recorded value was
  // tampered with and must never be approved.
  const integrity = verifyApprovalManifest(stripDecisions(bundle));
  if (!integrity.ok) {
    throw new ControlStackError(
      "approval_manifest_tampered",
      `approval bundle ${input.bundleId} manifest no longer matches its hash`
    );
  }
  if (bundle.status === "invalidated" || bundle.status === "rejected") {
    throw new ControlStackError(
      "approval_bundle_not_approvable",
      `approval bundle ${input.bundleId} is ${bundle.status}`
    );
  }
  if (input.approvedBy === "acs:admin") {
    throw new ControlStackError(
      "approval_bundle_admin_approval_denied",
      "a bundle may not be granted by the admin auto-approver"
    );
  }

  const workItem = store.get(bundle.missionId);
  if (!workItem) {
    throw new ControlStackError("work_item_not_found", `work item not found: ${bundle.missionId}`);
  }
  if (input.kind === "reject" || input.kind === "invalidate") {
    const decisionTransition = { via: "policy_gate" as const, actorId: input.approvedBy };
    const decision = store.recordApprovalBundleDecision({
      bundleId: input.bundleId,
      revision: input.revision,
      kind: input.kind,
      approvedByActorId: input.approvedBy,
      reason: input.reason,
      changeIds: [],
      approvalIdsByChange: {},
      workItemId: workItem.id,
      planHash: currentPlanHash(store, workItem, input.approvedBy),
      ...(input.now ? { now: input.now } : {})
    });
    if (input.kind === "invalidate") {
      store.invalidateApprovalBundle(input.bundleId, input.reason, decisionTransition);
    } else {
      const activeChangeIds = store
        .listApprovalBundleGrants({ bundleId: input.bundleId })
        .filter((grant) => grant.status === "granted")
        .map((grant) => grant.changeId);
      store.revokeApprovalBundleChanges(input.bundleId, activeChangeIds, input.reason, decisionTransition);
      store.setApprovalBundleStatus(input.bundleId, "rejected", decisionTransition);
      if (workItem.status === "approved") {
        store.blockWorkItem(workItem.id, decisionTransition);
      } else if (workItem.status !== "needs_approval" && workItem.status !== "blocked") {
        throw new ControlStackError(
          "approval_bundle_work_item_not_rejectable",
          `work item ${workItem.id} in ${workItem.status} cannot be rejected through its bundle`
        );
      }
      store.rejectWorkItem(
        workItem.id,
        { actor: input.approvedBy, reason: input.reason },
        { via: "policy_gate", actorId: input.approvedBy }
      );
    }
    return {
      decision,
      bundle: store.getApprovalBundle(input.bundleId) as ApprovalBundle,
      approvalIdsByChange: {},
      deniedChangeIds: []
    };
  }

  if (bundle.expiresAt && Date.parse(bundle.expiresAt) <= (input.now ?? new Date()).getTime()) {
    throw new ControlStackError("approval_bundle_expired", `approval bundle ${input.bundleId} has expired`);
  }

  if (bundle.executionId !== ensureExecutionPlan(store, workItem, input.approvedBy).planId) {
    throw new ControlStackError(
      "approval_bundle_execution_mismatch",
      `approval bundle ${input.bundleId} is not bound to the current work-item plan execution`
    );
  }
  if (bundle.baseState.gitSha !== undefined || bundle.baseState.configHash !== undefined) {
    throw new ControlStackError(
      "approval_bundle_base_state_unverified",
      "gateway execution does not currently provide a live base-state verifier; remove the pin before approval"
    );
  }

  const candidates =
    input.kind === "approve_all"
      ? bundle.changes
      : bundle.changes.filter((change) => (input.changeIds ?? []).includes(change.id));
  if (input.kind === "approve_selected" && candidates.length === 0) {
    throw new ControlStackError("approval_bundle_nothing_selected", "approve_selected requires at least one change id");
  }
  // Refuse a selection that omits a dependency rather than granting a change that
  // cannot legally run.
  assertSelectionDependenciesSatisfied(
    bundle.changes,
    candidates.map((change) => change.id)
  );

  // Re-evaluate each selected change with operation "approve", so self-approval and
  // admin-approval denials fire exactly as they do on the per-action route.
  const approvalIdsByChange: Record<string, string> = {};
  const deniedChangeIds: string[] = [];
  for (const change of candidates) {
    // The grant is bound to an action hash, and the reviewer only ever sees
    // `change.action` rendered as summary/target/command. `change.actionHash` is part of
    // the agent-supplied manifest, so trusting it verbatim would let a manifest that
    // *displays* one operation be used to mint authority for a different one: the
    // manifest self-hash stays consistent because it hashes the forged field like any
    // other, so `verifyApprovalManifest` cannot catch it. The authorization identity is
    // therefore re-derived here from the action the reviewer actually saw, and any
    // disagreement fails the whole approval closed rather than silently re-binding.
    const derivedHash = bundleChangeActionHash(workItem, change);
    if (derivedHash !== change.actionHash) {
      throw new ControlStackError(
        "approval_bundle_action_hash_mismatch",
        `change ${change.id} in bundle ${input.bundleId} records an action hash that does not match its action`
      );
    }
    assertReviewProjectionMatchesAction(workItem, change);
    const decision = evaluatePolicy(policyContextForBundleChange(workItem, change, input.approvedBy, "approve"));
    if (decision.decision === "deny") {
      deniedChangeIds.push(change.id);
      continue;
    }
    const planHash = currentPlanHash(store, workItem, input.approvedBy);
    const planApproval = store.grantExecutionPlanApproval(
      {
        workItemId: workItem.id,
        planHash,
        actionHash: derivedHash,
        approvedByActorId: input.approvedBy,
        reason: input.reason
      },
      planTransition
    );
    store.recordApproval({
      workItemId: workItem.id,
      actionHash: derivedHash,
      approvedBy: input.approvedBy,
      reason: input.reason
    });
    approvalIdsByChange[change.id] = planApproval.approvalId;
  }

  if (deniedChangeIds.length === candidates.length) {
    throw new ControlStackError(
      "approval_bundle_policy_denied",
      `policy denies every selected change in bundle ${input.bundleId}`
    );
  }

  const approvedChangeIds = Object.keys(approvalIdsByChange);
  const decision = store.recordApprovalBundleDecision({
    bundleId: input.bundleId,
    revision: input.revision,
    kind: input.kind,
    approvedByActorId: input.approvedBy,
    reason: input.reason,
    changeIds: approvedChangeIds,
    approvalIdsByChange,
    workItemId: workItem.id,
    planHash: currentPlanHash(store, workItem, input.approvedBy),
    ...(input.now ? { now: input.now } : {})
  });

  const partial = approvedChangeIds.length < bundle.changes.length;
  store.setApprovalBundleStatus(input.bundleId, partial ? "partially_approved" : "approved", {
    via: "policy_gate",
    actorId: input.approvedBy
  });
  const requiredHashes = policy
    .evaluateWorkItem(workItem, input.approvedBy, "claim")
    .filter((evaluation) => evaluation.decision.decision === "require_approval")
    .map((evaluation) => evaluation.actionHash);
  const currentWorkItem = store.get(workItem.id);
  if (
    currentWorkItem?.status === "needs_approval" &&
    requiredHashes.every((actionHash) => store.hasApproval(workItem.id, actionHash))
  ) {
    store.approveWorkItem(workItem.id, planTransition);
  }

  return {
    decision,
    bundle: store.getApprovalBundle(input.bundleId) as ApprovalBundle,
    approvalIdsByChange,
    deniedChangeIds
  };
}

function stripDecisions(bundle: ApprovalBundle): ApprovalBundleRevision {
  const { approvals: _approvals, ...revision } = bundle;
  return revision as ApprovalBundleRevision;
}

/**
 * The plan hash a bundle grant binds to.
 *
 * Reuses `ensureExecutionPlan`, the same helper the per-action approval route uses, so
 * a bundle grant lands on the identical plan a normal approval would have produced. A
 * bundle cannot introduce a second, differently-shaped plan to attach authority to.
 */
function currentPlanHash(store: WorkItemStore, workItem: WorkItem, actor: string): string {
  return ensureExecutionPlan(store, workItem, actor).planHash;
}

function assertReviewProjectionMatchesAction(workItem: WorkItem, change: ProposedChange): void {
  const context = policyContextForBundleChange(workItem, change, workItem.requester);
  const sameArray = (left: string[] | undefined, right: string[] | undefined) =>
    left === undefined
      ? right === undefined
      : right !== undefined && left.length === right.length && left.every((v, i) => v === right[i]);
  const expectedType = changeTypeByActionKind[context.action.kind] ?? "other_privileged_action";
  if (
    change.summary !== change.action.description ||
    change.type !== expectedType ||
    change.target !== primaryTarget(context) ||
    change.risk !== context.risk ||
    change.destructive !== (context.destructive === true) ||
    change.network !== (context.network === true) ||
    !sameArray(change.command, context.command) ||
    !sameArray(
      change.cwd === undefined ? undefined : [change.cwd],
      context.cwd === undefined ? undefined : [context.cwd]
    ) ||
    !sameArray(change.paths, context.paths)
  ) {
    throw new ControlStackError(
      "approval_bundle_review_projection_mismatch",
      `change ${change.id} review fields do not match the operation Policy Gate will authorize`
    );
  }
}

/** Validate that a persisted grant still points to a reviewed, current bundle change. */
function grantStillMatchesBundle(
  store: WorkItemStore,
  grant: ApprovalGrantRecord,
  workItemId: string,
  now: Date
): boolean {
  try {
    if (grant.workItemId !== workItemId || grant.missionId !== workItemId) return false;
    const bundle = store.getApprovalBundle(grant.bundleId);
    if (
      !bundle ||
      bundle.missionId !== grant.missionId ||
      bundle.executionId !== grant.executionId ||
      bundle.status === "invalidated" ||
      bundle.status === "rejected" ||
      (bundle.expiresAt !== undefined && Date.parse(bundle.expiresAt) <= now.getTime())
    ) {
      return false;
    }

    const revisions = store.listApprovalBundleRevisions(grant.bundleId);
    if (revisions.length !== bundle.revision) return false;
    for (let index = 0; index < revisions.length; index += 1) {
      const revision = revisions[index]!;
      if (
        revision.revision !== index + 1 ||
        !verifyApprovalManifest(revision).ok ||
        revision.bundleId !== bundle.bundleId ||
        revision.missionId !== bundle.missionId ||
        revision.executionId !== bundle.executionId ||
        (index === 0
          ? revision.parentManifestHash !== undefined
          : revision.parentManifestHash !== revisions[index - 1]!.manifestHash)
      ) {
        return false;
      }
    }
    const current = revisions[revisions.length - 1];
    const approved = revisions[grant.revision - 1];
    if (
      !current ||
      !approved ||
      bundle.manifestHash !== current.manifestHash ||
      grant.manifestHash !== approved.manifestHash ||
      grant.revision !== approved.revision
    ) {
      return false;
    }
    const approvedChange = approved.changes.find((change) => change.id === grant.changeId);
    if (!approvedChange || approvedChange.actionHash !== grant.actionHash) return false;
    const digest = approvalChangeDigest(approvedChange);
    if (!current.changes.some((change) => approvalChangeDigest(change) === digest)) return false;
    if (
      grant.baseState.gitSha !== approved.baseState.gitSha ||
      grant.baseState.configHash !== approved.baseState.configHash
    ) {
      return false;
    }

    const decisionExists = store
      .listApprovalBundleDecisions(grant.bundleId)
      .some(
        (decision) =>
          decision.revision === grant.revision &&
          decision.manifestHash === grant.manifestHash &&
          (decision.kind === "approve_all" || decision.kind === "approve_selected") &&
          decision.approvedByActorId === grant.approvedByActorId &&
          decision.changeIds.includes(grant.changeId)
      );
    return decisionExists;
  } catch {
    // Corrupt, missing, or unreadable persisted authorization state is never authority.
    return false;
  }
}

// ---------------------------------------------------------------------------
// Revisions and delta
// ---------------------------------------------------------------------------

export interface BundleRevisionResult {
  bundle: ApprovalBundle;
  delta: ApprovalDelta;
}

export function gateReviseBundle(
  store: WorkItemStore,
  input: {
    bundleId: string;
    expectedRevision: number;
    changes: ProposedChange[];
    title?: string;
    rationale?: string;
    baseState?: ApprovalBundleRevision["baseState"];
    createdByActorId: string;
    now?: Date;
  }
): BundleRevisionResult {
  return store.withTransaction(() => gateReviseBundleInTransaction(store, input));
}

function gateReviseBundleInTransaction(
  store: WorkItemStore,
  input: {
    bundleId: string;
    expectedRevision: number;
    changes: ProposedChange[];
    title?: string;
    rationale?: string;
    baseState?: ApprovalBundleRevision["baseState"];
    createdByActorId: string;
    now?: Date;
  }
): BundleRevisionResult {
  const previous = store.getApprovalBundleRevision(input.bundleId, input.expectedRevision);
  if (!previous) {
    throw new ControlStackError(
      "approval_bundle_revision_not_found",
      `approval bundle ${input.bundleId} has no revision ${input.expectedRevision}`
    );
  }
  const next = reviseApprovalBundle(previous, input);
  const stored = store.addApprovalBundleRevision(next, input.expectedRevision);
  const delta = approvalDelta(previous, stored);
  const retainedDigests = new Set(stored.changes.map((change) => approvalChangeDigest(change)));
  const revokedChangeIds = new Set<string>();
  for (const grant of store.listApprovalBundleGrants({ bundleId: input.bundleId })) {
    if (grant.status !== "granted") continue;
    const source = store.getApprovalBundleRevision(input.bundleId, grant.revision);
    const approvedChange = source?.changes.find((change) => change.id === grant.changeId);
    if (!approvedChange || !retainedDigests.has(approvalChangeDigest(approvedChange))) {
      revokedChangeIds.add(grant.changeId);
    }
  }
  if (revokedChangeIds.size > 0) {
    store.revokeApprovalBundleChanges(
      input.bundleId,
      [...revokedChangeIds],
      `revision ${stored.revision} removed or changed the approved operation`,
      { via: "policy_gate", actorId: input.createdByActorId }
    );
  }
  return { bundle: store.getApprovalBundle(input.bundleId) as ApprovalBundle, delta };
}

// ---------------------------------------------------------------------------
// Runtime authorization
// ---------------------------------------------------------------------------

export type BundleAuthorizationVerdict =
  | { allowed: true; reason: "covered_by_approved_bundle"; grant: ApprovalGrantRecord; manifestHash: string }
  | { allowed: true; reason: "policy_allows_without_approval" }
  | {
      allowed: false;
      reason: "policy_denied" | "approval_not_required" | "authorization_miss" | "delta_approval_required";
      code: string;
      matchedRules: string[];
      /** Present when a bundle was expected but did not cover the operation. */
      coverageReason?: string;
    };

export interface AuthorizeBundleOperationInput {
  store: WorkItemStore;
  policy: PolicyEngine;
  workItem: WorkItem;
  /** The operation about to run, in ACS action form. */
  action: ActionRequest;
  actor: string;
  bundleId?: string;
  observedBaseState?: ApprovalBundleRevision["baseState"];
  now?: Date;
}

/**
 * The runtime authorization check for a privileged operation under bundle approval.
 *
 * Order matters and is deliberate:
 *
 * 1. Policy is evaluated first. A `deny` is never overridden by any approval.
 * 2. An action that policy already `allow`s needs no human at all; the active
 *    strategy decides whether that is sufficient.
 * 3. Otherwise the operation's action hash is compared against the bundle's grants.
 *    Only an exact hash match counts.
 * 4. Anything not covered fails closed and requires a delta approval.
 */
export function authorizeBundleOperation(input: AuthorizeBundleOperationInput): BundleAuthorizationVerdict {
  // `policy` is intentionally not consulted here: `evaluatePolicy` is the same pure
  // function the engine wraps, so using it directly keeps this check usable from any
  // caller without constructing an engine.
  const { store, workItem, action, actor } = input;
  const now = input.now ?? new Date();
  const decision: PolicyDecision = evaluatePolicy(policyContextFromAction(workItem, action, actor, "claim"));

  if (decision.decision === "deny") {
    return {
      allowed: false,
      reason: "policy_denied",
      code: "bundle_operation_policy_denied",
      matchedRules: decision.matchedRules
    };
  }

  if (decision.decision === "allow") {
    return { allowed: true, reason: "policy_allows_without_approval" };
  }

  const strategy = resolveStrategy(store, now);
  if (strategy === "POLICY_AUTONOMOUS") {
    // Only reached when policy said require_approval... so this cannot auto-allow.
    // POLICY_AUTONOMOUS means "an explicit policy allow suffices", which is handled
    // above. Anything still requiring approval needs a human.
    return {
      allowed: false,
      reason: "approval_not_required",
      code: "bundle_human_approval_required",
      matchedRules: decision.matchedRules
    };
  }

  const actionHash = actionFingerprint(policyContextFromAction(workItem, action, actor, "claim"));
  const grants = store.listApprovalBundleGrants(
    input.bundleId ? { bundleId: input.bundleId, workItemId: workItem.id } : { workItemId: workItem.id }
  );
  const coverage = activeGrantCovers(
    grants,
    {
      workItemId: workItem.id,
      actionHash,
      ...(input.observedBaseState ? { observedBaseState: input.observedBaseState } : {})
    },
    now
  );

  if (coverage.covered) {
    // A bundle grant is a pointer, never the authority itself. The authoritative
    // `execution_plan_approvals` row is re-checked here, at the point of use, because it
    // can be invalidated or expired by a path that knows nothing about bundles (per-action
    // revocation, plan replacement, expiry sweep). Without this check a revoked approval
    // would keep authorizing privileged work through the bundle that referenced it.
    const underlying = store.getExecutionPlanApprovalById(coverage.grant.approvalId);
    if (
      !underlying ||
      underlying.status !== "granted" ||
      Date.parse(underlying.expiresAt) <= now.getTime() ||
      underlying.workItemId !== coverage.grant.workItemId ||
      underlying.actionHash !== coverage.grant.actionHash ||
      underlying.planHash !== coverage.grant.planHash ||
      underlying.approvedByActorId !== coverage.grant.approvedByActorId ||
      underlying.expiresAt !== coverage.grant.expiresAt ||
      !grantStillMatchesBundle(store, coverage.grant, workItem.id, now)
    ) {
      return {
        allowed: false,
        reason: "delta_approval_required",
        code: "bundle_underlying_approval_invalid",
        matchedRules: decision.matchedRules,
        coverageReason: "underlying_approval_not_valid"
      };
    }
    return {
      allowed: true,
      reason: "covered_by_approved_bundle",
      grant: coverage.grant,
      manifestHash: coverage.grant.manifestHash
    };
  }

  // A MISS is an observable, auditable event: this is the delta-approval trigger.
  return {
    allowed: false,
    reason: "delta_approval_required",
    code: "bundle_authorization_miss",
    matchedRules: decision.matchedRules,
    coverageReason: coverage.reason
  };
}

/**
 * Read the active strategy, failing closed to `PER_ACTION`.
 *
 * `PER_ACTION` is the pre-bundle behaviour, so an unreadable or missing strategy can
 * only ever produce more human approval, never less.
 */
export function resolveStrategy(store: WorkItemStore, _now: Date = new Date()): ApprovalStrategy {
  try {
    const parsed = approvalStrategySchema.safeParse(store.getApprovalStrategy().strategy);
    return parsed.success ? parsed.data : "PER_ACTION";
  } catch {
    return "PER_ACTION";
  }
}

/**
 * Build the next revision that would cover this operation, i.e. the delta approval
 * the caller must request after a miss.
 */
export function buildDeltaRevision(
  bundle: ApprovalBundle,
  workItem: WorkItem,
  operation: { id: string; action: ActionRequest; target: string; summary: string; risk: ProposedChange["risk"] },
  now: Date = new Date()
): { revision: ApprovalBundleRevision; delta: ApprovalDelta } {
  const context = policyContextFromAction(workItem, operation.action, workItem.requester, "claim");
  const change: ProposedChange = {
    id: operation.id,
    type: changeTypeFor(operation.action),
    summary: operation.action.description,
    target: primaryTarget(context),
    action: {
      kind: operation.action.kind,
      description: operation.action.description,
      params: { ...operation.action.params }
    },
    actionHash: actionFingerprint(context),
    risk: context.risk,
    ...(context.command ? { command: [...context.command] } : {}),
    ...(context.cwd ? { cwd: context.cwd } : {}),
    ...(context.paths ? { paths: [...context.paths] } : {}),
    destructive: context.destructive === true,
    network: context.network === true,
    dependsOn: []
  };
  const next = reviseApprovalBundle(bundle, {
    bundleId: bundle.bundleId,
    expectedRevision: bundle.revision,
    changes: [...bundle.changes, change],
    rationale: `${bundle.rationale}\n\nDiscovered during execution: ${operation.summary}`,
    createdByActorId: bundle.agentId,
    now
  });
  return { revision: next, delta: approvalDelta(bundle, next) };
}

export { overallBundleRisk };

// Re-exported so API layers that already depend on Policy Gate can compute a delta for
// display without taking a second dependency on the domain package.
export { approvalDelta };
