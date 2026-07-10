import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  assertMakerVerifierEvidence,
  caughtSelfApprovedError,
  type MakerVerifierEvidence
} from "./maker-verifier-evidence.js";

const files = [
  "2026-07-09-maker-verifier-audit-replay-invariant.json",
  "2026-07-09-maker-verifier-redaction-repair.json",
  "2026-07-09-maker-verifier-work-item-lifecycle-seeded.json"
] as const;

function load(file: string): MakerVerifierEvidence {
  const value: unknown = JSON.parse(readFileSync(new URL(`../runs/${file}`, import.meta.url), "utf8"));
  const taskFile = (value as MakerVerifierEvidence).taskFile;
  const taskSource = readFileSync(new URL(`../${taskFile}`, import.meta.url), "utf8");
  assertMakerVerifierEvidence(value, taskSource);
  return value;
}

describe("maker-verifier acceptance evidence", () => {
  it("contains valid full traces for three distinct eval tasks", () => {
    const evidence = files.map(load);
    expect(new Set(evidence.map(({ trace }) => trace.taskId)).size).toBe(3);
    expect(evidence.every(({ trace }) => trace.iterations.length >= 1)).toBe(true);
    for (const item of evidence) {
      const task = readFileSync(new URL(`../${item.taskFile}`, import.meta.url));
      expect(createHash("sha256").update(task).digest("hex")).toBe(item.taskSha256);
    }
  });

  it("shows a fresh verifier reject a self-approved seeded maker error", () => {
    const evidence = files.map(load);
    const caught = evidence.find(caughtSelfApprovedError);
    expect(caught?.faultInjection).toMatchObject({
      kind: "seeded-first-maker-omission",
      seededReceiptModel: "fixture:seeded-maker-error"
    });
    expect(caught?.trace.iterations[0]?.verifier.receipt.exactModels[0]).not.toContain("fixture:");
  });

  it("rejects aggregate usage tampering", () => {
    const value = JSON.parse(
      readFileSync(new URL(`../runs/${files[0]}`, import.meta.url), "utf8")
    ) as MakerVerifierEvidence;
    value.trace.totalUsage.inputTokens += 1;
    const taskSource = readFileSync(new URL(`../${value.taskFile}`, import.meta.url), "utf8");
    expect(() => assertMakerVerifierEvidence(value, taskSource)).toThrow("totalUsage");
  });

  it("rejects a forged rubric and an impossible call duration", () => {
    const value = JSON.parse(
      readFileSync(new URL(`../runs/${files[0]}`, import.meta.url), "utf8")
    ) as MakerVerifierEvidence;
    const taskSource = readFileSync(new URL(`../${value.taskFile}`, import.meta.url), "utf8");
    value.rubric[0]!.expected = "forged expectation";
    expect(() => assertMakerVerifierEvidence(value, taskSource)).toThrow("source task rubric");

    const fresh = JSON.parse(
      readFileSync(new URL(`../runs/${files[0]}`, import.meta.url), "utf8")
    ) as MakerVerifierEvidence;
    fresh.trace.iterations[0]!.maker.receipt.durationMs = 1_000_000;
    expect(() => assertMakerVerifierEvidence(fresh, taskSource)).toThrow("timestamp interval");
  });
});
