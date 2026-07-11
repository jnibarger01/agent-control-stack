import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface Attempt {
  requestedBudgetUsd: number;
  actualCostUsd: number;
  resultSubtype: string;
  completed: boolean;
  observedToolEvents: string[];
}

describe("dynamic workflow fallback evidence", () => {
  it("records bounded failures without claiming a dynamic completion", () => {
    const value = JSON.parse(
      readFileSync(new URL("../runs/2026-07-09-dynamic-workflow-attempts.json", import.meta.url), "utf8")
    ) as {
      schemaVersion: number;
      kind: string;
      platformFact: string;
      claudeCodeVersion: string;
      apiKeyPresent: boolean;
      attempts: Attempt[];
      fallbackDecision: { mode: string; dynamicWorkflowCompleted: boolean };
    };
    expect(value).toMatchObject({
      schemaVersion: 1,
      kind: "dynamic-workflow-attempt-evidence",
      platformFact: "docs/platform-facts.md:52",
      claudeCodeVersion: "2.1.205",
      apiKeyPresent: false,
      fallbackDecision: { mode: "headless-claude-cli", dynamicWorkflowCompleted: false }
    });
    expect(value.attempts).toHaveLength(2);
    expect(value.attempts.every((attempt) => !attempt.completed)).toBe(true);
    expect(value.attempts.every((attempt) => attempt.resultSubtype === "error_max_budget_usd")).toBe(true);
    expect(value.attempts.every((attempt) => attempt.actualCostUsd > attempt.requestedBudgetUsd)).toBe(true);
    expect(value.attempts[1]!.observedToolEvents).toContain("task_started");
  });
});
