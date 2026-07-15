import { describe, expect, it } from "vitest";
import { missionIntakeHash, missionIntakeSchema } from "@agent-control-stack/work-items";
import { classifyMissionIntake } from "./mission-classifier.js";

const intake = missionIntakeSchema.parse({
  schemaVersion: "acs.mission-intake.v1",
  requestId: "request-001",
  title: "Inspect logs",
  goal: "draft a plan to inspect logs",
  origin: "cli",
  target: { cwd: "/home/jacen/project", files: [] },
  proposedActions: [{ clientActionId: "inspect-1", kind: "read_file", description: "Inspect logs", params: {} }],
  constraints: { network: "none", maxRuntimeMs: 60_000, successCriteria: ["Summary produced"] },
  submittedClaims: { taskType: "research", risk: "write", approvalRequested: true },
});

const context = { evidenceId: "evidence-001", generatedAt: "2026-07-11T22:00:00.000Z" };

describe("Mission Router compatibility classifier evidence", () => {
  it("rejects missing, unsupported, or unnormalized intake", () => {
    expect(() => classifyMissionIntake({ ...intake, schemaVersion: undefined }, context)).toThrow();
    expect(() => classifyMissionIntake({ ...intake, schemaVersion: "acs.mission-intake.v2" }, context)).toThrow();
    expect(() => classifyMissionIntake({ ...intake, submittedClaims: { risk: "critical" } }, context)).toThrow();
  });

  it("is versioned, subject-bound, advisory, and upward-only", () => {
    const evidence = classifyMissionIntake(intake, context);
    expect(evidence.schemaVersion).toBe("acs.classifier-evidence.v1");
    expect(evidence.subjectIntakeHash).toBe(missionIntakeHash(intake));
    expect(evidence.risk.recommendation).toBe("write");
    expect(evidence.authoritative).toBe(false);
    expect(evidence.taskType.signals.every((signal) => !Object.hasOwn(signal, "matchedText"))).toBe(true);
  });

  it("preserves Mission Router task and sensitivity vectors without raw matched text", () => {
    const browser = missionIntakeSchema.parse({ ...intake, requestId: "request-002", goal: "please scrape this page", submittedClaims: undefined });
    expect(classifyMissionIntake(browser, context).taskType.recommendation).toBe("browser_scrape");

    const sensitive = missionIntakeSchema.parse({
      ...intake,
      requestId: "request-003",
      goal: "look up my stripe api key and summarize where it is used",
      submittedClaims: undefined,
    });
    const evidence = classifyMissionIntake(sensitive, context);
    expect(evidence.sensitivity.categories).toEqual(["credential", "financial"]);
    expect(evidence.sensitivity.signals.every((signal) => Object.keys(signal).join(",") === "ruleId")).toBe(true);
  });

  it("avoids known benign sensitivity collisions", () => {
    for (const [index, goal] of [
      "email the secretary about the meeting",
      "tokenize the corpus for the search index",
      "write a private method in the class",
      "summarize the secretariat report",
    ].entries()) {
      const candidate = missionIntakeSchema.parse({ ...intake, requestId: `request-benign-${index}`, goal, submittedClaims: undefined });
      expect(classifyMissionIntake(candidate, context).sensitivity.categories).toEqual([]);
    }
  });
});
