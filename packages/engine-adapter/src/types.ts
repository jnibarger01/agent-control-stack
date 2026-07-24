import { engineEgressAllowlistSchema, engineCredentialSchema, sandboxLimitsSchema } from "@agent-control-stack/sandbox";
import { z } from "zod";

const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/u);

/**
 * Everything EngineIsolationBackend needs to bind this invocation to a
 * persisted authority record (ADR 0014) - the same field set as
 * packages/sandbox's SandboxExecutionRequest/EngineIsolationRequest, not a
 * caller-chosen subset. A caller that cannot supply these has not actually
 * authorized the invocation; there is no "trust me" path.
 */
export const engineTaskSchema = z
  .object({
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
        hostPath: z.string().min(1)
      })
      .strict(),
    prompt: z.string().min(1).max(64_000),
    egressAllowlist: engineEgressAllowlistSchema,
    credential: engineCredentialSchema.optional(),
    limits: sandboxLimitsSchema
  })
  .strict();

export type EngineTask = z.infer<typeof engineTaskSchema>;

export const engineOutcomeSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("completed"),
      exitCode: z.number().int(),
      stdout: z.string(),
      stderr: z.string(),
      durationMs: z.number().int().nonnegative(),
      stdoutTruncated: z.boolean(),
      stderrTruncated: z.boolean()
    })
    .strict(),
  z
    .object({
      status: z.literal("timeout"),
      durationMs: z.number().int().nonnegative()
    })
    .strict(),
  z
    .object({
      status: z.literal("cancelled"),
      durationMs: z.number().int().nonnegative()
    })
    .strict(),
  z
    .object({
      status: z.literal("process_error"),
      message: z.string()
    })
    .strict()
]);

export type EngineOutcome = z.infer<typeof engineOutcomeSchema>;

/**
 * A model-backed coding-agent CLI, normalized behind one interface.
 *
 * invoke() returns a single terminal outcome, not a stream of granular
 * tool_call_request events - most agentic CLIs (Codex's `exec` mode
 * included) run to completion as one opaque process, deciding and running
 * their own tool calls internally under their own permission model. This
 * adapter does not intercept those internal calls; containment comes from
 * packages/sandbox's EngineIsolationBackend (ADR 0014) - an authority-bound
 * workspace mount, a private HOME, single-credential injection, and
 * scoped network egress through an audited proxy, not from the working
 * directory or an environment allowlist alone. CommandBroker separately
 * re-gates anything the resulting change needs to have executed against it
 * (build/test/lint) through real policy evaluation before it runs. A future
 * engine whose CLI exposes a real per-call streaming protocol could
 * implement a richer interface; this one does not claim visibility it
 * doesn't have.
 */
export interface EngineAdapter {
  readonly id: string;
  invoke(task: EngineTask, signal?: AbortSignal): Promise<EngineOutcome>;
}
