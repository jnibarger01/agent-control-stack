import { isAbsolute, normalize } from "node:path";
import { z } from "zod";
import { sandboxLimitsSchema } from "./contracts.js";

const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const absolutePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => isAbsolute(value), "path must be absolute")
  .refine((value) => normalize(value) === value, "path must be normalized")
  .refine((value) => !value.includes("\0"), "path must not contain NUL");
const relativeWorkingDirectorySchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine((value) => !isAbsolute(value), "working directory must be relative")
  .refine((value) => !value.includes("\\"), "working directory must use Linux path separators")
  .refine(
    (value) => value === "." || (!value.split("/").includes("..") && normalize(value) === value),
    "working directory must be normalized and contained"
  );

// One egress endpoint the isolation boundary will bridge to, and nothing
// else - see ADR 0014. Case-normalized so allowlist comparisons cannot be
// bypassed by a differently-cased Host header.
const egressHostSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/u, "must be a lowercase DNS name");

export const engineEgressAllowlistSchema = z
  .array(
    z
      .object({
        host: egressHostSchema,
        port: z.number().int().min(1).max(65_535)
      })
      .strict()
  )
  .min(1)
  .max(4);

// Exactly one named credential crosses the isolation boundary per
// invocation (ADR 0014's credential-delivery requirement). The value is
// intentionally typed as a plain string, not a redacted/branded type: it
// must never be written into an audit event, log line, or observation -
// engine.ts and its callers are responsible for keeping it out of anything
// persisted or returned.
const credentialNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Z][A-Z0-9_]*$/u, "credential env var name must be SCREAMING_SNAKE_CASE");
export const engineCredentialSchema = z
  .object({
    envName: credentialNameSchema,
    envValue: z.string().min(1).max(8_192)
  })
  .strict();

export const engineIsolationRequestSchema = z
  .object({
    schemaVersion: z.literal("acs.engine-isolation.v1"),
    workItemId: identifierSchema,
    attemptId: identifierSchema,
    leaseId: identifierSchema,
    workerId: identifierSchema,
    fencingToken: z.number().int().positive(),
    authorization: z
      .object({
        kind: z.enum(["action", "plan"]),
        hash: hashSchema
      })
      .strict(),
    policyVersion: identifierSchema,
    auditCorrelationId: identifierSchema,
    idempotencyKey: identifierSchema,
    workspace: z
      .object({
        allocationId: identifierSchema,
        hostPath: absolutePathSchema
      })
      .strict(),
    engineId: identifierSchema,
    executable: absolutePathSchema,
    args: z.array(z.string().max(4_096)).max(64),
    cwd: relativeWorkingDirectorySchema,
    stdin: z.string().max(1_024 * 1_024).optional(),
    credential: engineCredentialSchema.optional(),
    network: z.literal("scoped-egress"),
    egressAllowlist: engineEgressAllowlistSchema,
    limits: sandboxLimitsSchema
  })
  .strict();

export const engineIsolationAuthorityReceiptSchema = z
  .object({
    schemaVersion: z.literal("acs.engine-isolation-authority-receipt.v1"),
    workItemId: identifierSchema,
    attemptId: identifierSchema,
    leaseId: identifierSchema,
    workerId: identifierSchema,
    fencingToken: z.number().int().positive(),
    authorizationHash: hashSchema,
    policyVersion: identifierSchema,
    workspaceAllocationId: identifierSchema,
    canonicalWorkspacePath: absolutePathSchema,
    executionEvent: z
      .object({
        id: identifierSchema,
        sequence: z.number().int().positive(),
        hash: hashSchema
      })
      .strict()
  })
  .strict();

export const engineIsolationObservationSchema = z
  .object({
    schemaVersion: z.literal("acs.engine-isolation-observation.v1"),
    executionMode: z.literal("live"),
    backend: z.literal("engine-isolation-v1"),
    backendVersion: z.string().min(1).max(128),
    unitName: z.string().min(1).max(128),
    outcome: z.enum(["exited", "signaled", "timed_out", "cancelled", "launch_failed", "unknown"]),
    observedSuccess: z.boolean(),
    cleanup: z.enum(["verified", "failed", "unknown"]),
    exitCode: z.number().int().min(-255).max(255).nullable(),
    signal: z.string().min(1).max(32).optional(),
    stdout: z.string(),
    stderr: z.string(),
    stdoutTruncated: z.boolean(),
    stderrTruncated: z.boolean(),
    outputBytes: z.number().int().nonnegative(),
    startedAt: z.string().datetime({ offset: true }),
    finishedAt: z.string().datetime({ offset: true }),
    durationMs: z.number().int().nonnegative(),
    enforcedLimits: sandboxLimitsSchema,
    credentialInjected: z.string().max(64).optional(),
    egressAllowedCount: z.number().int().nonnegative(),
    egressDeniedCount: z.number().int().nonnegative(),
    egressDeniedSample: z.array(z.string().max(320)).max(10),
    error: z.string().min(1).max(4_096).optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.observedSuccess && (value.outcome !== "exited" || value.exitCode !== 0 || value.cleanup !== "verified")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["observedSuccess"],
        message: "success requires a known zero exit and verified cleanup"
      });
    }
    if (value.outcome !== "exited" && value.observedSuccess) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["outcome"],
        message: "only a known exit may be observed as successful"
      });
    }
  });

export type EngineIsolationRequest = z.infer<typeof engineIsolationRequestSchema>;
export type EngineIsolationAuthorityReceipt = z.infer<typeof engineIsolationAuthorityReceiptSchema>;
export type EngineIsolationObservation = z.infer<typeof engineIsolationObservationSchema>;
export type EngineEgressAllowlist = z.infer<typeof engineEgressAllowlistSchema>;

export interface EngineIsolationAuthorityVerifier {
  verify(request: EngineIsolationRequest): Promise<EngineIsolationAuthorityReceipt>;
}
