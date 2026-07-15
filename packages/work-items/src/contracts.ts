import { isAbsolute } from "node:path";
import { canonicalJson, domainHash } from "@agent-control-stack/shared";
import { z } from "zod";

const safeIdSchema = z.string().min(6).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const shortIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:@/-]+$/);
const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);
const nonceSchema = z.string().min(22).max(256).regex(/^[A-Za-z0-9._~+-]+$/);
const isoTimestampSchema = z
  .string()
  .min(20)
  .max(35)
  .refine((value) => !Number.isNaN(Date.parse(value)), "invalid ISO timestamp");
const boundedTextSchema = z.string().min(1).max(1_000);
const safePathSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => !value.split(/[\\/]+/).includes(".."), "path must not contain parent traversal");
const absolutePathSchema = safePathSchema.refine((value) => isAbsolute(value), "path must be absolute");
const jsonObjectSchema = z
  .record(z.string(), z.json())
  .superRefine((value, context) => {
    if (Buffer.byteLength(canonicalJson(value), "utf8") > 65_536) {
      context.addIssue({ code: "custom", message: "JSON object exceeds 65536 canonical bytes" });
    }
  });

export const missionRiskClaimSchema = z.enum(["read_only", "draft", "write", "destructive", "unknown"]);
export const missionTaskTypeSchema = z.enum([
  "coding",
  "research",
  "memory_lookup",
  "browser_scrape",
  "deal_analysis",
  "system_admin",
  "unknown",
]);

export const legacyProvenanceClaimSchema = z
  .object({
    schemaVersion: z.literal("acs.legacy-provenance-claim.v1"),
    sourceSystem: z.literal("mission-router"),
    sourceVersion: z.string().min(1).max(64),
    sourceMissionId: z.string().uuid(),
    sourceEnvelopeVersion: z.literal(1),
    sourceEnvelopeHash: sha256HexSchema,
    sourceTraceHeadHash: sha256HexSchema.optional(),
    sourceRunId: safeIdSchema.optional(),
    verification: z.literal("unverified"),
  })
  .strict();

export const legacyProvenanceRecordSchema = legacyProvenanceClaimSchema
  .omit({ schemaVersion: true, verification: true })
  .extend({
    schemaVersion: z.literal("acs.legacy-provenance.v1"),
    verification: z.enum(["verified", "unverified"]),
    importedAt: isoTimestampSchema,
    importedByActorId: shortIdSchema,
  })
  .strict();

const proposedActionSchema = z
  .object({
    clientActionId: safeIdSchema,
    kind: z.string().min(1).max(64).regex(/^[A-Za-z0-9._:-]+$/),
    description: boundedTextSchema,
    params: jsonObjectSchema,
  })
  .strict();

export const missionIntakeSchema = z
  .object({
    schemaVersion: z.literal("acs.mission-intake.v1"),
    requestId: safeIdSchema,
    title: z.string().min(1).max(200),
    goal: z.string().min(1).max(8_000),
    origin: z.enum(["cli", "telegram", "imessage", "dashboard", "openclaw", "hermes", "api"]),
    target: z
      .object({
        repo: z.string().min(1).max(512).optional(),
        cwd: absolutePathSchema.optional(),
        files: z.array(safePathSchema).max(64),
      })
      .strict(),
    proposedActions: z.array(proposedActionSchema).min(1).max(64),
    constraints: z
      .object({
        network: z.enum(["none", "declared"]),
        maxRuntimeMs: z.number().int().min(1).max(86_400_000),
        successCriteria: z.array(z.string().min(1).max(1_000)).max(32),
        rollbackPlan: jsonObjectSchema.optional(),
      })
      .strict(),
    submittedClaims: z
      .object({
        taskType: missionTaskTypeSchema.optional(),
        risk: missionRiskClaimSchema.optional(),
        approvalRequested: z.boolean().optional(),
      })
      .strict()
      .optional(),
    legacyProvenance: legacyProvenanceClaimSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set<string>();
    value.proposedActions.forEach((action, index) => {
      if (ids.has(action.clientActionId)) {
        context.addIssue({ code: "custom", path: ["proposedActions", index, "clientActionId"], message: "duplicate clientActionId" });
      }
      ids.add(action.clientActionId);
    });
  });

const evidenceSignalSchema = z
  .object({
    ruleId: z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/),
    matchedTextHash: sha256HexSchema.optional(),
  })
  .strict();

export const classifierEvidenceSchema = z
  .object({
    schemaVersion: z.literal("acs.classifier-evidence.v1"),
    evidenceId: safeIdSchema,
    classifier: z
      .object({
        id: z.string().min(1).max(128),
        version: z.string().min(1).max(64),
      })
      .strict(),
    subjectIntakeHash: sha256HexSchema,
    generatedAt: isoTimestampSchema,
    taskType: z
      .object({
        recommendation: missionTaskTypeSchema,
        confidence: z.number().min(0).max(1).optional(),
        signals: z.array(evidenceSignalSchema).max(64),
      })
      .strict(),
    risk: z
      .object({
        recommendation: missionRiskClaimSchema,
        confidence: z.number().min(0).max(1).optional(),
        signals: z.array(evidenceSignalSchema).max(64),
      })
      .strict(),
    sensitivity: z
      .object({
        categories: z.array(z.string().min(1).max(64)).max(32),
        signals: z.array(evidenceSignalSchema).max(64),
      })
      .strict(),
    authoritative: z.literal(false),
  })
  .strict();

