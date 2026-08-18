import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FIRST_CLASS_TARGETS, ProceduralLearning } from "../src/learning.ts";

const dbPath = join(mkdtempSync(join(tmpdir(), "acs-learning-demo-")), "learning.db");
const learning = new ProceduralLearning(dbPath);

const ingested = learning.ingestFirstClassTargets({
  existingSkills: [
    {
      name: "agent-orchestration-safety",
      path: "/home/jacen/.hermes/skills/autonomous-ai-agents/agent-orchestration-safety/SKILL.md",
      repository: "hermes-agent"
    },
    {
      name: "bounded-orchestration",
      path: "/home/jacen/projects/agent-control-stack/skills/bounded-orchestration/SKILL.md",
      repository: "agent-control-stack"
    },
    {
      name: "independent-verification",
      path: "/home/jacen/projects/agent-control-stack/skills/independent-verification/SKILL.md",
      repository: "agent-control-stack"
    },
    {
      name: "eval-baseline",
      path: "/home/jacen/projects/agent-control-stack/skills/eval-baseline/SKILL.md",
      repository: "agent-control-stack"
    }
  ]
});

const promoted = learning.recordTaskExperience({
  taskId: "wrk_vite_hooks_demo",
  attemptId: "att_vite_demo",
  repository: "example/shop-ui",
  commitOrDiffId: "abc123def456",
  agent: "dev",
  problemSummary: "React/Vite production build fails with invalid hook call.",
  problemSignals: ["invalid hook call", "useContext returns null", "monorepo", "production build fails"],
  errorMessages: ["Invalid hook call. Hooks can only be called inside of the body of a function component."],
  taskType: "build-recovery",
  technologies: ["vite", "react", "pnpm"],
  rootCause: "Duplicate physical React installations resolved by Vite for the app and a workspace dependency.",
  rootCauseKnown: true,
  hypothesesFailed: 3,
  toolCallCount: 18,
  reasoningStages: 6,
  materialOutcomeChange: true,
  reusableBeyondIncident: true,
  trivial: false,
  solutionSpecificity: 0.2,
  uncertainty: 0.1,
  recurrenceLikelihood: 0.8,
  crossRepoApplicability: 0.75,
  operationalRisk: 0.4,
  timeSavedEstimateMinutes: 45,
  completed: true,
  contradictoryEvidence: false,
  validation: {
    passed: true,
    commands: ["npm test", "npm run build", "npm ls react react-dom"],
    results: ["pass", "pass", "one react instance"]
  },
  procedure: {
    diagnostic: [
      "Confirm the hook error and whether React versions appear identical.",
      "Inspect the package tree for multiple physical React installations.",
      "Check whether Vite resolves the app and a dependency to different React instances."
    ],
    repair: [
      "Correct workspace or dependency resolution so a single React instance is used.",
      "Avoid adding an alias workaround before verifying the resolution graph."
    ],
    validation: ["Run unit tests, production build, and npm ls react react-dom."],
    rollback: ["Restore the previous lockfile and dependency declarations."],
    failureModes: ["Alias-only fixes hide the duplicate instead of removing it."]
  },
  proposedSkillName: "vite-duplicate-react-debugging"
});

const retrieved = learning.prepareEngineeringWork({
  problemSummary: "Vite production invalid hook call in a workspace",
  errorMessages: ["Invalid hook call"],
  technologies: ["vite", "react"],
  taskType: "build-recovery",
  repository: "example/shop-ui",
  requestedPrivileges: ["merge"]
});

const usage = learning.recordSkillUsage({
  skillName: "vite-duplicate-react-debugging",
  taskId: "wrk_vite_followup",
  attemptId: "att_followup",
  disposition: "applied",
  outcome: "success",
  validationPassed: true,
  shortenedInvestigation: true,
  requiredCorrection: false,
  repository: "example/shop-ui"
});

const shown = learning.showSkill("vite-duplicate-react-debugging");
learning.close();

console.log(
  JSON.stringify(
    {
      dbPath,
      firstClassTargets: FIRST_CLASS_TARGETS,
      ingested,
      experienceId: promoted.experience.id,
      candidateState: promoted.candidate.state,
      candidateScore: promoted.candidate.score,
      skill: promoted.skill?.name,
      version: promoted.skill?.version,
      retrieved: retrieved.skills.map((skill) => skill.name),
      authorization: retrieved.authorization,
      deniedPrivileges: retrieved.deniedPrivileges,
      usageRefinement: usage.refinement,
      confidence: shown.current.confidence,
      metrics: shown.metrics
    },
    null,
    2
  )
);
