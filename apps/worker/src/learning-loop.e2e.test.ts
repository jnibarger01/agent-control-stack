import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { ProceduralLearning, type TaskExperienceInput } from "@agent-control-stack/procedural-learning";
import { runSchedulerOnce } from "@agent-control-stack/scheduler";
import { afterEach, describe, expect, it } from "vitest";
import { runWorkerOnce, type WorkerExecute } from "./index.js";

const execFileAsync = promisify(execFile);
const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function seedSkill(dbPath: string): number {
  const learning = new ProceduralLearning(dbPath);
  const input: TaskExperienceInput = {
    taskId: "wrk_seed_vite",
    attemptId: "att_seed_vite",
    repository: "example/shop-ui",
    commitOrDiffId: "abc123",
    agent: "dev",
    problemSummary: "React/Vite production build fails with invalid hook call.",
    problemSignals: ["invalid hook call", "useContext returns null", "vite", "react"],
    errorMessages: ["Invalid hook call. Hooks can only be called inside of the body of a function component."],
    taskType: "build-recovery",
    technologies: ["vite", "react"],
    rootCause: "Duplicate physical React installations.",
    rootCauseKnown: true,
    hypothesesFailed: 4,
    toolCallCount: 16,
    reasoningStages: 6,
    materialOutcomeChange: true,
    reusableBeyondIncident: true,
    trivial: false,
    solutionSpecificity: 0.2,
    uncertainty: 0.1,
    recurrenceLikelihood: 0.85,
    crossRepoApplicability: 0.75,
    operationalRisk: 0.4,
    timeSavedEstimateMinutes: 45,
    completed: true,
    contradictoryEvidence: false,
    validation: { passed: true, commands: ["npm test", "npm run build"], results: ["pass", "pass"] },
    procedure: {
      diagnostic: ["Inspect the package tree for multiple React installations."],
      repair: ["Correct workspace resolution so one React instance is used."],
      validation: ["Run tests and production build."],
      rollback: ["Restore the lockfile."],
      failureModes: ["Alias-only workaround."]
    },
    proposedSkillName: "vite-duplicate-react-debugging"
  };
  learning.recordTaskExperience(input);
  const confidence = learning.showSkill("vite-duplicate-react-debugging").current.confidence;
  learning.close();
  return confidence;
}

function viteTemplate(title: string) {
  return {
    title,
    requester: "user" as const,
    intent: "React/Vite production build fails with invalid hook call in a monorepo",
    target: { cwd: "/repo", repo: "example/shop-ui" },
    requestedActions: [{ kind: "fs.read", description: "inspect package tree for duplicate react", params: { paths: ["package.json"] } }],
    risk: "low" as const
  };
}

const passingValidator = {
  async validate() {
    return {
      passed: true,
      checks: [{ name: "engine_outcome", passed: true, detail: "independent validator pass" }]
    };
  }
};

const usingExecute: WorkerExecute = async (workItem) => ({
  ok: true,
  executionMode: "dry_run",
  output: `used ${(workItem.retrievedSkills[0]?.skillId ?? "none")}`,
  usedSkillNames: workItem.retrievedSkills.map((skill) => skill.skillId)
});

describe("canonical worker learning loop", () => {
  it("retrieves, injects, records used+validated outcome, then survives worker restart for task B", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-learning-e2e-"));
    dirs.push(dir);
    const dbPath = join(dir, "control.db");
    const before = seedSkill(dbPath);
    expect(before).toBeGreaterThan(0);

    const scheduledA = await runSchedulerOnce({
      dbPath,
      now: new Date("2026-08-18T01:00:00.000Z"),
      schedules: [
        {
          scheduleId: "vite-task-a",
          intervalMs: 3_600_000,
          workItemTemplate: viteTemplate("Fix Vite invalid hook call A")
        }
      ]
    });
    expect(scheduledA.firings[0]?.created).toBe(true);

    const firstWorker = await runWorkerOnce({
      dbPath,
      workerId: "worker-a",
      execute: usingExecute,
      validator: passingValidator
    });
    expect(firstWorker.executed).toBe(true);
    expect(firstWorker.retrievedSkills?.[0]?.skillId).toBe("vite-duplicate-react-debugging");
    expect(firstWorker.retrievedSkills?.[0]?.version).toBe(1);
    expect(firstWorker.usedSkills).toEqual(["vite-duplicate-react-debugging"]);
    expect(firstWorker.validationPassed).toBe(true);

    const afterA = new ProceduralLearning(dbPath);
    const confidenceAfterA = afterA.showSkill("vite-duplicate-react-debugging").current.confidence;
    expect(confidenceAfterA).toBeGreaterThan(before);
    const usagesA = afterA.listUsages("vite-duplicate-react-debugging");
    expect(usagesA.some((usage) => usage.disposition === "retrieved")).toBe(true);
    expect(usagesA.some((usage) => usage.disposition === "applied" && usage.outcome === "success")).toBe(true);
    afterA.close();

    const evidence = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = evidence.prepare(`SELECT structured_output_json FROM attempt_results ORDER BY finished_at DESC LIMIT 1`).get() as
        | { structured_output_json: string }
        | undefined;
      expect(JSON.parse(row?.structured_output_json ?? "{}")).toMatchObject({
        retrievedSkills: [{ skillId: "vite-duplicate-react-debugging", version: 1 }],
        usedSkills: ["vite-duplicate-react-debugging"],
        validationPassed: true
      });
    } finally {
      evidence.close();
    }

    const scheduledB = await runSchedulerOnce({
      dbPath,
      now: new Date("2026-08-18T02:00:00.000Z"),
      schedules: [
        {
          scheduleId: "vite-task-b",
          intervalMs: 3_600_000,
          workItemTemplate: viteTemplate("Fix Vite invalid hook call B")
        }
      ]
    });
    expect(scheduledB.firings[0]?.created).toBe(true);

    const outPath = join(dir, "child-b.json");
    const child = join(process.cwd(), "apps/worker/src/learning-worker-child.ts");
    await execFileAsync(process.execPath, ["--import", "tsx", child, dbPath, outPath], {
      cwd: process.cwd(),
      timeout: 30_000,
      env: { ...process.env, ACS_DB_PATH: dbPath }
    });
    const injected = JSON.parse(readFileSync(outPath, "utf8")) as {
      retrievedSkills: Array<{ skillId: string; version: number; confidence: number }>;
    };
    expect(injected.retrievedSkills[0]?.skillId).toBe("vite-duplicate-react-debugging");
    expect(injected.retrievedSkills[0]?.version).toBe(1);
    expect(injected.retrievedSkills[0]?.confidence).toBe(confidenceAfterA);
  }, 40_000);
});
