/**
 * Approvals and execution read models, plus the operator-control eligibility table.
 * The browser never decides authority: `viewer` only decides whether a control is
 * *offered*. The gateway re-checks credential, scope, role, state and policy on every POST.
 */
import { z } from "zod";
import { admissionSchema, telemetrySchema } from "./overview.js";
import type { Parsed } from "./queue-trace.js";

const iso = z.string().min(1);
const risk = z.string().min(1).max(32);

export const viewerSchema = z
  .object({
    /** False unless the credential holds an operator/service role AND the acs:approve scope. */
    canApprove: z.boolean(),
    /** False unless the credential holds an operator/service role AND the acs:write scope. */
    canWrite: z.boolean()
  })
  .strict();

export const approvalActionSchema = z
  .object({ actionHash: z.string().min(1).max(256), kind: z.string().max(100), description: z.string().max(300) })
  .strict();

export const approvalItemSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().max(300),
    intent: z.string().max(500),
    status: z.enum(["needs_approval", "blocked"]),
    risk,
    requester: z.string().max(100).optional(),
    since: iso,
    overSla: z.boolean(),
    /** One entry per policy-gated action; empty for blocked items and when hashes are unavailable. */
    actions: z.array(approvalActionSchema).max(32)
  })
  .strict();

export const approvalsReadModelSchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: iso,
    viewer: viewerSchema,
    slaMs: z.number().int().positive(),
    items: z.array(approvalItemSchema).max(500)
  })
  .strict();

export const executionAttemptRowSchema = z
  .object({
    attemptId: z.string().min(1),
    workItemId: z.string().min(1),
    title: z.string().max(300),
    workItemStatus: z.string().min(1),
    risk,
    attemptNumber: z.number().int().positive(),
    status: z.string().min(1),
    workerId: z.string().max(200).optional(),
    fencingEpoch: z.number().int().nonnegative(),
    lease: z.object({ status: z.string().min(1), expiresAt: iso, expiringSoon: z.boolean() }).strict().optional(),
    startedAt: iso.optional(),
    updatedAt: iso,
    durationMs: z.number().nonnegative().optional()
  })
  .strict();

export const executionReadModelSchema = z
  .object({
    schemaVersion: z.literal(1),
    generatedAt: iso,
    viewer: viewerSchema,
    summary: z
      .object({
        running: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        attention: z.number().int().nonnegative(),
        expiringLeases: z.number().int().nonnegative()
      })
      .strict(),
    attempts: z.array(executionAttemptRowSchema).max(300),
    telemetry: telemetrySchema.nullable(),
    admission: admissionSchema.nullable(),
    dryRun: z.enum(["yes", "no", "unknown"])
  })
  .strict();

export type Viewer = z.infer<typeof viewerSchema>;
export type ApprovalItem = z.infer<typeof approvalItemSchema>;
export type ApprovalsReadModel = z.infer<typeof approvalsReadModelSchema>;
export type ExecutionAttemptRow = z.infer<typeof executionAttemptRowSchema>;
export type ExecutionReadModel = z.infer<typeof executionReadModelSchema>;

function parseWith<T>(schema: z.ZodType<T>, input: unknown): Parsed<T> {
  const r = schema.safeParse(input);
  if (r.success) return { ok: true, value: r.data };
  return { ok: false, reason: `schema_invalid:${r.error.issues[0]?.path.join(".") ?? ""}` };
}
export const parseApprovalsReadModel = (input: unknown) => parseWith(approvalsReadModelSchema, input);
export const parseExecutionReadModel = (input: unknown) => parseWith(executionReadModelSchema, input);

/**
 * Which controls are *offered* for a status. Mirrors the gateway/state machine and the
 * classic console's table; the gateway still enforces every rule. Kept in the contract
 * so the SPA and the classic console cannot drift (a test compares both tables).
 */
export type WorkItemControl = "cancel" | "retry" | "clone";
export const WORK_ITEM_CONTROL_STATUSES: Readonly<Record<WorkItemControl, readonly string[]>> = {
  cancel: ["draft", "pending_policy", "needs_approval", "approved", "running", "blocked"],
  retry: ["succeeded", "failed", "cancelled", "rejected"],
  clone: ["*"]
};
export function controlOffered(control: WorkItemControl, status: string): boolean {
  const statuses = WORK_ITEM_CONTROL_STATUSES[control];
  return statuses.includes("*") || statuses.includes(status);
}
