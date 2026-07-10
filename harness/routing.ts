/**
 * Model IDs and availability are sourced from docs/platform-facts.md, verified
 * 2026-07-09. Official sources:
 * https://docs.claude.com/en/docs/about-claude/models/overview
 * https://docs.claude.com/en/docs/about-claude/models/introducing-claude-fable-5-and-claude-mythos-5
 */
export const MODEL_IDS = {
  fable: "claude-fable-5",
  mythos: "claude-mythos-5",
  opus: "claude-opus-4-8",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5-20251001"
} as const;

export type ModelId = (typeof MODEL_IDS)[keyof typeof MODEL_IDS];

export const MODEL_REGISTRY = {
  [MODEL_IDS.fable]: {
    displayName: "Claude Fable 5",
    availability: "general",
    verifiedOn: "2026-07-09"
  },
  [MODEL_IDS.mythos]: {
    displayName: "Claude Mythos 5",
    availability: "limited",
    verifiedOn: "2026-07-09"
  },
  [MODEL_IDS.opus]: {
    displayName: "Claude Opus 4.8",
    availability: "general",
    verifiedOn: "2026-07-09"
  },
  [MODEL_IDS.sonnet]: {
    displayName: "Claude Sonnet 5",
    availability: "general",
    verifiedOn: "2026-07-09"
  },
  [MODEL_IDS.haiku]: {
    displayName: "Claude Haiku 4.5",
    availability: "general",
    verifiedOn: "2026-07-09"
  }
} as const satisfies Record<
  ModelId,
  { displayName: string; availability: "general" | "limited"; verifiedOn: "2026-07-09" }
>;

export const GENERAL_AVAILABILITY = Object.freeze([
  MODEL_IDS.fable,
  MODEL_IDS.opus,
  MODEL_IDS.sonnet,
  MODEL_IDS.haiku
] as const);

export const TASK_CLASSES = [
  "orchestration",
  "planning",
  "refusal_sensitive_frontier",
  "hard_subtask",
  "bulk_worker",
  "grader",
  "classifier"
] as const;

export type TaskClass = (typeof TASK_CLASSES)[number];
export const DEESCALATION_AGREEMENT_RUNS = 3;

interface AvailabilityOverride {
  availableModelIds?: readonly ModelId[];
}

export type LastFailure =
  | ({ kind: "availability" } & AvailabilityOverride)
  | ({ kind: "verifier_failure" } & AvailabilityOverride)
  | ({ kind: "grader_disagreement" } & AvailabilityOverride)
  | ({ kind: "refusal"; modelId: ModelId } & AvailabilityOverride)
  | ({ kind: "agreement"; agreementRuns: number; currentModelId: ModelId } & AvailabilityOverride)
  | null;

type RouteTier = "cheap" | "bulk" | "frontier" | "hard";

const tierRank: Record<RouteTier, number> = { cheap: 0, bulk: 1, frontier: 2, hard: 3 };

const baseTier: Record<TaskClass, RouteTier> = {
  orchestration: "frontier",
  planning: "frontier",
  refusal_sensitive_frontier: "frontier",
  hard_subtask: "hard",
  bulk_worker: "bulk",
  grader: "cheap",
  classifier: "cheap"
};

const tierOrder: Record<RouteTier, readonly ModelId[]> = {
  cheap: [MODEL_IDS.haiku, MODEL_IDS.sonnet, MODEL_IDS.opus, MODEL_IDS.fable, MODEL_IDS.mythos],
  bulk: [MODEL_IDS.sonnet, MODEL_IDS.opus, MODEL_IDS.fable, MODEL_IDS.haiku, MODEL_IDS.mythos],
  frontier: [MODEL_IDS.fable, MODEL_IDS.mythos, MODEL_IDS.opus, MODEL_IDS.sonnet, MODEL_IDS.haiku],
  // Fable is deliberately absent: this tier is also the classifier-refusal fallback.
  hard: [MODEL_IDS.mythos, MODEL_IDS.opus, MODEL_IDS.sonnet, MODEL_IDS.haiku]
};

/**
 * Route one task to an exact canonical model ID.
 *
 * `attempt` is the count of consecutive verifier failures for the current task.
 * Mythos is never assumed available; callers must include it explicitly in
 * `lastFailure.availableModelIds`. Availability input order never affects the
 * result.
 */
export function route(taskClass: TaskClass, attempt: number, lastFailure: LastFailure): ModelId {
  assertTaskClass(taskClass);
  assertNonNegativeInteger(attempt, "attempt");
  const available = availability(lastFailure?.availableModelIds);
  const defaultTier = baseTier[taskClass];

  if (!lastFailure || lastFailure.kind === "availability") {
    return select(defaultTier, available);
  }

  if (lastFailure.kind === "refusal") {
    assertModelId(lastFailure.modelId);
    return select("hard", available);
  }

  if (lastFailure.kind === "grader_disagreement") {
    return select(escalate(defaultTier), available);
  }

  if (lastFailure.kind === "verifier_failure") {
    return select(attempt >= 2 ? escalate(defaultTier) : defaultTier, available);
  }

  assertNonNegativeInteger(lastFailure.agreementRuns, "agreementRuns");
  assertModelId(lastFailure.currentModelId);
  if (lastFailure.agreementRuns >= DEESCALATION_AGREEMENT_RUNS) {
    return select(defaultTier, available);
  }
  return select(modelTier(lastFailure.currentModelId), available);
}

export type Route = typeof route;

function availability(override: readonly ModelId[] | undefined): ReadonlySet<ModelId> {
  const values = override ?? GENERAL_AVAILABILITY;
  if (values.length === 0) {
    throw new Error("at least one available model is required");
  }
  for (const modelId of values) assertModelId(modelId);
  return new Set(values);
}

function select(tier: RouteTier, available: ReadonlySet<ModelId>): ModelId {
  const selected = tierOrder[tier].find((modelId) => available.has(modelId));
  if (!selected) {
    throw new Error(`no available model satisfies the ${tier} route`);
  }
  return selected;
}

function escalate(tier: RouteTier): RouteTier {
  const nextRank = Math.min(tierRank[tier] + 1, tierRank.hard);
  return (Object.keys(tierRank) as RouteTier[]).find((candidate) => tierRank[candidate] === nextRank)!;
}

function modelTier(modelId: ModelId): RouteTier {
  if (modelId === MODEL_IDS.haiku) return "cheap";
  if (modelId === MODEL_IDS.sonnet) return "bulk";
  if (modelId === MODEL_IDS.fable) return "frontier";
  return "hard";
}

function assertTaskClass(value: string): asserts value is TaskClass {
  if (!(TASK_CLASSES as readonly string[]).includes(value)) {
    throw new Error(`unknown task class: ${value}`);
  }
}

function assertModelId(value: string): asserts value is ModelId {
  if (!(value in MODEL_REGISTRY)) {
    throw new Error(`unknown model ID: ${value}`);
  }
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
}
