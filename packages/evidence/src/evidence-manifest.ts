import { domainHash } from "@agent-control-stack/shared";
import { sandboxProfileSchema, networkProfileSchema } from "@agent-control-stack/advisory";
import { z } from "zod";
import { observationSchema } from "./observation.js";

/**
 * `acs.evidence-manifest.v1` — an ACS-owned, content-addressed record of one
 * governed execution attempt, built ONLY from `EVIDENCE_AUTHORITY` data.
 *
 * A model-generated summary is never a field here. The canonical audit chain
 * records `evidence.manifest_recorded` carrying the exact `manifestHash`, and
 * every verification `Decision` references the exact manifest hash it used.
 */

export const EVIDENCE_MANIFEST_SCHEMA_VERSION = "acs.evidence-manifest.v1" as const;
export const EVIDENCE_MANIFEST_HASH_DOMAIN = "acs:evidence-manifest:v1" as const;

const hash64 = z.string().regex(/^[a-f0-9]{64}$/u);
const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

export const executedCommandEvidenceSchema = z
  .object({
    /** Executable base name only (never a full argv string). */
    executable: z.string().min(1).max(256),
    /** Hash of the canonicalised argv, so args are bound without being inlined. */
    argvHash: hash64,
    exitCode: z.number().int().min(-255).max(255).nullable(),
    stdoutHash: hash64,
    stderrHash: hash64,
    /** Bounded reference (e.g. an execution_results / validation_run id). */
    outputRef: z.string().min(1).max(256).optional(),
    durationMs: z.number().int().nonnegative().optional()
  })
  .strict();

export const testEvidenceSchema = z
  .object({
    /** validation_run id in packages/work-items, when present. */
    validationRunId: identifierSchema.optional(),
    passed: z.boolean(),
    checksPassed: z.number().int().nonnegative(),
    checksFailed: z.number().int().nonnegative()
  })
  .strict();

export const evidenceManifestSchema = z
  .object({
    schemaVersion: z.literal(EVIDENCE_MANIFEST_SCHEMA_VERSION),
    attemptId: identifierSchema,
    workItemId: identifierSchema,
    admittedPlanHash: hash64,
    planHash: hash64,
    actionHash: hash64,
    baseWorkspaceRevision: z.string().min(1).max(256),
    resultWorkspaceRevision: z.string().min(1).max(256),
    changedPaths: z.array(z.string().min(1).max(4_096)).max(10_000),
    diffHash: hash64,
    commands: z.array(executedCommandEvidenceSchema).max(256),
    testEvidence: testEvidenceSchema.nullable(),
    sandboxProfile: sandboxProfileSchema,
    networkProfile: networkProfileSchema,
    networkDecisions: z
      .object({ allowed: z.number().int().nonnegative(), denied: z.number().int().nonnegative() })
      .strict(),
    /** Additional machine observations, appended by the evidence collector. */
    observations: z.array(observationSchema).max(512).default([]),
    workerId: identifierSchema,
    startedAt: z.string().datetime({ offset: true }),
    finishedAt: z.string().datetime({ offset: true }),
    manifestHash: hash64
  })
  .strict();

export type EvidenceManifest = z.infer<typeof evidenceManifestSchema>;
export type ExecutedCommandEvidence = z.infer<typeof executedCommandEvidenceSchema>;
export type TestEvidence = z.infer<typeof testEvidenceSchema>;

export function evidenceManifestHash(input: Omit<EvidenceManifest, "manifestHash">): string {
  return domainHash(EVIDENCE_MANIFEST_HASH_DOMAIN, {
    schemaVersion: input.schemaVersion,
    attemptId: input.attemptId,
    workItemId: input.workItemId,
    admittedPlanHash: input.admittedPlanHash,
    planHash: input.planHash,
    actionHash: input.actionHash,
    baseWorkspaceRevision: input.baseWorkspaceRevision,
    resultWorkspaceRevision: input.resultWorkspaceRevision,
    changedPaths: [...input.changedPaths].sort(),
    diffHash: input.diffHash,
    commands: input.commands,
    testEvidence: input.testEvidence,
    sandboxProfile: input.sandboxProfile,
    networkProfile: input.networkProfile,
    networkDecisions: input.networkDecisions,
    observations: input.observations,
    workerId: input.workerId,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt
  });
}

export type BuildEvidenceManifestInput = Omit<EvidenceManifest, "schemaVersion" | "manifestHash">;

/** Assemble + content-address a manifest. Inputs must already be machine facts. */
export function buildEvidenceManifest(input: BuildEvidenceManifestInput): EvidenceManifest {
  const base = evidenceManifestSchema
    .omit({ manifestHash: true })
    .parse({ schemaVersion: EVIDENCE_MANIFEST_SCHEMA_VERSION, ...input });
  return evidenceManifestSchema.parse({ ...base, manifestHash: evidenceManifestHash(base) });
}

/** Content-address check: a manifest is immutable iff its hash matches its body. */
export function verifyEvidenceManifestHash(manifest: EvidenceManifest): boolean {
  const { manifestHash: stored, ...rest } = manifest;
  return evidenceManifestHash(rest) === stored;
}
