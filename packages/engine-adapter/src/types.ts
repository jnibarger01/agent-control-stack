import { z } from "zod";

const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

export const engineTaskSchema = z
  .object({
    workItemId: identifierSchema,
    prompt: z.string().min(1).max(64_000),
    workspaceHostPath: z.string().min(1),
    timeoutMs: z
      .number()
      .int()
      .min(100)
      .max(15 * 60 * 1_000),
    maxOutputBytes: z
      .number()
      .int()
      .min(1_024)
      .max(8 * 1_024 * 1_024)
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
 * running the whole process inside a scoped workspace with an allowlisted
 * environment (see env.ts), and from CommandBroker re-gating anything the
 * resulting change needs to have executed against it (build/test/lint)
 * through real policy evaluation before it runs. A future engine whose CLI
 * exposes a real per-call streaming protocol could implement a richer
 * interface; this one does not claim visibility it doesn't have.
 */
export interface EngineAdapter {
  readonly id: string;
  invoke(task: EngineTask, signal?: AbortSignal): Promise<EngineOutcome>;
}
