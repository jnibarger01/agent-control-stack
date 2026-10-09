import { describe, expect, it } from "vitest";
import {
  RouteStrategyRejectedError,
  candidateStrategies,
  deriveRouteEnrichment,
  executorClassFor,
  recommendStrategy,
  type RouteUnitContext
} from "./route-strategy.js";

const unit = (
  kind: RouteUnitContext["kind"],
  verificationPolicy: RouteUnitContext["verificationPolicy"] = "none"
): RouteUnitContext => ({
  kind,
  verificationPolicy
});

describe("candidate strategies (hard policy)", () => {
  it("always offers single and keeps a trivial coding unit simple", () => {
    expect(candidateStrategies(unit("shell"), 1).candidates).toEqual(["single"]);
    expect(candidateStrategies(unit("coding"), 1).candidates).toEqual(["single", "plan_execute"]);
  });

  it("offers maker_verifier only when verification is required and a second executor exists", () => {
    expect(candidateStrategies(unit("coding", "independent"), 2).candidates).toContain("maker_verifier");
    const alone = candidateStrategies(unit("coding", "independent"), 1);
    expect(alone.candidates).not.toContain("maker_verifier");
    expect(alone.reasons).toContainEqual(expect.objectContaining({ code: "maker_verifier_unavailable" }));
    expect(candidateStrategies(unit("coding", "none"), 3).candidates).not.toContain("maker_verifier");
    expect(candidateStrategies(unit("verification", "independent"), 3).candidates).not.toContain("maker_verifier");
  });

  it("offers parallel candidates only with a policy cap of 2+ and at least two executors", () => {
    expect(candidateStrategies(unit("coding"), 3).candidates).not.toContain("parallel_candidates");
    expect(candidateStrategies(unit("coding"), 3, { maxParallelism: 3 }).candidates).toContain("parallel_candidates");
    expect(candidateStrategies(unit("coding"), 1, { maxParallelism: 3 }).candidates).not.toContain(
      "parallel_candidates"
    );
    expect(candidateStrategies(unit("shell"), 3, { maxParallelism: 3 }).candidates).not.toContain(
      "parallel_candidates"
    );
  });

  it("offers delegation only when policy allows it, and cua_recovery only for cua", () => {
    expect(candidateStrategies(unit("agent"), 2).candidates).not.toContain("specialist_delegation");
    expect(candidateStrategies(unit("agent"), 2, { delegationAllowed: true }).candidates).toContain(
      "specialist_delegation"
    );
    expect(candidateStrategies(unit("coding"), 2, { delegationAllowed: true }).candidates).not.toContain(
      "specialist_delegation"
    );
    expect(candidateStrategies(unit("cua"), 2).candidates).toEqual(["single", "cua_recovery"]);
    expect(candidateStrategies(unit("coding"), 2).candidates).not.toContain("cua_recovery");
  });

  it("narrows to the policy allow-list and fails closed when the list leaves nothing", () => {
    expect(candidateStrategies(unit("coding"), 2, { allowedStrategies: ["plan_execute"] }).candidates).toEqual([
      "plan_execute"
    ]);
    const nonMatching = candidateStrategies(unit("shell"), 2, { allowedStrategies: ["cua_recovery"] });
    expect(nonMatching).toMatchObject({ candidates: [], rejected: true });
    expect(nonMatching.reasons).toContainEqual({ code: "allowed_strategies_rejected", detail: "cua_recovery" });
    const empty = candidateStrategies(unit("coding"), 2, { allowedStrategies: [] });
    expect(empty).toMatchObject({ candidates: [], rejected: true });
    expect(empty.reasons).toContainEqual({ code: "allowed_strategies_rejected", detail: "empty" });
  });

  it("deriveRouteEnrichment rejects instead of defaulting to single, recording any recommendation", () => {
    for (const allowedStrategies of [[], ["cua_recovery"]] as const) {
      let caught: unknown;
      try {
        deriveRouteEnrichment({
          unit: unit("shell"),
          eligibleCount: 2,
          policy: { allowedStrategies },
          recommended: "single"
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(RouteStrategyRejectedError);
      const rejection = caught as RouteStrategyRejectedError;
      expect(rejection.reasons.map((reason) => reason.code)).toEqual([
        "allowed_strategies_rejected",
        "strategy_recommendation_rejected"
      ]);
      expect(rejection.reasons).toContainEqual({ code: "strategy_recommendation_rejected", detail: "single" });
      expect(rejection.deterministicEvidence).toContainEqual({ kind: "candidate_strategies", value: [] });
      expect(rejection.deterministicEvidence).toContainEqual({
        kind: "allowed_strategies",
        value: [...allowedStrategies]
      });
    }
  });

  it("maps every unit kind to an executor class", () => {
    expect(executorClassFor("tool")).toBe("shell");
    expect(executorClassFor("planning")).toBe("agent");
    expect(executorClassFor("cua")).toBe("cua");
    expect(executorClassFor("swarm")).toBe("swarm");
  });
});

describe("deriveRouteEnrichment", () => {
  it("defaults to a single strategy decided by policy, with evidence and a version", () => {
    const route = deriveRouteEnrichment({ unit: unit("coding", "independent"), eligibleCount: 2 });
    expect(route).toMatchObject({
      executorClass: "coding",
      strategy: "single",
      strategySource: "deterministic",
      parallelism: 1,
      verificationRequired: true,
      version: "acs-route-enrichment@1"
    });
    expect(route.reasons).toEqual(
      expect.arrayContaining([
        { code: "strategy_default_single" },
        { code: "verification_required", detail: "independent" }
      ])
    );
    expect(route.deterministicEvidence).toEqual(
      expect.arrayContaining([
        { kind: "eligible_count", value: 2 },
        { kind: "candidate_strategies", value: ["single", "plan_execute", "maker_verifier"] }
      ])
    );
  });

  it("accepts a model recommendation inside the candidate set and records its source", () => {
    const route = deriveRouteEnrichment({
      unit: unit("coding", "independent"),
      eligibleCount: 2,
      recommended: "maker_verifier"
    });
    expect(route).toMatchObject({ strategy: "maker_verifier", strategySource: "model", verificationRequired: true });
    expect(route.reasons).toContainEqual({ code: "strategy_model_choice", detail: "maker_verifier" });
  });

  it("rejects a recommendation outside the candidate set and never repairs it", () => {
    for (const bad of [
      "parallel_candidates",
      "specialist_delegation",
      "cua_recovery",
      "run_everything",
      "single; DROP TABLE"
    ]) {
      const route = deriveRouteEnrichment({ unit: unit("shell"), eligibleCount: 2, recommended: bad });
      expect(route).toMatchObject({ strategy: "single", strategySource: "deterministic", parallelism: 1 });
      expect(route.reasons).toContainEqual(expect.objectContaining({ code: "strategy_recommendation_rejected" }));
    }
    const hostile = deriveRouteEnrichment({
      unit: unit("shell"),
      eligibleCount: 2,
      recommended: `x'"\n${"y".repeat(300)}`
    });
    expect(hostile.reasons.find((reason) => reason.code === "strategy_recommendation_rejected")?.detail).toMatch(
      /^x\?+y+$/u
    );
    expect(
      hostile.reasons.find((reason) => reason.code === "strategy_recommendation_rejected")?.detail!.length
    ).toBeLessThanOrEqual(64);
  });

  it("caps parallelism by policy and by the number of eligible executors, never by the model", () => {
    const capped = deriveRouteEnrichment({
      unit: unit("coding"),
      eligibleCount: 3,
      policy: { maxParallelism: 5 },
      recommended: "parallel_candidates"
    });
    expect(capped).toMatchObject({ strategy: "parallel_candidates", parallelism: 3 });
    const policyCap = deriveRouteEnrichment({
      unit: unit("coding"),
      eligibleCount: 10,
      policy: { maxParallelism: 2 },
      recommended: "parallel_candidates"
    });
    expect(policyCap.parallelism).toBe(2);
    expect(
      deriveRouteEnrichment({
        unit: unit("coding"),
        eligibleCount: 10,
        policy: { maxParallelism: 99 },
        recommended: "parallel_candidates"
      }).parallelism
    ).toBe(8);
  });

  it("carries model class and checkpoint/retry policy from ACS policy and defaults CUA checkpoints", () => {
    expect(
      deriveRouteEnrichment({
        unit: unit("coding"),
        eligibleCount: 1,
        policy: { modelClass: "frontier", retryPolicy: "none", checkpointPolicy: "per_unit" }
      })
    ).toMatchObject({ modelClass: "frontier", retryPolicy: "none", checkpointPolicy: "per_unit" });
    expect(deriveRouteEnrichment({ unit: unit("cua"), eligibleCount: 1 }).checkpointPolicy).toBe("per_logical_action");
    expect(deriveRouteEnrichment({ unit: unit("coding"), eligibleCount: 1 }).checkpointPolicy).toBeUndefined();
  });
});

describe("recommendStrategy", () => {
  const input = { candidates: ["single"] as const, unit: unit("coding"), eligibleCount: 2 };
  it("returns nothing without a chooser, and survives a thrown or hung chooser", async () => {
    expect(await recommendStrategy(undefined, input)).toBeUndefined();
    expect(await recommendStrategy(() => Promise.reject(new Error("boom")), input)).toBeUndefined();
    expect(
      await recommendStrategy(() => {
        throw new Error("sync");
      }, input)
    ).toBeUndefined();
    expect(await recommendStrategy(() => new Promise(() => undefined), input, 20)).toBeUndefined();
  });
  it("passes a string through and ignores anything else", async () => {
    expect(await recommendStrategy(() => "single", input)).toBe("single");
    expect(await recommendStrategy((() => 42) as never, input)).toBeUndefined();
  });
});
