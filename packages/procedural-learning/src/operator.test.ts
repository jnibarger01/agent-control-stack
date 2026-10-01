import { existsSync, mkdtempSync } from "node:fs";
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

  it("keeps the subcommand when --db is omitted and resolves the documented default database path", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "acs-skills-default-")), "learning.db");
    const previousLearningDbPath = process.env.ACS_LEARNING_DB_PATH;
    process.env.ACS_LEARNING_DB_PATH = dbPath;
    let stdout = "";
    let stderr = "";
    const io = {
      stdout: { write: (chunk: string) => (stdout += chunk) },
      stderr: { write: (chunk: string) => (stderr += chunk) }
    };
    try {
      // Documented form: `acs skills <command>` with no --db at all.
      expect(runSkillsCommand(["list"], io)).toBe(0);
      expect(JSON.parse(stdout)).toEqual([]);
      stdout = "";
      expect(runSkillsCommand(["targets"], io)).toBe(0);
      expect(Array.isArray(JSON.parse(stdout))).toBe(true);
      stdout = "";
      expect(runSkillsCommand(["retrieve", "--problem", "invalid hook call vite"], io)).toBe(0);
      expect((JSON.parse(stdout) as { authorization: string }).authorization).toBe("guidance_only");
      // The documented default path is honoured; no stray file named after a flag.
      expect(existsSync(dbPath)).toBe(true);
      expect(stderr).toBe("");
      // An explicit --db after the subcommand still works and still wins.
      stdout = "";
      expect(runSkillsCommand(["list", "--db", dbPath], io)).toBe(0);
      expect(JSON.parse(stdout)).toEqual([]);
      expect(stderr).toBe("");
      // A --db with no value is still a usage error, not a silent default.
      stdout = "";
      expect(runSkillsCommand(["list", "--db"], io)).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("--db requires a path");
    } finally {
      if (previousLearningDbPath === undefined) delete process.env.ACS_LEARNING_DB_PATH;
      else process.env.ACS_LEARNING_DB_PATH = previousLearningDbPath;
    }
  });
});
