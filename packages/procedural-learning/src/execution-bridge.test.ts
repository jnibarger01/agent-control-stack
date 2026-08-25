import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deriveProblemSignature, ExecutionLearningBridge } from "./execution-bridge.js";
import { ProceduralLearning, type TaskExperienceInput } from "./learning.js";

const stores: ProceduralLearning[] = [];

function openStore(): ProceduralLearning {
  const store = new ProceduralLearning(join(mkdtempSync(join(tmpdir(), "acs-bridge-")), "learning.db"));
  stores.push(store);
  return store;
}

afterEach(() => {
  while (stores.length > 0) stores.pop()?.close();
});

function seed(learning: ProceduralLearning): void {
  const input: TaskExperienceInput = {
    taskId: "wrk_seed",
    attemptId: "att_seed",
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
  };
  learning.recordTaskExperience(input);
}

describe("execution learning bridge", () => {
  it("derives a vite build-recovery signature from a claimed work item", () => {
    const signature = deriveProblemSignature({
      title: "Fix Vite invalid hook call",
      intent: "React/Vite production build fails with invalid hook call",
      target: { repo: "example/shop-ui" },
      requestedActions: [{ kind: "fs.read", description: "inspect package tree", params: { paths: ["package.json"] } }]
    });
    expect(signature.taskType).toBe("build-recovery");
    expect(signature.technologies).toContain("vite");
    expect(signature.repository).toBe("example/shop-ui");
  });

  it("does not raise confidence when a skill is only retrieved", () => {
    const learning = openStore();
    seed(learning);
    const before = learning.showSkill("vite-duplicate-react-debugging").current.confidence;
    const bridge = new ExecutionLearningBridge(learning);
    const prepared = bridge.beforeExecution(
      {
        id: "wrk_a",
        title: "Fix Vite invalid hook call",
        intent: "React/Vite production build fails with invalid hook call",
        target: { repo: "example/shop-ui" }
      },
      "att_a"
    );
    expect(prepared.retrievedSkills[0]?.skillId).toBe("vite-duplicate-react-debugging");
    const afterRetrieve = learning.showSkill("vite-duplicate-react-debugging").current.confidence;
    expect(afterRetrieve).toBe(before);
    bridge.afterExecution({
      workItemId: "wrk_a",
      attemptId: "att_a",
      retrievedSkills: prepared.retrievedSkills,
      usedSkillIds: [],
      engineSucceeded: true,
      validationPassed: true
    });
    expect(learning.showSkill("vite-duplicate-react-debugging").current.confidence).toBe(before);
  });

  it("raises confidence only after used + validator PASS", () => {
    const learning = openStore();
    seed(learning);
    const before = learning.showSkill("vite-duplicate-react-debugging").current.confidence;
    const bridge = new ExecutionLearningBridge(learning);
    const prepared = bridge.beforeExecution(
      {
        id: "wrk_b",
        title: "Fix Vite invalid hook call",
        intent: "invalid hook call vite react",
        target: { repo: "example/shop-ui" }
      },
      "att_b"
    );
    const unvalidated = bridge.afterExecution({
      workItemId: "wrk_b",
      attemptId: "att_b",
      retrievedSkills: prepared.retrievedSkills,
      usedSkillIds: ["vite-duplicate-react-debugging"],
      engineSucceeded: true
    });
    expect(unvalidated.refinements[0]?.recorded).toBe(false);
    expect(learning.showSkill("vite-duplicate-react-debugging").current.confidence).toBe(before);
    const validated = bridge.afterExecution({
      workItemId: "wrk_b",
      attemptId: "att_b2",
      retrievedSkills: prepared.retrievedSkills,
      usedSkillIds: ["vite-duplicate-react-debugging"],
      engineSucceeded: true,
      validationPassed: true
    });
    expect(validated.refinements[0]?.refinement).toBe("CONFIDENCE_INCREASE");
    expect(learning.showSkill("vite-duplicate-react-debugging").current.confidence).toBeGreaterThan(before);
  });
});
