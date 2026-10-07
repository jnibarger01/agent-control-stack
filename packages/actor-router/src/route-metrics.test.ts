import type { RoutingComparison } from "@agent-control-stack/work-items";
import { describe, expect, it } from "vitest";
import { DEFAULT_PROMOTION_THRESHOLDS, evaluateShadowGates, summarizeRoutingComparisons } from "./route-metrics.js";

let n = 0;
function row(overrides: Partial<RoutingComparison> = {}): RoutingComparison {
  n += 1;
  return {
    decisionId: `d${n}`,
    workItemId: `w${n}`,
    decision: "route",
    source: "nimble",
    reasonCode: "nimble_choice",
    executorId: "alpha",
    candidates: ["alpha", "beta"],
    excluded: [],
    decidedAt: "2026-10-06T00:00:00.000Z",
    ...overrides
  };
}

describe("summarizeRoutingComparisons", () => {
  it("counts decisions, enrichment, sources and strategies without inventing outcomes", () => {
    const summary = summarizeRoutingComparisons([
      row({ strategy: "single", success: true, verificationResult: "passed", wallMs: 100, retryCount: 0 }),
      row({ strategy: "single", success: false, wallMs: 300, retryCount: 2 }),
      row({ source: "deterministic_fallback", decision: "fallback", strategy: "maker_verifier" }),
      row({ decision: "reject", reasonCode: "no_eligible_candidate", executorId: undefined })
    ]);
    expect(summary).toMatchObject({ decisions: 4, routed: 3, rejected: 1, enriched: 3 });
    expect(summary.bySource.nimble).toEqual({ decisions: 3, withOutcome: 2, successRate: 0.5 });
    expect(summary.bySource.deterministic_fallback).toEqual({ decisions: 1, withOutcome: 0 });
    expect(summary.byStrategy.single).toEqual({ decisions: 2, withOutcome: 2, successRate: 0.5 });
    expect(summary.outcomes).toMatchObject({
      count: 2,
      successes: 1,
      verified: 1,
      retries: 2,
      wallMs: { p50: 100, p95: 300 }
    });
  });

  it("reports accounting as reported-for-N, never as zero", () => {
    const summary = summarizeRoutingComparisons([
      row({ success: true, toolCalls: 4, modelTokens: 1000, costMicroUsd: 250 }),
      row({ success: true }),
      row({ success: true, toolCalls: 6 })
    ]);
    expect(summary.outcomes.toolCalls).toEqual({ reportedFor: 2, total: 10 });
    expect(summary.outcomes.modelTokens).toEqual({ reportedFor: 1, total: 1000 });
    expect(summary.outcomes.costMicroUsd).toEqual({ reportedFor: 1, total: 250 });
    expect(summarizeRoutingComparisons([row({ success: true })]).outcomes.costMicroUsd).toEqual({
      reportedFor: 0,
      total: 0
    });
  });

  it("summarizes the Jev shadow, including policy violations against the excluded set", () => {
    const summary = summarizeRoutingComparisons([
      row({
        jevStatus: "recommended",
        jevRecommended: "alpha",
        jevAgrees: true,
        jevLatencyMs: 40,
        success: true,
        verificationResult: "passed"
      }),
      row({
        jevStatus: "recommended",
        jevRecommended: "beta",
        jevAgrees: false,
        jevLatencyMs: 90,
        success: false,
        verificationResult: "failed"
      }),
      row({ jevStatus: "invalid_recommendation", jevRecommended: "gamma", excluded: ["gamma"], jevLatencyMs: 60 }),
      row({ jevStatus: "degraded", jevLatencyMs: 10 }),
      row()
    ]);
    expect(summary.jev).toMatchObject({
      observed: 4,
      byStatus: { recommended: 2, invalid_recommendation: 1, degraded: 1 },
      validOutputRate: 0.5,
      invalidRecommendationRate: 1 / 3,
      agreementRate: 0.5,
      disagreements: 1,
      successWhenAgreed: 1,
      policyViolations: 1,
      latencyP95Ms: 90,
      trustedOutcomes: 2
    });
  });
});

describe("evaluateShadowGates", () => {
  const healthy = (count: number) =>
    summarizeRoutingComparisons(
      Array.from({ length: count }, (_, index) =>
        row({
          jevStatus: "recommended",
          jevRecommended: "alpha",
          jevAgrees: index % 2 === 0,
          jevLatencyMs: 50,
          success: true,
          verificationResult: "passed"
        })
      )
    );

  it("treats a thin sample as UNPROVEN, not passed", () => {
    const evaluation = evaluateShadowGates(healthy(10));
    const by = Object.fromEntries(evaluation.gates.map((gate) => [gate.id, gate]));
    expect(by.minimum_sample?.status).toBe("UNPROVEN");
    expect(by.valid_output_rate?.status).toBe("UNPROVEN");
    expect(by.valid_output_rate?.reason).toMatch(/needs 500 trusted outcomes, has 10/);
    expect(evaluation.verdict).toBe("NOT_PROMOTABLE");
  });

  it("passes the measurable gates at sample, yet stays NOT_PROMOTABLE because the comparative gates are unproven", () => {
    const evaluation = evaluateShadowGates(healthy(DEFAULT_PROMOTION_THRESHOLDS.minTrustedOutcomes));
    const by = Object.fromEntries(evaluation.gates.map((gate) => [gate.id, gate.status]));
    expect(by).toMatchObject({
      minimum_sample: "PASS",
      policy_violations: "PASS",
      valid_output_rate: "PASS",
      invalid_recommendation_rate: "PASS",
      latency_p95_ms: "PASS",
      agreement_vs_incumbent: "UNPROVEN",
      decision_regret: "UNPROVEN",
      stability: "UNPROVEN",
      confidence_calibration: "UNPROVEN",
      cost_impact: "UNPROVEN"
    });
    expect(evaluation.verdict).toBe("NOT_PROMOTABLE");
  });

  it("fails on a single policy violation regardless of sample size", () => {
    const summary = summarizeRoutingComparisons([
      row({ jevStatus: "invalid_recommendation", jevRecommended: "gamma", excluded: ["gamma"] })
    ]);
    expect(evaluateShadowGates(summary).gates.find((gate) => gate.id === "policy_violations")).toMatchObject({
      status: "FAIL",
      value: 1
    });
  });

  it("fails the rate gates when the data is large enough and Jev is bad", () => {
    const bad = summarizeRoutingComparisons(
      Array.from({ length: 1200 }, (_, index) =>
        row({
          jevStatus: index % 2 === 0 ? "degraded" : "recommended",
          jevRecommended: index % 2 === 0 ? undefined : "alpha",
          jevAgrees: index % 2 === 0 ? undefined : true,
          jevLatencyMs: 5000,
          success: true,
          verificationResult: "passed"
        })
      )
    );
    const by = Object.fromEntries(evaluateShadowGates(bad).gates.map((gate) => [gate.id, gate.status]));
    expect(by.valid_output_rate).toBe("FAIL");
    expect(by.latency_p95_ms).toBe("FAIL");
  });

  it("reports nothing as PASS when there are no observations", () => {
    const evaluation = evaluateShadowGates(summarizeRoutingComparisons([]));
    expect(evaluation.gates.every((gate) => gate.status === "UNPROVEN")).toBe(true);
    expect(evaluation.verdict).toBe("NOT_PROMOTABLE");
  });
});
