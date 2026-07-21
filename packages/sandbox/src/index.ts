import { assertExecutableWorkItem, type WorkItem } from "@agent-control-stack/work-items";
import { z } from "zod";
export { executeAgentSandboxed, runContainedReadonlyCommand, agentExecutionRequestSchema } from "./agent-executor.js";
export type {
  AgentExecutionRequest,
  AgentExecutorOptions,
  AgentSandboxResult,
  ContainedCommandInput,
  ContainedCommandResult
} from "./agent-executor.js";

export const sandboxResultSchema = z.object({
  ok: z.boolean(),
  executionMode: z.enum(["dry_run", "sandboxed_agent", "not_started"]),
  output: z.string(),
  error: z.string().optional(),
  stderr: z.string().optional(),
  exitCode: z.number().int().nullable().optional(),
  timedOut: z.boolean().optional(),
  durationMs: z.number().nonnegative().optional(),
  agent: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  workspaceBeforeHash: z.string().optional(),
  workspaceAfterHash: z.string().optional(),
  changedPaths: z.array(z.string()).optional(),
  sandboxIdentity: z.string().optional()
});

export type SandboxResult = z.infer<typeof sandboxResultSchema>;

export async function executeSandboxed(workItem: WorkItem): Promise<SandboxResult> {
  assertExecutableWorkItem(workItem);

  // The default boundary remains simulation; real agent execution is explicit and contained in agent-executor.ts.
  return {
    ok: true,
    executionMode: "dry_run",
    output: `dry-run simulated ${workItem.id}`
  };
}
