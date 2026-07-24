import { isAbsolute, normalize } from "node:path";
import { z } from "zod";

export const sandboxCommandProfiles = [
  "npm-test",
  "npm-lint",
  "npm-build",
  "npm-typecheck",
  "git-status",
  "git-diff-check"
] as const;

export const sandboxEnvironmentNames = ["CI", "LANG", "LC_ALL", "NO_COLOR", "TERM", "TZ"] as const;

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
const environmentValueSchema = z
  .string()
  .max(4_096)
  .refine((value) => !/[\0\r\n]/u.test(value), "environment values must not contain control separators");
const sandboxEnvironmentSchema = z
  .record(z.string().min(1).max(64), environmentValueSchema)
  .superRefine((value, context) => {
    const allowed = new Set<string>(sandboxEnvironmentNames);
    for (const name of Object.keys(value)) {
      if (!allowed.has(name)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message: `environment variable is not allowlisted: ${name}`
        });
      }
    }
  });

export const sandboxLimitsSchema = z
  .object({
    wallClockMs: z
      .number()
      .int()
      .min(100)
      .max(15 * 60 * 1_000),
    terminationGraceMs: z.number().int().min(10).max(5_000),
    cpuQuotaPercent: z.number().int().min(1).max(100),
    memoryBytes: z
      .number()
      .int()
      .min(32 * 1_024 * 1_024)
      .max(8 * 1_024 * 1_024 * 1_024),
    pids: z.number().int().min(8).max(512),
    outputBytes: z
      .number()
      .int()
      .min(1_024)
      .max(1_024 * 1_024),
    tmpfsBytes: z
      .number()
      .int()
      .min(1 * 1_024 * 1_024)
      .max(1 * 1_024 * 1_024 * 1_024)
  })
  .strict();

export const sandboxExecutionRequestSchema = z
  .object({
    schemaVersion: z.literal("acs.sandbox-execution.v1"),
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
    commandProfile: z.enum(sandboxCommandProfiles),
    cwd: relativeWorkingDirectorySchema,
    environment: sandboxEnvironmentSchema.default({}),
    network: z.literal("none"),
    limits: sandboxLimitsSchema
  })
  .strict();

export const sandboxAuthorityReceiptSchema = z
  .object({
    schemaVersion: z.literal("acs.sandbox-authority-receipt.v1"),
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

export const sandboxExecutionObservationSchema = z
  .object({
    schemaVersion: z.literal("acs.sandbox-observation.v1"),
    executionMode: z.literal("live"),
    backend: z.literal("bubblewrap-systemd-v1"),
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

export type SandboxCommandProfile = (typeof sandboxCommandProfiles)[number];
export type SandboxExecutionRequest = z.infer<typeof sandboxExecutionRequestSchema>;
export type SandboxAuthorityReceipt = z.infer<typeof sandboxAuthorityReceiptSchema>;
export type SandboxExecutionObservation = z.infer<typeof sandboxExecutionObservationSchema>;

export interface SandboxAuthorityVerifier {
  verify(request: SandboxExecutionRequest): Promise<SandboxAuthorityReceipt>;
}

export interface SandboxExecuteOptions {
  signal?: AbortSignal;
}

export interface SandboxBackend {
  readonly name: "bubblewrap-systemd-v1";
  preflight(input: unknown): Promise<void>;
  execute(input: unknown, options?: SandboxExecuteOptions): Promise<SandboxExecutionObservation>;
}
