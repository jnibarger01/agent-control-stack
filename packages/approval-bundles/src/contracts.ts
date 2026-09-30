import { z } from "zod";

/**
 * Approval Bundle / change-set contracts.
 *
 * A bundle is a *review artifact*. It is not an authority: authority still comes
 * exclusively from the `execution_plan_approvals` rows that a bundle decision mints,
 * bound to an action hash and a plan hash. See
 * `docs/protocol/approval-bundles.md` for why the bundle deliberately holds no
 * authority of its own.
 */

export const APPROVAL_BUNDLE_SCHEMA_VERSION = "acs.approval-bundle.v1" as const;

export const identifierSchema = z.string().min(1).max(200);
export const hashSchema = z
  .string()
  .length(64)
  .regex(/^[a-f0-9]{64}$/);
export const timestampSchema = z.string().datetime({ offset: true });

/** Coarse ordering only. Fine-grained risk stays with Policy Gate. */
export const bundleRiskLevelSchema = z.enum(["low", "medium", "high", "critical"]);

export const proposedChangeTypeSchema = z.enum([
  "file_write",
  "command",
  "service_restart",
  "service_control",
  "deployment",
  "config_change",
  "external_write",
  "destructive_action",
  "other_privileged_action"
]);

/**
 * The requested action exactly as Policy Gate will fingerprint it. `params`,
 * `command`, `cwd` and `paths` are the authorization-relevant inputs of
 * `actionFingerprint`, so a change is only ever authorized as this precise shape.
 */
export const proposedChangeActionSchema = z
  .object({
    kind: z.string().min(1).max(200),
    description: z.string().min(1).max(4_000),
    params: z.record(z.string(), z.unknown()).default({})
  })
  .strict();

export const proposedChangeSchema = z
  .object({
    id: identifierSchema,
    type: proposedChangeTypeSchema,
    summary: z.string().min(1).max(1_000),
    /** Human-readable target: a file path, service name, host, repo or endpoint. */
    target: z.string().min(1).max(2_000),
    action: proposedChangeActionSchema,
    /**
     * The Policy Gate `actionFingerprint` for this change's action.
     *
     * Required rather than derived here because `work-items` cannot import
     * `policy-gate` (the dependency runs the other way). Policy Gate is the only
     * producer, and the authorization path recomputes the fingerprint from the live
     * operation rather than trusting this stored value, so a wrong value here cannot
     * widen what may execute. Recording it in the manifest is still correct: the
     * fingerprint is part of what the reviewer is approving.
     */
    actionHash: hashSchema,
    /** Present when the change is a command; kept explicit for the review UI. */
    command: z.array(z.string().min(1).max(4_000)).max(512).optional(),
    cwd: z.string().min(1).max(2_000).optional(),
    paths: z.array(z.string().min(1).max(2_000)).max(512).optional(),
    risk: bundleRiskLevelSchema,
    destructive: z.boolean().default(false),
    network: z.boolean().default(false),
    /** Ids of other changes in the same bundle that must be approved first. */
    dependsOn: z.array(identifierSchema).max(64).default([]),
    metadata: z.record(z.string(), z.unknown()).optional()
  })
  .strict();

export type ProposedChange = z.infer<typeof proposedChangeSchema>;

export const approvalBundleScopeSchema = z
  .object({
    files: z.array(z.string().min(1).max(2_000)).max(512).optional(),
    repos: z.array(z.string().min(1).max(512)).max(64).optional(),
    services: z.array(z.string().min(1).max(512)).max(256).optional(),
    tools: z.array(z.string().min(1).max(256)).max(256).optional(),
    hosts: z.array(z.string().min(1).max(512)).max(64).optional()
  })
  .strict();

export type ApprovalBundleScope = z.infer<typeof approvalBundleScopeSchema>;

/**
 * TOCTOU anchor. A revision may only be executed while the observed base state
 * still matches what the reviewer saw.
 */
export const approvalBundleBaseStateSchema = z
  .object({
    gitSha: z.string().min(1).max(200).optional(),
    configHash: hashSchema.optional()
  })
  .strict();

export type ApprovalBundleBaseState = z.infer<typeof approvalBundleBaseStateSchema>;

export const riskFindingSchema = z
  .object({
    code: z.string().min(1).max(200),
    severity: bundleRiskLevelSchema,
    detail: z.string().min(1).max(2_000),
    changeId: identifierSchema.optional()
  })
  .strict();

export type RiskFinding = z.infer<typeof riskFindingSchema>;

export const approvalBundleStatusSchema = z.enum([
  "draft",
  "pending",
  "approved",
  "partially_approved",
  "rejected",
  "modified",
  "invalidated",
  "executing",
  "completed",
  "failed"
]);

export type ApprovalBundleStatus = z.infer<typeof approvalBundleStatusSchema>;

export const approvalDecisionKindSchema = z.enum(["approve_all", "approve_selected", "reject", "invalidate"]);

export type ApprovalDecisionKind = z.infer<typeof approvalDecisionKindSchema>;

export const approvalDecisionSchema = z
  .object({
    id: identifierSchema,
    revision: z.number().int().positive(),
    kind: approvalDecisionKindSchema,
    approvedByActorId: z.string().min(1).max(256),
    reason: z.string().min(1).max(2_000),
    /** Change ids this decision granted. Empty for reject/invalidate. */
    changeIds: z.array(identifierSchema).max(512),
    manifestHash: hashSchema,
    decidedAt: timestampSchema
  })
  .strict();

export type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;

/**
 * The persisted, immutable head record for one bundle revision.
 *
 * `manifestHash` is the hash of the canonical manifest and is what an authorization
 * grant is bound to. `parentManifestHash` chains revisions.
 */
export const approvalBundleRevisionSchema = z
  .object({
    bundleId: identifierSchema,
    missionId: identifierSchema,
    executionId: identifierSchema,
    agentId: identifierSchema,
    title: z.string().min(1).max(500),
    rationale: z.string().min(1).max(8_000),
    revision: z.number().int().positive(),
    changes: z.array(proposedChangeSchema).max(512),
    scope: approvalBundleScopeSchema,
    baseState: approvalBundleBaseStateSchema,
    parentManifestHash: hashSchema.optional(),
    manifestHash: hashSchema,
    status: approvalBundleStatusSchema,
    createdAt: timestampSchema,
    createdByActorId: z.string().min(1).max(256),
    expiresAt: timestampSchema.optional()
  })
  .strict();

export type ApprovalBundleRevision = z.infer<typeof approvalBundleRevisionSchema>;

/** A bundle plus its decision history, as returned by the API and rendered by Mission Control. */
export const approvalBundleSchema = approvalBundleRevisionSchema.extend({
  approvals: z.array(approvalDecisionSchema).default([])
});

export type ApprovalBundle = z.infer<typeof approvalBundleSchema>;

/** Highest risk across all changes, used when a caller does not supply one. */
export function overallBundleRisk(
  changes: readonly Pick<ProposedChange, "risk">[]
): z.infer<typeof bundleRiskLevelSchema> {
  const rank: Record<z.infer<typeof bundleRiskLevelSchema>, number> = {
    low: 0,
    medium: 1,
    high: 2,
    critical: 3
  };
  let overall: z.infer<typeof bundleRiskLevelSchema> = "low";
  for (const change of changes) {
    if (rank[change.risk] > rank[overall]) {
      overall = change.risk;
    }
  }
  return overall;
}
