import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FIRST_CLASS_TARGETS, ProceduralLearning, type TaskExperienceInput } from "./learning.js";
import { slugifySkillName, taskExperienceInputSchema } from "./schema.js";

const stores: ProceduralLearning[] = [];

function openStore(): ProceduralLearning {
  const dir = mkdtempSync(join(tmpdir(), "acs-learning-"));
  const store = new ProceduralLearning(join(dir, "learning.db"));
  stores.push(store);
  return store;
}

afterEach(() => {
  while (stores.length > 0) {
    stores.pop()?.close();
  }
});

function viteExperience(overrides: Partial<TaskExperienceInput> = {}): TaskExperienceInput {
  return {
    taskId: "wrk_vite_hooks_1",
    attemptId: "att_vite_1",
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
    proposedSkillName: "vite-duplicate-react-debugging",
    ...overrides
  };
}

describe("procedural learning promotion gates", () => {
  it("promotes a successful difficult task into a candidate and skill", () => {
    const learning = openStore();
    const recorded = learning.recordTaskExperience(viteExperience());
    expect(recorded.experience.id).toMatch(/^exp_/);
    expect(recorded.candidate.state).toBe("PROMOTED");
    expect(recorded.candidate.score).toBeGreaterThanOrEqual(35);
    expect(recorded.skill?.name).toBe("vite-duplicate-react-debugging");
    expect(recorded.skill?.version).toBe(1);
    expect(recorded.skill?.provenance.taskId).toBe("wrk_vite_hooks_1");
    expect(recorded.skill?.content.problem_signals).toContain("invalid hook call");
  });

  it("does not promote a failed task", () => {
    const learning = openStore();
    const recorded = learning.recordTaskExperience(viteExperience({ completed: false, taskId: "wrk_fail" }));
    expect(recorded.candidate.state).toBe("REJECTED");
    expect(recorded.skill).toBeUndefined();
    expect(recorded.candidate.rejectReasons).toContain("task_not_completed");
  });

  it("does not promote an unvalidated task", () => {
    const learning = openStore();
    const recorded = learning.recordTaskExperience(
      viteExperience({
        taskId: "wrk_unvalidated",
        validation: { passed: false, commands: ["npm test"], results: ["fail"] }
      })
    );
    expect(recorded.candidate.state).toBe("REJECTED");
    expect(recorded.skill).toBeUndefined();
    expect(recorded.candidate.rejectReasons).toContain("validation_failed");
  });

  it("rejects a trivial successful task", () => {
    const learning = openStore();
    const recorded = learning.recordTaskExperience(
      viteExperience({
        taskId: "wrk_trivial",
        trivial: true,
        hypothesesFailed: 0,
        toolCallCount: 1,
        reasoningStages: 1,
        materialOutcomeChange: false
      })
    );
    expect(recorded.candidate.state).toBe("REJECTED");
    expect(recorded.skill).toBeUndefined();
    expect(recorded.candidate.rejectReasons.length).toBeGreaterThan(0);
  });
});

