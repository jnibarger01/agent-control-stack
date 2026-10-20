import { describe, expect, it } from "vitest";
import {
  planVerificationDispatch,
  type CachedVerification,
  type VerificationDispatchPlan,
  type VerificationJob
} from "./verification-dispatch.js";

function job(
  jobId: string,
  checkId: string,
  artifactHash: string,
  kind: VerificationJob["kind"] = "deterministic"
): VerificationJob {
  return { jobId, checkId, kind, artifactHash, policyHash: "p", toolchainHash: "t" };
}

function pass(checkId: string, artifactHash: string, overrides: Partial<CachedVerification> = {}): CachedVerification {
  return { checkId, artifactHash, policyHash: "p", toolchainHash: "t", verdict: "PASS", ...overrides };
}

const ids = (jobs: readonly VerificationJob[]) => jobs.map((j) => j.jobId);

function summarize(plan: VerificationDispatchPlan) {
  return {
    dispatch: ids(plan.dispatch),
    satisfiedByCache: plan.satisfiedByCache.map((s) => s.job.jobId),
    deferred: ids(plan.deferred)
  };
}

const pending: readonly VerificationJob[] = [
  job("j1", "lint", "a"),
  job("j2", "review", "b", "semantic"),
  job("j3", "test", "c")
];

describe("planVerificationDispatch", () => {
  it("prioritizes deterministic checks and defers what does not fit", () => {
    expect(summarize(planVerificationDispatch(pending, [], 2))).toEqual({
      dispatch: ["j1", "j3"],
      satisfiedByCache: [],
      deferred: ["j2"]
    });
  });

  it("runs the same check against several artifacts in one batch", () => {
    // Regression: when jobId and checkId were one field, this threw "duplicate".
    const batch = [job("j1", "lint", "a1"), job("j2", "lint", "a2")];
    expect(summarize(planVerificationDispatch(batch, [], 4)).dispatch).toEqual(["j1", "j2"]);
  });

  it("reports cache-satisfied jobs separately from capacity-deferred ones", () => {
    // Regression: both cases used to produce an identical return value.
    const batch = [job("j1", "lint", "a"), job("j2", "test", "b")];
    const cached = planVerificationDispatch(batch, [pass("test", "b")], 4);
    const deferred = planVerificationDispatch(batch, [], 1);
    expect(summarize(cached)).toEqual({ dispatch: ["j1"], satisfiedByCache: ["j2"], deferred: [] });
    expect(summarize(deferred)).toEqual({ dispatch: ["j1"], satisfiedByCache: [], deferred: ["j2"] });
  });

  it("returns the matching cache entry so ACS can reconfirm it", () => {
    const entry = pass("test", "c");
    const plan = planVerificationDispatch(pending, [entry], 4);
    expect(plan.satisfiedByCache).toEqual([{ job: pending[2], cacheEntry: entry }]);
  });

  it("places every pending job in exactly one bucket", () => {
    const batch = [
      job("j1", "lint", "a"),
      job("j2", "review", "b", "semantic"),
      job("j3", "test", "c"),
      job("j4", "lint", "d"),
      job("j5", "review", "e", "semantic")
    ];
    const cache = [pass("test", "c"), pass("review", "e")];
    for (const slots of [0, 1, 2, 3, 10]) {
      const s = summarize(planVerificationDispatch(batch, cache, slots));
      const all = [...s.dispatch, ...s.satisfiedByCache, ...s.deferred];
      expect([...all].sort()).toEqual(ids(batch).sort());
      expect(new Set(all).size).toBe(all.length);
      expect(s.dispatch.length).toBeLessThanOrEqual(slots);
    }
  });

  it("does not treat cached failures or stale policy/toolchain results as satisfied", () => {
    const cache = [
      pass("lint", "a", { verdict: "FAIL" }),
      pass("test", "c", { policyHash: "old" }),
      pass("review", "b", { toolchainHash: "old" }),
      pass("test", "c", { verdict: "UNKNOWN" })
    ];
    expect(summarize(planVerificationDispatch(pending, cache, 3))).toEqual({
      dispatch: ["j1", "j3", "j2"],
      satisfiedByCache: [],
      deferred: []
    });
  });

  it("never satisfies a semantic review from cache, even on an exact PASS", () => {
    const batch = [job("j1", "review", "a", "semantic"), job("j2", "lint", "a")];
    const cache = [pass("review", "a"), pass("lint", "a")];
    expect(summarize(planVerificationDispatch(batch, cache, 4))).toEqual({
      dispatch: ["j1"],
      satisfiedByCache: ["j2"],
      deferred: []
    });
  });

  it("matches the cache on checkId, not jobId", () => {
    // A PASS for another check on the same artifact must not cover this one.
    const otherCheck = planVerificationDispatch(pending, [pass("another-check", "a")], 1);
    expect(summarize(otherCheck)).toEqual({ dispatch: ["j1"], satisfiedByCache: [], deferred: ["j3", "j2"] });
    // A cache entry whose checkId happens to equal a jobId must not match either.
    const jobIdCollision = planVerificationDispatch(pending, [pass("j1", "a")], 4);
    expect(jobIdCollision.satisfiedByCache).toEqual([]);
  });

  it("fails closed on invalid capacities, duplicate jobIds and incomplete identity", () => {
    expect(() => planVerificationDispatch(pending, [], -1)).toThrow(RangeError);
    expect(() => planVerificationDispatch(pending, [], 1.5)).toThrow(RangeError);
    expect(() => planVerificationDispatch([pending[0]!, pending[0]!], [], 2)).toThrow(/duplicate/);
    expect(() => planVerificationDispatch([{ ...pending[0]!, checkId: "" }], [], 2)).toThrow(/checkId/);
    expect(summarize(planVerificationDispatch(pending, [], 0))).toEqual({
      dispatch: [],
      satisfiedByCache: [],
      deferred: ["j1", "j3", "j2"]
    });
  });

  it("does not mutate the queue or the cache", () => {
    const queue = pending.map((j) => ({ ...j }));
    const cache = [pass("test", "c")];
    const queueBefore = JSON.stringify(queue);
    const cacheBefore = JSON.stringify(cache);
    planVerificationDispatch(queue, cache, 1);
    expect(JSON.stringify(queue)).toBe(queueBefore);
    expect(JSON.stringify(cache)).toBe(cacheBefore);
  });
});
