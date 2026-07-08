import { assertExecutableWorkItem, type WorkItem } from "@agent-control-stack/work-items";
import { z } from "zod";

export const sandboxResultSchema = z.object({
  ok: z.boolean(),
  executionMode: z.literal("dry_run"),
  output: z.string(),
  error: z.string().optional()
});

export type SandboxResult = z.infer<typeof sandboxResultSchema>;

export async function executeSandboxed(workItem: WorkItem): Promise<SandboxResult> {
  assertExecutableWorkItem(workItem);

  // ponytail: dry-run only; swap in firejail/nsjail/bubblewrap when executing untrusted commands.
  return {
    ok: true,
    executionMode: "dry_run",
    output: `dry-run executed ${workItem.id}`
  };
}