describe("idempotency, versions, and provenance", () => {
  it("is idempotent for a duplicate candidate", () => {
    const learning = openStore();
    const first = learning.recordTaskExperience(viteExperience());
    const second = learning.recordTaskExperience(viteExperience());
    expect(second.experience.id).toBe(first.experience.id);
    expect(second.candidate.id).toBe(first.candidate.id);
    expect(learning.listSkills()).toHaveLength(1);
    expect(learning.skillHistory("vite-duplicate-react-debugging")).toHaveLength(1);
  });

  it("improves an existing matching skill instead of duplicating it", () => {
    const learning = openStore();
    learning.recordTaskExperience(viteExperience());
    const updated = learning.recordTaskExperience(
      viteExperience({
        taskId: "wrk_vite_hooks_2",
        attemptId: "att_vite_2",
        repository: "example/other-ui",
        commitOrDiffId: "fff999",
        problemSummary: "Invalid hook call in a pnpm workspace Vite build.",
        procedure: {
          diagnostic: [
            "Confirm the hook error and whether React versions appear identical.",
            "Inspect the package tree for multiple physical React installations.",
            "Check whether Vite resolves the app and a dependency to different React instances.",
            "Inspect pnpm workspace package resolution and public-hoist settings."
          ],
          repair: [
            "Correct workspace or dependency resolution so a single React instance is used.",
            "Avoid adding an alias workaround before verifying the resolution graph."
          ],
          validation: ["Run unit tests, production build, and npm ls react react-dom."],
          rollback: ["Restore the previous lockfile and dependency declarations."],
          failureModes: ["Alias-only fixes hide the duplicate instead of removing it."]
        }
      })
    );
    expect(updated.skill?.name).toBe("vite-duplicate-react-debugging");
    expect(updated.skill?.version).toBe(2);
    expect(learning.listSkills()).toHaveLength(1);
    const history = learning.skillHistory("vite-duplicate-react-debugging");
    expect(history.map((entry) => entry.version)).toEqual([1, 2]);
    expect(history[1]?.content.diagnostic_sequence.some((step) => step.includes("pnpm"))).toBe(true);
    expect(history[0]?.content.diagnostic_sequence.some((step) => step.includes("pnpm"))).toBe(false);
  });

  it("preserves version history and provenance", () => {
    const learning = openStore();
    learning.recordTaskExperience(viteExperience());
    learning.recordTaskExperience(
      viteExperience({
        taskId: "wrk_vite_hooks_2",
        attemptId: "att_vite_2",
        commitOrDiffId: "fff999",
        procedure: {
          ...viteExperience().procedure,
          diagnostic: [...viteExperience().procedure.diagnostic, "Check peer dependency overrides."]
        }
      })
    );
    const shown = learning.showSkill("vite-duplicate-react-debugging");
    expect(shown.current.provenance.previousVersion).toBe(1);
    expect(shown.current.provenance.commitOrDiffId).toBe("fff999");
    expect(shown.history[0]?.provenance.taskId).toBe("wrk_vite_hooks_1");
  });
});

