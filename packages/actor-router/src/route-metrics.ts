/**
 * Shadow comparison metrics and promotion-gate evaluation (ADR 0025).
 *
 * Pure functions over `RoutingComparison` rows. They never fabricate accounting: a metric that was not reported is
 * counted as not reported, never as zero, and a gate that the collected data cannot decide is UNPROVEN, never PASS.
 */
import type { RoutingComparison } from "@agent-control-stack/work-items";

const PASSED_VERIFICATION = new Set(["passed", "pass", "PASS", "verified", "succeeded"]);

export interface Percentiles {
  p50: number;
  p95: number;
}

export interface RoutingSummary {
  decisions: number;
  routed: number;
  rejected: number;
  enriched: number;
  bySource: Record<string, { decisions: number; withOutcome: number; successRate?: number }>;
  byStrategy: Record<string, { decisions: number; withOutcome: number; successRate?: number }>;
  outcomes: {
    count: number;
    successes: number;
    verified: number;
    timedOut: number;
    retries: number;
    wallMs?: Percentiles;
    toolCalls: { reportedFor: number; total: number };
    modelTokens: { reportedFor: number; total: number };
    costMicroUsd: { reportedFor: number; total: number };
  };
  jev: {
    observed: number;
    byStatus: Record<string, number>;
    validOutputRate?: number;
    invalidRecommendationRate?: number;
    agreementRate?: number;
    disagreements: number;
    /** Success rate of the executed route on the decisions where Jev agreed with it. */
    successWhenAgreed?: number;
    /** Recommendations that named an executor hard policy had excluded. Any is a hard failure. */
    policyViolations: number;
    latencyP95Ms?: number;
    /** Decisions with both a Jev recommendation and a verified outcome. */
    trustedOutcomes: number;
  };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

function rate(numerator: number, denominator: number): number | undefined {
  return denominator === 0 ? undefined : numerator / denominator;
}

export function summarizeRoutingComparisons(rows: readonly RoutingComparison[]): RoutingSummary {
  const group = (key: (row: RoutingComparison) => string | undefined) => {
    const out: Record<string, { decisions: number; withOutcome: number; successes: number }> = {};
    for (const row of rows) {
      const name = key(row);
      if (!name) continue;
      const entry = (out[name] ??= { decisions: 0, withOutcome: 0, successes: 0 });
      entry.decisions += 1;
      if (row.success !== undefined) {
        entry.withOutcome += 1;
        if (row.success) entry.successes += 1;
      }
    }
    return Object.fromEntries(
      Object.entries(out).map(([name, value]) => {
        const successRate = rate(value.successes, value.withOutcome);
        return [
          name,
          {
            decisions: value.decisions,
            withOutcome: value.withOutcome,
            ...(successRate === undefined ? {} : { successRate })
          }
        ];
      })
    );
  };

  const withOutcome = rows.filter((row) => row.success !== undefined);
  const wall = withOutcome.flatMap((row) => (row.wallMs === undefined ? [] : [row.wallMs])).sort((a, b) => a - b);
  const account = (pick: (row: RoutingComparison) => number | undefined) => {
    const values = withOutcome.flatMap((row) => {
      const value = pick(row);
      return value === undefined ? [] : [value];
    });
    return { reportedFor: values.length, total: values.reduce((sum, value) => sum + value, 0) };
  };

  const shadowed = rows.filter((row) => row.jevStatus !== undefined);
  const byStatus: Record<string, number> = {};
  for (const row of shadowed) byStatus[row.jevStatus!] = (byStatus[row.jevStatus!] ?? 0) + 1;
  const recommended = byStatus.recommended ?? 0;
  const invalid = byStatus.invalid_recommendation ?? 0;
  const agreed = shadowed.filter((row) => row.jevAgrees === true);
  const disagreed = shadowed.filter((row) => row.jevAgrees === false);
  const agreedWithOutcome = agreed.filter((row) => row.success !== undefined);
  const jevLatency = shadowed
    .flatMap((row) => (row.jevLatencyMs === undefined ? [] : [row.jevLatencyMs]))
    .sort((a, b) => a - b);
  const trusted = shadowed.filter(
    (row) => row.jevRecommended !== undefined && row.success !== undefined && row.verificationResult !== undefined
  );
  const policyViolations = shadowed.filter(
    (row) => row.jevRecommended !== undefined && row.excluded.includes(row.jevRecommended)
  ).length;
  const validOutputRate = rate(recommended, shadowed.length);
  const invalidRate = rate(invalid, recommended + invalid);
  const agreementRate = rate(agreed.length, agreed.length + disagreed.length);
  const successWhenAgreed = rate(agreedWithOutcome.filter((row) => row.success).length, agreedWithOutcome.length);

  return {
    decisions: rows.length,
    routed: rows.filter((row) => row.decision !== "reject").length,
    rejected: rows.filter((row) => row.decision === "reject").length,
    enriched: rows.filter((row) => row.strategy !== undefined).length,
    bySource: group((row) => row.source),
    byStrategy: group((row) => row.strategy),
    outcomes: {
      count: withOutcome.length,
      successes: withOutcome.filter((row) => row.success).length,
      verified: withOutcome.filter((row) => row.verificationResult && PASSED_VERIFICATION.has(row.verificationResult))
        .length,
      timedOut: withOutcome.filter((row) => row.timedOut).length,
      retries: withOutcome.reduce((sum, row) => sum + (row.retryCount ?? 0), 0),
      ...(wall.length > 0 ? { wallMs: { p50: percentile(wall, 50), p95: percentile(wall, 95) } } : {}),
      toolCalls: account((row) => row.toolCalls),
      modelTokens: account((row) => row.modelTokens),
      costMicroUsd: account((row) => row.costMicroUsd)
    },
    jev: {
      observed: shadowed.length,
      byStatus,
      ...(validOutputRate === undefined ? {} : { validOutputRate }),
      ...(invalidRate === undefined ? {} : { invalidRecommendationRate: invalidRate }),
      ...(agreementRate === undefined ? {} : { agreementRate }),
      disagreements: disagreed.length,
      ...(successWhenAgreed === undefined ? {} : { successWhenAgreed }),
      policyViolations,
      ...(jevLatency.length > 0 ? { latencyP95Ms: percentile(jevLatency, 95) } : {}),
      trustedOutcomes: trusted.length
    }
  };
}

export interface PromotionThresholds {
  minTrustedOutcomes: number;
  minValidOutputRate: number;
  maxInvalidRecommendationRate: number;
  maxLatencyP95Ms: number;
}

/** The ADR 0025 initial thresholds. They must be re-baselined against measured incumbent data before any promotion. */
export const DEFAULT_PROMOTION_THRESHOLDS: Readonly<PromotionThresholds> = Object.freeze({
  minTrustedOutcomes: 500,
  minValidOutputRate: 0.99,
  maxInvalidRecommendationRate: 0.005,
  maxLatencyP95Ms: 1500
});

export type GateStatus = "PASS" | "FAIL" | "UNPROVEN";
export interface GateResult {
  id: string;
  status: GateStatus;
  value?: number;
  threshold?: number;
  reason: string;
}

export interface PromotionEvaluation {
  gates: GateResult[];
  /** PROMOTABLE only when every gate PASSes. UNPROVEN is never a pass. */
  verdict: "PROMOTABLE" | "NOT_PROMOTABLE";
}

export function evaluateShadowGates(
  summary: RoutingSummary,
  thresholds: PromotionThresholds = DEFAULT_PROMOTION_THRESHOLDS
): PromotionEvaluation {
  const { jev } = summary;
  const enoughSample = jev.trustedOutcomes >= thresholds.minTrustedOutcomes;
  const sample = (
    value: number | undefined,
    status: (v: number) => GateStatus,
    id: string,
    threshold: number,
    reason: string
  ): GateResult => {
    if (value === undefined) return { id, status: "UNPROVEN", threshold, reason: "no observations" };
    if (!enoughSample) {
      return {
        id,
        status: "UNPROVEN",
        value,
        threshold,
        reason: `needs ${thresholds.minTrustedOutcomes} trusted outcomes, has ${jev.trustedOutcomes}`
      };
    }
    return { id, status: status(value), value, threshold, reason };
  };
  const counterfactual = (id: string, why: string): GateResult => ({ id, status: "UNPROVEN", reason: why });
  const gates: GateResult[] = [
    {
      id: "minimum_sample",
      status: enoughSample ? "PASS" : "UNPROVEN",
      value: jev.trustedOutcomes,
      threshold: thresholds.minTrustedOutcomes,
      reason: "decisions with a Jev recommendation and a verified outcome"
    },
    // A policy violation is a hard failure at any sample size.
    {
      id: "policy_violations",
      status: jev.policyViolations === 0 ? (jev.observed > 0 ? "PASS" : "UNPROVEN") : "FAIL",
      value: jev.policyViolations,
      threshold: 0,
      reason: "recommendations naming an executor excluded by hard policy"
    },
    sample(
      jev.validOutputRate,
      (v) => (v >= thresholds.minValidOutputRate ? "PASS" : "FAIL"),
      "valid_output_rate",
      thresholds.minValidOutputRate,
      "recommended / all shadowed decisions"
    ),
    sample(
      jev.invalidRecommendationRate,
      (v) => (v <= thresholds.maxInvalidRecommendationRate ? "PASS" : "FAIL"),
      "invalid_recommendation_rate",
      thresholds.maxInvalidRecommendationRate,
      "invalid / (recommended + invalid)"
    ),
    sample(
      jev.latencyP95Ms,
      (v) => (v <= thresholds.maxLatencyP95Ms ? "PASS" : "FAIL"),
      "latency_p95_ms",
      thresholds.maxLatencyP95Ms,
      "p95 Jev recommendation latency"
    ),
    counterfactual(
      "agreement_vs_incumbent",
      "single-choice outcomes cannot show Jev beating the incumbent; needs counterfactual labels"
    ),
    counterfactual(
      "decision_regret",
      "needs the best observed outcome among candidates, which a single executed choice does not provide"
    ),
    counterfactual(
      "stability",
      "needs repeated recommendations for identical inputs, which shadow mode does not collect"
    ),
    counterfactual("confidence_calibration", "needs correctness labels for non-executed recommendations"),
    counterfactual(
      "cost_impact",
      "needs the counterfactual cost of the recommended executor; reported cost covers only the executed route"
    )
  ];
  return { gates, verdict: gates.every((gate) => gate.status === "PASS") ? "PROMOTABLE" : "NOT_PROMOTABLE" };
}
