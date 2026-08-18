import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProceduralLearning } from "./learning.js";
import { runSkillsCommand } from "./operator.js";

describe("acs skills operator", () => {
  it("lists promoted skills and retrieves guidance without granting privileges", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "acs-skills-cli-")), "learning.db");
    const learning = new ProceduralLearning(dbPath);
    learning.recordTaskExperience({
      taskId: "wrk_cli",
      attemptId: "att_cli",
      repository: "example/shop-ui",
      agent: "dev",
      problemSummary: "React/Vite production build fails with invalid hook call.",
      problemSignals: ["invalid hook call", "vite", "react"],
      errorMessages: ["Invalid hook call"],
      taskType: "build-recovery",
      technologies: ["vite", "react"],
      rootCause: "Duplicate React installations.",
      rootCauseKnown: true,
      hypothesesFailed: 3,
      toolCallCount: 12,
      reasoningStages: 5,
      materialOutcomeChange: true,
      reusableBeyondIncident: true,
      trivial: false,
      solutionSpecificity: 0.2,
      uncertainty: 0.1,
      recurrenceLikelihood: 0.8,
      crossRepoApplicability: 0.7,
      operationalRisk: 0.4,
      timeSavedEstimateMinutes: 40,
      completed: true,
      contradictoryEvidence: false,
      validation: { passed: true, commands: ["npm test"], results: ["pass"] },
      procedure: {
        diagnostic: ["Inspect the package tree for duplicate React."],
        repair: ["Deduplicate React resolution."],
        validation: ["npm test and npm run build."],
        rollback: ["Restore the lockfile."],
        failureModes: ["Alias-only workaround."]
      },
      proposedSkillName: "vite-duplicate-react-debugging"
    });
    learning.close();

    let stdout = "";
    let stderr = "";
    const io = {
      stdout: { write: (chunk: string) => (stdout += chunk) },
      stderr: { write: (chunk: string) => (stderr += chunk) }
    };
    expect(runSkillsCommand(["--db", dbPath, "list"], io)).toBe(0);
    expect(JSON.parse(stdout)[0].name).toBe("vite-duplicate-react-debugging");
    stdout = "";
    expect(runSkillsCommand(["--db", dbPath, "retrieve", "--problem", "invalid hook call vite"], io)).toBe(0);
    const brief = JSON.parse(stdout) as { authorization: string; approvedActions: unknown[] };
    expect(brief.authorization).toBe("guidance_only");
    expect(brief.approvedActions).toEqual([]);
    expect(stderr).toBe("");
  });
});