describe("retrieval and usage outcomes", () => {
  it("retrieves a relevant skill for a matching future task and ignores unrelated ones", () => {
    const learning = openStore();
    learning.recordTaskExperience(viteExperience());
    learning.recordTaskExperience(
      viteExperience({
        taskId: "wrk_systemd",
        attemptId: "att_sys_1",
        proposedSkillName: "systemd-service-debugging",
        problemSummary: "A systemd unit fails to start after a timeout.",
        problemSignals: ["systemd", "unit failed", "timeout"],
        errorMessages: ["Job for api.service failed because a timeout was exceeded."],
        taskType: "service-debugging",
        technologies: ["systemd", "linux"],
        rootCause: "The unit ExecStart pointed at a stale binary path.",
        procedure: {
          diagnostic: ["Read unit status and journal for the failed service."],
          repair: ["Correct ExecStart and reload systemd."],
          validation: ["systemctl start and status succeed."],
          rollback: ["Restore the previous unit file."],
          failureModes: ["Restarting without journal inspection hides the stale path."]
        }
      })
    );

    const retrieved = learning.retrieveSkills({
      problemSummary: "Vite build throws invalid hook call in a monorepo",
      errorMessages: ["Invalid hook call. Hooks can only be called inside of the body of a function component."],
      technologies: ["vite", "react"],
      taskType: "build-recovery",
      repository: "example/shop-ui"
    });
    expect(retrieved.length).toBeGreaterThan(0);
    expect(retrieved.length).toBeLessThanOrEqual(3);
    expect(retrieved[0]?.name).toBe("vite-duplicate-react-debugging");
    expect(retrieved.some((skill) => skill.name === "systemd-service-debugging")).toBe(false);

    const brief = learning.prepareEngineeringWork({
      problemSummary: "production invalid hook call with useContext null",
      errorMessages: ["useContext"],
      technologies: ["react", "vite"],
      taskType: "build-recovery"
    });
    expect(brief.authorization).toBe("guidance_only");
    expect(brief.skills[0]?.name).toBe("vite-duplicate-react-debugging");
    expect(brief.policyNote).toMatch(/does not authorize/i);
  });

  it("records skill use outcomes and raises confidence after repeated success", () => {
    const learning = openStore();
    learning.recordTaskExperience(viteExperience());
    const before = learning.showSkill("vite-duplicate-react-debugging").current.confidence;
    const first = learning.recordSkillUsage({
      skillName: "vite-duplicate-react-debugging",
      taskId: "wrk_next_1",
      attemptId: "att_next_1",
      disposition: "applied",
      outcome: "success",
      validationPassed: true,
      shortenedInvestigation: true,
      requiredCorrection: false,
      repository: "example/shop-ui"
    });
    expect(first.refinement).toBe("CONFIDENCE_INCREASE");
    const afterOne = learning.showSkill("vite-duplicate-react-debugging").current.confidence;
    expect(afterOne).toBeGreaterThan(before);
    learning.recordSkillUsage({
      skillName: "vite-duplicate-react-debugging",
      taskId: "wrk_next_2",
      attemptId: "att_next_2",
      disposition: "applied",
      outcome: "success",
      validationPassed: true,
      shortenedInvestigation: true,
      requiredCorrection: false,
      repository: "example/shop-ui"
    });
    const metrics = learning.showSkill("vite-duplicate-react-debugging").metrics;
    expect(metrics.uses).toBe(2);
    expect(metrics.successful_uses).toBe(2);
    expect(metrics.success_rate).toBe(1);
    expect(learning.showSkill("vite-duplicate-react-debugging").current.confidence).toBeGreaterThan(afterOne);
  });

  it("reduces confidence and quarantines a skill after repeated failure", () => {
    const learning = openStore();
    learning.recordTaskExperience(viteExperience());
    const start = learning.showSkill("vite-duplicate-react-debugging").current.confidence;
    for (const index of [1, 2, 3]) {
      learning.recordSkillUsage({
        skillName: "vite-duplicate-react-debugging",
        taskId: `wrk_bad_${index}`,
        attemptId: `att_bad_${index}`,
        disposition: "applied",
        outcome: "failure",
        validationPassed: false,
        shortenedInvestigation: false,
        requiredCorrection: true,
        repository: "example/shop-ui"
      });
    }
    const shown = learning.showSkill("vite-duplicate-react-debugging");
    expect(shown.current.confidence).toBeLessThan(start);
    expect(shown.status).toBe("quarantined");
    const retrieved = learning.retrieveSkills({
      problemSummary: "invalid hook call vite react",
      errorMessages: ["Invalid hook call"],
      technologies: ["vite", "react"],
      taskType: "build-recovery"
    });
    expect(retrieved).toEqual([]);
  });
});

