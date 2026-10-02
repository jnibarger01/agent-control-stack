import type { DecisionType } from "./schemas.js";

/** Confidence required before a Nimble selection may be offered to policy. */
export const DEFAULT_CONFIDENCE_THRESHOLDS: Readonly<Record<DecisionType, number>> = {
  route: 0.8,
  next_operation: 0.8,
  relevance: 0.8,
  done: 0.9,
  risk: 0.8
};

/** Relevance keep is a code cutoff on the score, separate from confidence. */
export const RELEVANCE_KEEP_CUTOFF = 0.5;

export type ConfidenceThresholds = Readonly<Record<DecisionType, number>>;

export function confidenceThreshold(type: DecisionType, overrides?: Partial<ConfidenceThresholds>): number {
  return overrides?.[type] ?? DEFAULT_CONFIDENCE_THRESHOLDS[type];
}

export function relevanceKeep(score: number, cutoff = RELEVANCE_KEEP_CUTOFF): boolean {
  return score >= cutoff;
}
