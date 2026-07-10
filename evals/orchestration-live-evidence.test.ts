import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertOrchestrationEvidence, type OrchestrationEvidence } from "./orchestration-evidence.js";

const files = [
  "2026-07-09-orchestration-live-fan-out.json",
  "2026-07-09-orchestration-live-adversarial.json",
  "2026-07-09-orchestration-live-loop.json"
] as const;

function load(file: string): OrchestrationEvidence {
  const value: unknown = JSON.parse(readFileSync(new URL(`../runs/${file}`, import.meta.url), "utf8"));
  assertOrchestrationEvidence(value);
  return value;
}

describe("live headless orchestration evidence", () => {
  it("contains one completed Claude CLI run for every pattern", () => {
    const evidence = files.map(load);
    expect(new Set(evidence.map(({ pattern }) => pattern))).toEqual(
      new Set(["fanOutSynthesize", "adversarial", "loopUntilDone"])
    );
    expect(evidence.every(({ executionMode }) => executionMode === "headless-claude-cli")).toBe(true);
    expect(evidence.every(({ spendLog }) => spendLog.actualCostUsd > 0)).toBe(true);
    expect(evidence.every(({ spendLog }) => spendLog.exactModels.every((id) => !id.startsWith("fixture:")))).toBe(true);

    const fanOut = evidence.find(({ pattern }) => pattern === "fanOutSynthesize")!;
    const fanOutOutput = (fanOut.result as { synthesis: { output: string } }).synthesis.output.toLowerCase();
    expect(fanOutOutput).toMatch(/execution (?:must be )?denied|deny execution/);
    expect(fanOutOutput).toContain("abc");
    expect(fanOutOutput).toContain("def");
    expect(fanOutOutput).toContain("new approval");
    expect(fanOutOutput).toContain("audit");

    const adversarial = evidence.find(({ pattern }) => pattern === "adversarial")!;
    expect((adversarial.result as { output: string }).output).toBe("action: read\nrisk: low");
    const adversarialResult = adversarial.result as { criticPosition: string; verdict: string };
    if (adversarialResult.criticPosition === "concede") expect(adversarialResult.verdict).not.toBe("critic");
    const loop = evidence.find(({ pattern }) => pattern === "loopUntilDone")!;
    expect((loop.result as { output: string }).output).toBe("action: read\nrisk: low");
  });
});
