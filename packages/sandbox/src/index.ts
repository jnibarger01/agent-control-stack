import { assertExecutableWorkItem, type WorkItem } from "@agent-control-stack/work-items";
import { z } from "zod";

export * from "./contracts.js";
export * from "./linux.js";

export const sandboxResultSchema = z.object({
  ok: z.boolean(),
  executionMode: z.literal("dry_run"),
  output: z.string(),
  error: z.string().optional()
});

export type SandboxResult = z.infer<typeof sandboxResultSchema>;

export async function executeSandboxed(workItem: WorkItem): Promise<SandboxResult> {
  assertExecutableWorkItem(workItem);

  // Simulation is intentionally separate from the live Bubblewrap backend.
  // It must never satisfy a live execution or completion requirement.
  return {
    ok: true,
    executionMode: "dry_run",
    output: `dry-run simulated ${workItem.id}`
  };
}