describe("crash recovery, concurrency, secrets, and policy", () => {
  it("reconciles a crash during promotion without losing the experience or duplicating the skill", () => {
    const learning = openStore();
    const captured = learning.recordTaskExperience(viteExperience(), { pauseAfter: "EXTRACTING" });
    expect(captured.candidate.state).toBe("EXTRACTING");
    expect(captured.skill).toBeUndefined();
    expect(learning.getExperience(captured.experience.id)?.id).toBe(captured.experience.id);
    const resumed = learning.reconcilePromotion(captured.experience.id);
    expect(resumed.candidate.state).toBe("PROMOTED");
    expect(resumed.skill?.version).toBe(1);
    const again = learning.reconcilePromotion(captured.experience.id);
    expect(again.skill?.version).toBe(1);
    expect(learning.skillHistory("vite-duplicate-react-debugging")).toHaveLength(1);
  });

  it("does not create duplicate skills from concurrent similar promotions", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-learning-"));
    const dbPath = join(dir, "learning.db");
    const left = new ProceduralLearning(dbPath);
    const right = new ProceduralLearning(dbPath);
    stores.push(left, right);
    const first = left.recordTaskExperience(viteExperience());
    const second = right.recordTaskExperience(viteExperience());
    expect(second.experience.id).toBe(first.experience.id);
    expect(left.listSkills().map((skill) => skill.name)).toEqual(["vite-duplicate-react-debugging"]);
    expect(right.listSkills()).toHaveLength(1);
  });

  it("excludes sensitive values from generated skill content", () => {
    const learning = openStore();
    const recorded = learning.recordTaskExperience(
      viteExperience({
        taskId: "wrk_secret",
        rootCause: "Duplicate React plus leaked token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        procedure: {
          ...viteExperience().procedure,
          repair: ["Do not store api_key=supersecretvalue123 in the skill."]
        },
        explicitSecrets: ["supersecretvalue123"]
      })
    );
    const serialized = JSON.stringify(recorded.skill);
    expect(serialized).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(serialized).not.toContain("supersecretvalue123");
    expect(serialized).toContain("[redacted]");
  });

  it("does not let retrieved skills bypass policy or approval gates", () => {
    const learning = openStore();
    learning.recordTaskExperience(viteExperience());
    const brief = learning.prepareEngineeringWork({
      problemSummary: "invalid hook call",
      errorMessages: ["Invalid hook call"],
      technologies: ["vite"],
      taskType: "build-recovery",
      requestedPrivileges: ["merge", "production-deploy", "approval-bypass"]
    });
    expect(brief.authorization).toBe("guidance_only");
    expect(brief.approvedActions).toEqual([]);
    expect(brief.deniedPrivileges).toEqual(["merge", "production-deploy", "approval-bypass"]);
    expect(() =>
      learning.assertGuidanceCannotAuthorize({
        skillName: "vite-duplicate-react-debugging",
        action: "merge"
      })
    ).toThrow(/guidance_only|cannot authorize/i);
  });
});

describe("authoritative evidence verification (fabricated experience resistance)", () => {
  function openVerifiedStore(evidence: Record<string, { completed: boolean; validationPassed: boolean } | undefined>) {
    const dir = mkdtempSync(join(tmpdir(), "acs-learning-verified-"));
    const store = new ProceduralLearning(join(dir, "learning.db"), {
      verifyEvidence: ({ taskId, attemptId }) => evidence[`${taskId}:${attemptId}`]
    });
    stores.push(store);
    return store;
  }

  it("rejects a fabricated experience claiming success and passing validation for a task/attempt the store never recorded", () => {
    const learning = openVerifiedStore({});
    const recorded = learning.recordTaskExperience(
      viteExperience({ taskId: "wrk_fabricated", attemptId: "att_fabricated" })
    );
    expect(recorded.candidate.state).toBe("REJECTED");
    expect(recorded.skill).toBeUndefined();
    expect(recorded.candidate.rejectReasons).toContain("task_not_completed");
    expect(recorded.candidate.rejectReasons).toContain("validation_failed");
  });

  it("rejects a self-reported success/passing-validation claim when authoritative evidence says validation actually failed", () => {
    const learning = openVerifiedStore({
      "wrk_lied:att_lied": { completed: true, validationPassed: false }
    });
    const recorded = learning.recordTaskExperience(
      // The caller claims completed: true and validation.passed: true...
      viteExperience({ taskId: "wrk_lied", attemptId: "att_lied" })
    );
    // ...but the authoritative record says validation actually failed, so
    // promotion must not happen on the caller's word alone.
    expect(recorded.candidate.state).toBe("REJECTED");
    expect(recorded.skill).toBeUndefined();
    expect(recorded.candidate.rejectReasons).toContain("validation_failed");
  });

  it("promotes normally when authoritative evidence actually confirms the claimed completion and passing validation", () => {
    const learning = openVerifiedStore({
      "wrk_real:att_real": { completed: true, validationPassed: true }
    });
    const recorded = learning.recordTaskExperience(viteExperience({ taskId: "wrk_real", attemptId: "att_real" }));
    expect(recorded.candidate.state).toBe("PROMOTED");
    expect(recorded.skill?.name).toBe("vite-duplicate-react-debugging");
  });

  it("keeps trusting self-reported input when no verifier is configured (unverified/back-compat mode)", () => {
    const learning = openStore();
    const recorded = learning.recordTaskExperience(viteExperience({ taskId: "wrk_unverified" }));
    expect(recorded.candidate.state).toBe("PROMOTED");
  });
});

