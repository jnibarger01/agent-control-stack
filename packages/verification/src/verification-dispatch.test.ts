import { describe, expect, it } from "vitest";
import { planVerificationDispatch } from "./verification-dispatch.js";

const pending = [
  { id: "lint-a", kind: "deterministic" as const, artifactHash: "a", policyHash: "p", toolchainHash: "t" },
  { id: "review-b", kind: "semantic" as const, artifactHash: "b", policyHash: "p", toolchainHash: "t" },
  { id: "test-c", kind: "deterministic" as const, artifactHash: "c", policyHash: "p", toolchainHash: "t" },
];

describe("planVerificationDispatch", () => {
  it("prioritizes deterministic checks without exceeding worker capacity", () => {
    expect(planVerificationDispatch(pending, [], 2).map((job) => job.id)).toEqual(["lint-a", "test-c"]);
  });

  it("does not treat cached failures or stale policy/toolchain results as verified", () => {
    const cached = [
      { artifactHash: "a", policyHash: "p", toolchainHash: "t", verdict: "FAIL" as const },
      { artifactHash: "c", policyHash: "old", toolchainHash: "t", verdict: "PASS" as const },
    ];
    expect(planVerificationDispatch(pending, cached, 3).map((job) => job.id)).toEqual(["lint-a", "test-c", "review-b"]);
  });

  it("skips only exact PASS cache matches", () => {
    const cached = [{ artifactHash: "a", policyHash: "p", toolchainHash: "t", verdict: "PASS" as const }];
    expect(planVerificationDispatch(pending, cached, 2).map((job) => job.id)).toEqual(["test-c", "review-b"]);
  });

  it("fails closed on invalid capacities and duplicate IDs", () => {
    expect(() => planVerificationDispatch(pending, [], -1)).toThrow();
    expect(() => planVerificationDispatch(pending, [], 1.5)).toThrow();
    expect(() => planVerificationDispatch([pending[0], pending[0]], [], 2)).toThrow();
    expect(planVerificationDispatch(pending, [], 0)).toEqual([]);
  });

  it("does not mutate queue order or cache input", () => {
    const before = pending.map((j) => j.id);
    planVerificationDispatch(pending, [], 2);
    expect(pending.map((j) => j.id)).toEqual(before);
  });
});
