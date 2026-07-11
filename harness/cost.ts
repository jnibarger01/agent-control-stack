import { MODEL_IDS, MODEL_REGISTRY, route, type LastFailure, type ModelId, type TaskClass } from "./routing.js";

/**
 * USD per million tokens, sourced from docs/platform-facts.md and verified
 * 2026-07-09 against https://docs.claude.com/en/docs/about-claude/pricing.
 */
export interface ModelPrice {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  effectiveFrom: string;
  effectiveThrough?: string;
  verifiedOn: "2026-07-09";
}

const fixedPrice = (inputUsdPerMTok: number, outputUsdPerMTok: number): readonly ModelPrice[] => [
  {
    inputUsdPerMTok,
    outputUsdPerMTok,
    effectiveFrom: "0000-01-01",
    verifiedOn: "2026-07-09"
  }
];

export const MODEL_PRICING: Record<ModelId, readonly ModelPrice[]> = {
  [MODEL_IDS.fable]: fixedPrice(10, 50),
  [MODEL_IDS.mythos]: fixedPrice(10, 50),
  [MODEL_IDS.opus]: fixedPrice(5, 25),
  [MODEL_IDS.sonnet]: [
    {
      inputUsdPerMTok: 2,
      outputUsdPerMTok: 10,
      effectiveFrom: "0000-01-01",
      effectiveThrough: "2026-08-31",
      verifiedOn: "2026-07-09"
    },
    {
      inputUsdPerMTok: 3,
      outputUsdPerMTok: 15,
      effectiveFrom: "2026-09-01",
      verifiedOn: "2026-07-09"
    }
  ],
  [MODEL_IDS.haiku]: fixedPrice(1, 5)
};

export interface CostInput {
  modelId: ModelId;
  inputTokens: number;
  outputTokens: number;
  onDate: string;
}

export interface CostEstimate extends CostInput {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
  inputUsd: number;
  outputUsd: number;
  totalUsd: number;
  pricingVerifiedOn: "2026-07-09";
}

export interface RoutedCostInput extends Omit<CostInput, "modelId"> {
  taskClass: TaskClass;
  attempt: number;
  lastFailure: LastFailure;
}

export function priceFor(modelId: ModelId, onDate: string): ModelPrice {
  assertModelId(modelId);
  assertIsoDate(onDate);
  const price = MODEL_PRICING[modelId].find(
    (candidate) =>
      candidate.effectiveFrom <= onDate &&
      (candidate.effectiveThrough === undefined || onDate <= candidate.effectiveThrough)
  );
  if (!price) throw new Error(`no verified price for ${modelId} on ${onDate}`);
  return price;
}

export function estimateCost(input: CostInput): CostEstimate {
  assertTokenCount(input.inputTokens, "inputTokens");
  assertTokenCount(input.outputTokens, "outputTokens");
  const price = priceFor(input.modelId, input.onDate);
  const inputUsd = (input.inputTokens / 1_000_000) * price.inputUsdPerMTok;
  const outputUsd = (input.outputTokens / 1_000_000) * price.outputUsdPerMTok;
  return {
    ...input,
    inputUsdPerMTok: price.inputUsdPerMTok,
    outputUsdPerMTok: price.outputUsdPerMTok,
    inputUsd,
    outputUsd,
    totalUsd: inputUsd + outputUsd,
    pricingVerifiedOn: price.verifiedOn
  };
}

export function estimateRoutedCost(input: RoutedCostInput): CostEstimate {
  const modelId = route(input.taskClass, input.attempt, input.lastFailure);
  return estimateCost({
    modelId,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    onDate: input.onDate
  });
}

function assertModelId(value: string): asserts value is ModelId {
  if (!(value in MODEL_REGISTRY)) throw new Error(`unknown model ID: ${value}`);
}

function assertTokenCount(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}

function assertIsoDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("onDate must use YYYY-MM-DD");
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error("onDate must be a valid YYYY-MM-DD date");
  }
}