describe("slugifySkillName (bounded against ReDoS on model-supplied names)", () => {
  it("slugifies a normal proposed skill name", () => {
    expect(slugifySkillName("  Vite Duplicate React Debugging!! ")).toBe("vite-duplicate-react-debugging");
  });

  it("collapses and trims separator runs at both ends without a global backtracking-prone alternation", () => {
    expect(slugifySkillName("---leading-and-trailing---")).toBe("leading-and-trailing");
  });

  it("still slugifies correctly on a long run of separator characters at both ends", () => {
    // CodeQL flags the original /^-+|-+$/g as a polynomial-time ReDoS sink
    // on a caller-supplied name (a global alternation re-attempted at every
    // position). The anchored non-global replaces used instead have a
    // provably linear worst case regardless of JS engine internals; this
    // pins the still-correct behavior on the adversarial shape the alert
    // was about, independent of the schema's max-length bound.
    const huge = `${"-".repeat(2_000_000)}ok${"-".repeat(2_000_000)}`;
    expect(slugifySkillName(huge)).toBe("ok");
  });

  it("rejects an empty-after-slugification name", () => {
    expect(() => slugifySkillName("!!!")).toThrowError(/skill name must contain a letter or digit/);
  });
});

describe("taskExperienceInputSchema bounds proposedSkillName", () => {
  it("rejects a proposedSkillName beyond the persisted-record length bound", () => {
    const result = taskExperienceInputSchema.safeParse({
      ...viteExperience({ taskId: "wrk_bound" }),
      proposedSkillName: "a".repeat(257)
    });
    expect(result.success).toBe(false);
  });

  it("accepts a proposedSkillName at the length bound", () => {
    const result = taskExperienceInputSchema.safeParse({
      ...viteExperience({ taskId: "wrk_bound" }),
      proposedSkillName: "a".repeat(256)
    });
    expect(result.success).toBe(true);
  });
});

describe("first-class target ingest", () => {
  it("ingests existing manual skills without inventing missing procedures", () => {
    const learning = openStore();
    const dir = mkdtempSync(join(tmpdir(), "acs-skill-src-"));
    const skillDir = join(dir, "agent-orchestration-safety");
    writeFileSync(
      join(dir, "agent-orchestration-safety.md"),
      `---
name: agent-orchestration-safety
description: Use for safe HerdR agent orchestration and approval audits.
---
# Agent Orchestration Safety
Inspect pane IDs before approving anything.
`,
      "utf8"
    );
    const result = learning.ingestFirstClassTargets({
      existingSkills: [
        {
          name: "agent-orchestration-safety",
          path: join(dir, "agent-orchestration-safety.md"),
          repository: "hermes-agent"
        }
      ]
    });
    expect(result.ingested).toContain("agent-orchestration-safety");
    expect(result.unseeded.sort()).toEqual(
      FIRST_CLASS_TARGETS.filter((name) => name !== "agent-orchestration-safety").sort()
    );
    expect(learning.showSkill("agent-orchestration-safety").current.provenance.source).toBe("manual_ingest");
    expect(learning.getTarget("vite-duplicate-react-debugging")?.status).toBe("unseeded");
    void skillDir;
  });
});