const canonicalActionSchema = z
  .object({
    actionId: safeIdSchema,
    kind: z.string().min(1).max(64).regex(/^[A-Za-z0-9._:-]+$/),
    description: boundedTextSchema,
    arguments: jsonObjectSchema,
    cwd: absolutePathSchema.optional(),
    normalizedPaths: z.array(absolutePathSchema).max(64).optional(),
    argv: z.array(z.string().max(8_192)).max(256).optional(),
    effects: z
      .object({ network: z.boolean(), write: z.boolean(), destructive: z.boolean() })
      .strict(),
    timeoutMs: z.number().int().min(1).max(86_400_000),
    rollback: jsonObjectSchema.optional(),
  })
  .strict();

export const actionManifestSchema = z
  .object({
    schemaVersion: z.literal("acs.action-manifest.v1"),
    workItemId: safeIdSchema,
    intakeHash: sha256HexSchema,
    requesterActorId: shortIdSchema,
    policyVersion: z.string().min(1).max(128),
    nonce: nonceSchema,
    createdAt: isoTimestampSchema,
    actions: z.array(canonicalActionSchema).min(1).max(64),
  })
  .strict()
  .superRefine((value, context) => {
    const ids = new Set<string>();
    value.actions.forEach((action, index) => {
      if (ids.has(action.actionId)) {
        context.addIssue({ code: "custom", path: ["actions", index, "actionId"], message: "duplicate actionId" });
      }
      ids.add(action.actionId);
    });
  });

export const approvalBindingSchema = z
  .object({
    schemaVersion: z.literal("acs.approval-binding.v1"),
    approvalRequestId: safeIdSchema,
    workItemId: safeIdSchema,
    manifestHash: sha256HexSchema,
    actionId: safeIdSchema,
    actionHash: sha256HexSchema,
    policyVersion: z.string().min(1).max(128),
    policyDecisionHash: sha256HexSchema,
    requesterActorId: shortIdSchema,
    nonce: nonceSchema,
    createdAt: isoTimestampSchema,
    expiresAt: isoTimestampSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.expiresAt) <= Date.parse(value.createdAt)) {
      context.addIssue({ code: "custom", path: ["expiresAt"], message: "approval expiry must be after creation" });
    }
  });

export const approvalGrantSchema = z
  .object({
    schemaVersion: z.literal("acs.approval-grant.v1"),
    requestHash: sha256HexSchema,
    approverActorId: shortIdSchema,
    decision: z.literal("approved"),
    reason: z.string().min(1).max(1_000).optional(),
    grantedAt: isoTimestampSchema,
    expiresAt: isoTimestampSchema,
    status: z.enum(["granted", "consumed", "expired"]),
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.expiresAt) <= Date.parse(value.grantedAt)) {
      context.addIssue({ code: "custom", path: ["expiresAt"], message: "grant expiry must be after creation" });
    }
  });

export const idempotencyRecordSchema = z
  .object({
    schemaVersion: z.literal("acs.idempotency.v1"),
    actorId: shortIdSchema,
    operation: z.literal("mission_intake"),
    key: safeIdSchema,
    requestHash: sha256HexSchema,
    state: z.enum(["in_progress", "completed", "failed"]),
    workItemId: safeIdSchema.optional(),
    responseHash: sha256HexSchema.optional(),
    createdAt: isoTimestampSchema,
    completedAt: isoTimestampSchema.optional(),
  })
  .strict();

const traceIdSchema = z.string().regex(/^[a-f0-9]{32}$/);
const spanIdSchema = z.string().regex(/^[a-f0-9]{16}$/);
export const traceCorrelationSchema = z
  .object({
    schemaVersion: z.literal("acs.trace-correlation.v1"),
    traceId: traceIdSchema,
    rootSpanId: spanIdSchema,
    requestId: safeIdSchema,
    sessionId: safeIdSchema.optional(),
    parent: z
      .object({ traceId: traceIdSchema, spanId: spanIdSchema, source: z.string().min(1).max(128) })
      .strict()
      .optional(),
  })
  .strict();

export type MissionIntake = z.infer<typeof missionIntakeSchema>;
export type ClassifierEvidence = z.infer<typeof classifierEvidenceSchema>;
export type ActionManifest = z.infer<typeof actionManifestSchema>;
export type ApprovalBinding = z.infer<typeof approvalBindingSchema>;
export type CanonicalApprovalGrant = z.infer<typeof approvalGrantSchema>;
export type IdempotencyRecord = z.infer<typeof idempotencyRecordSchema>;
export type TraceCorrelation = z.infer<typeof traceCorrelationSchema>;

export function missionIntakeHash(input: unknown): string {
  return domainHash("acs:mission-intake:v1", missionIntakeSchema.parse(input));
}

export function classifierEvidenceHash(input: unknown): string {
  return domainHash("acs:classifier-evidence:v1", classifierEvidenceSchema.parse(input));
}

export function actionManifestHash(input: unknown): string {
  return domainHash("acs:action-manifest:v1", actionManifestSchema.parse(input));
}

export function approvalBindingHash(input: unknown): string {
  return domainHash("acs:approval-binding:v1", approvalBindingSchema.parse(input));
}

export function approvalGrantHash(input: unknown): string {
  return domainHash("acs:approval-grant:v1", approvalGrantSchema.parse(input));
}
