import { describe, expect, it } from "vitest";
import {
  codingAgentCheckpointSchema,
  supervisorDirectiveSchema
} from "./supervisor.js";

describe("coding agent supervision contracts", () => {
  it("accepts an evidence-backed checkpoint", () => {
    const checkpoint = codingAgentCheckpointSchema.parse({
      runId: "run_123",
      sequence: 2,
      phase: "verifying",
      task: "Add structured logging",
      plan: "Modify only the logging package and run targeted tests.",
      filesTouched: ["packages/logging/src/index.ts"],
      commands: ["npm test -w packages/logging"],
      testSummary: { passed: 21, failed: 0, skipped: 0 },
      diff: "diff --git a/packages/logging/src/index.ts b/packages/logging/src/index.ts",
      riskFlags: [],
      elapsedMs: 1_200,
      tokenUsage: 4_200,
      branch: "feature/logging",
      worktreeDirty: true
    });

    expect(checkpoint.phase).toBe("verifying");
    expect(checkpoint.testSummary?.failed).toBe(0);
  });

  it("requires a correction for redirect decisions", () => {
    const result = supervisorDirectiveSchema.safeParse({
      decision: "redirect",
      issue: "Authentication files are outside task scope.",
      requiredEvidence: ["diff", "tests", "git_status"],
      policyReasons: ["scope-drift"]
    });

    expect(result.success).toBe(false);
  });

  it("accepts a bounded redirect with required evidence", () => {
    const directive = supervisorDirectiveSchema.parse({
      decision: "redirect",
      issue: "Authentication files are outside task scope.",
      correction: "Revert authentication changes, preserve logging changes, rerun targeted tests, and return the final diff.",
      requiredEvidence: ["diff", "tests", "git_status"],
      policyReasons: ["scope-drift"]
    });

    expect(directive.decision).toBe("redirect");
  });
});
