import { z } from "zod";

const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

export const supervisorDecisionSchema = z.enum(["continue", "redirect", "pause", "escalate"]);
export type SupervisorDecision = z.infer<typeof supervisorDecisionSchema>;

export const codingAgentCheckpointSchema = z
  .object({
    runId: identifierSchema,
    sequence: z.number().int().nonnegative(),
    phase: z.enum(["planning", "executing", "reviewing", "verifying"]),
    task: z.string().min(1).max(64_000),
    plan: z.string().max(64_000).optional(),
    filesTouched: z.array(z.string().min(1)).max(10_000),
    commands: z.array(z.string().min(1).max(16_000)).max(10_000),
    testSummary: z
      .object({
        passed: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        skipped: z.number().int().nonnegative()
      })
      .strict()
      .optional(),
    diff: z.string().max(2_000_000).optional(),
    errorLog: z.string().max(1_000_000).optional(),
    riskFlags: z.array(identifierSchema).max(1_000),
    elapsedMs: z.number().int().nonnegative(),
    tokenUsage: z.number().int().nonnegative().optional(),
    branch: z.string().min(1),
    worktreeDirty: z.boolean()
  })
  .strict();

export type CodingAgentCheckpoint = z.infer<typeof codingAgentCheckpointSchema>;

export const supervisorDirectiveSchema = z
  .object({
    decision: supervisorDecisionSchema,
    issue: z.string().max(32_000).optional(),
    correction: z.string().max(64_000).optional(),
    requiredEvidence: z.array(z.enum(["diff", "tests", "build", "runtime", "git_status"])).max(5),
    policyReasons: z.array(identifierSchema).max(1_000)
  })
  .strict()
  .superRefine((directive, context) => {
    if (directive.decision === "redirect" && !directive.correction) {
      context.addIssue({
        code: "custom",
        path: ["correction"],
        message: "redirect decisions require a bounded correction"
      });
    }
    if ((directive.decision === "pause" || directive.decision === "escalate") && !directive.issue) {
      context.addIssue({
        code: "custom",
        path: ["issue"],
        message: `${directive.decision} decisions require an issue`
      });
    }
  });

export type SupervisorDirective = z.infer<typeof supervisorDirectiveSchema>;

/**
 * A bounded control channel for coding agents that expose checkpoint and
 * correction capabilities. This contract does not grant shell authority.
 * Implementations must route all execution through existing ACS policy,
 * sandbox, lease, and evidence boundaries.
 */
export interface CodingAgentAdapter {
  readonly id: string;
  startTask(task: { task: string; workspacePath: string }, signal?: AbortSignal): Promise<string>;
  sendCorrection(runId: string, directive: SupervisorDirective, signal?: AbortSignal): Promise<void>;
  pause(runId: string, signal?: AbortSignal): Promise<void>;
  getCheckpoint(runId: string, signal?: AbortSignal): Promise<CodingAgentCheckpoint>;
}

/** Reviews checkpoints only. It cannot execute commands or mutate a workspace. */
export interface CodingAgentSupervisor {
  review(checkpoint: CodingAgentCheckpoint, signal?: AbortSignal): Promise<SupervisorDirective>;
}
