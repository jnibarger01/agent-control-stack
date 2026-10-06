/**
 * Mission budgets. ACS enforces them from durable state; no worker or agent self-enforces.
 *
 * A metric with no configured limit is uncapped. A capped metric that only a worker can report (tool calls, tokens,
 * spend) and that has never been reported is returned as `unaccounted`, so absence of accounting is never read as zero.
 */
export interface MissionBudget {
  maxWallClockMs?: number;
  maxToolCalls?: number;
  maxWorkUnits?: number;
  maxParallelWorkUnits?: number;
  maxRetriesPerWorkUnit?: number;
  maxChildDepth?: number;
  maxChildWorkUnits?: number;
  maxModelTokens?: number;
  maxSpendUsd?: number;
}

/** Defaults for agent delegation. Policy overrides them per mission; they are not universal constants. */
export const DEFAULT_DELEGATION_BUDGET: Readonly<MissionBudget> = Object.freeze({
  maxChildDepth: 2,
  maxParallelWorkUnits: 4,
  maxChildWorkUnits: 8,
  maxRetriesPerWorkUnit: 2
});

export type BudgetMetric =
  | "wall_clock_ms"
  | "tool_calls"
  | "work_units"
  | "parallel_work_units"
  | "retries_per_work_unit"
  | "child_depth"
  | "child_work_units"
  | "model_tokens"
  | "spend_micro_usd";

/** Metrics ACS measures itself from durable state, versus metrics that depend on worker-reported usage. */
export const REPORTED_METRICS: readonly BudgetMetric[] = ["tool_calls", "model_tokens", "spend_micro_usd"];

export interface BudgetLimits {
  wall_clock_ms?: number;
  tool_calls?: number;
  work_units?: number;
  parallel_work_units?: number;
  retries_per_work_unit?: number;
  child_depth?: number;
  child_work_units?: number;
  model_tokens?: number;
  spend_micro_usd?: number;
}

/** What the operation being checked would bring each metric to. Undefined means "not measured by this check". */
export type BudgetProjection = Partial<Record<BudgetMetric, number>>;

export interface BudgetDecision {
  allowed: boolean;
  /** Metrics whose cap the projection exceeds. */
  exhausted: Array<{ metric: BudgetMetric; limit: number; projected: number }>;
  /** Capped worker-reported metrics that have never been reported, so cannot be judged. */
  unaccounted: BudgetMetric[];
}

export function budgetToLimits(budget: MissionBudget): BudgetLimits {
  const limits: BudgetLimits = {};
  const copy = <K extends keyof BudgetLimits>(key: K, value: number | undefined) => {
    if (value === undefined) return;
    if (!Number.isFinite(value) || value < 0) throw new RangeError(`budget ${key} must be a non-negative number`);
    limits[key] = value;
  };
  copy("wall_clock_ms", budget.maxWallClockMs);
  copy("tool_calls", budget.maxToolCalls);
  copy("work_units", budget.maxWorkUnits);
  copy("parallel_work_units", budget.maxParallelWorkUnits);
  copy("retries_per_work_unit", budget.maxRetriesPerWorkUnit);
  copy("child_depth", budget.maxChildDepth);
  copy("child_work_units", budget.maxChildWorkUnits);
  copy("model_tokens", budget.maxModelTokens);
  copy("spend_micro_usd", budget.maxSpendUsd === undefined ? undefined : Math.round(budget.maxSpendUsd * 1_000_000));
  for (const key of ["wall_clock_ms", "parallel_work_units"] as const) {
    if (limits[key] !== undefined && limits[key]! < 1) throw new RangeError(`budget ${key} must be at least 1`);
  }
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isInteger(value)) throw new RangeError(`budget ${key} must be an integer`);
  }
  return limits;
}

export function evaluateBudget(
  limits: BudgetLimits,
  projection: BudgetProjection,
  reported: ReadonlySet<BudgetMetric> = new Set()
): BudgetDecision {
  const exhausted: BudgetDecision["exhausted"] = [];
  const unaccounted: BudgetMetric[] = [];
  for (const [metric, projected] of Object.entries(projection) as Array<[BudgetMetric, number]>) {
    const limit = limits[metric];
    if (limit === undefined) continue;
    if (projected > limit) exhausted.push({ metric, limit, projected });
  }
  for (const metric of REPORTED_METRICS) {
    if (limits[metric] !== undefined && !reported.has(metric) && projection[metric] === undefined) {
      unaccounted.push(metric);
    }
  }
  return { allowed: exhausted.length === 0, exhausted, unaccounted };
}
