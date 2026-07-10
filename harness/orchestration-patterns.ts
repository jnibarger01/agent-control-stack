import { estimateCost } from "./cost.js";
import type {
  CompletionRequest,
  CompletionResult,
  ModelProvider,
  ModelTokenUsage
} from "./model-provider.js";
import type { ModelId } from "./routing.js";

export const SYNTHESIS_BARRIER_RUBRIC = Object.freeze([
  {
    criterionId: "deduplicate",
    description: "Merge materially equivalent claims without dropping their source slices."
  },
  {
    criterionId: "resolve-conflicts",
    description: "Identify every material contradiction and resolve it or mark it unresolved."
  },
  {
    criterionId: "preserve-coverage",
    description: "Represent every worker slice in the synthesis or explain its exclusion."
  }
] as const);

export interface TokenEstimate {
  inputTokens: number;
  outputTokens: number;
}

export interface InvocationPlan {
  model: ModelId;
  estimate: TokenEstimate;
}

export interface PatternCaps {
  maxTokens: number;
  maxWallClockMs: number;
  maxSpendUsd: number;
}

export interface LoopCaps extends PatternCaps {
  maxIterations: number;
}

export interface PatternCallReceipt {
  role: string;
  requestedModel: ModelId;
  exactModels: string[];
  predictedCostUsd: number;
  actualCostUsd: number;
  usage: ModelTokenUsage;
}

export interface PatternSpendReceipt {
  predictedCostUsd: number;
  actualCostUsd: number;
  usage: ModelTokenUsage;
  exactModels: string[];
  calls: PatternCallReceipt[];
}

export interface PatternSpendLog extends PatternSpendReceipt {
  pattern: "fanOutSynthesize" | "adversarial" | "loopUntilDone";
  status: "completed" | "failed";
  failureCode?: string;
}

export type PatternSpendLogger = (entry: PatternSpendLog) => void;

interface PatternRuntime {
  provider: ModelProvider;
  pricingDate: string;
  caps: PatternCaps;
  now?: () => number;
  log: PatternSpendLogger;
}

export interface FanOutSubtask {
  id: string;
  input: string;
}

export interface FanOutOptions extends PatternRuntime {
  worker: InvocationPlan;
  synthesizer: InvocationPlan;
}

export interface SynthesisConflict {
  left: string;
  right: string;
  resolution: string;
}

export interface SynthesisBarrierResult {
  output: string;
  deduplicatedClaims: string[];
  conflicts: SynthesisConflict[];
  rubric: Array<{ criterionId: string; pass: true; justification: string }>;
}

export interface FanOutResult {
  workerOutputs: Array<{ subtaskId: string; output: string }>;
  synthesis: SynthesisBarrierResult;
  spend: PatternSpendReceipt;
}

export interface AdversarialOptions extends PatternRuntime {
  maker: InvocationPlan;
  critic: InvocationPlan;
  judge: InvocationPlan;
}

export interface AdversarialResult {
  makerOutput: string;
  criticPosition: "refute" | "concede";
  criticRefutation: string;
  verdict: "maker" | "critic" | "mixed";
  output: string;
  justification: string;
  spend: PatternSpendReceipt;
}

export interface VerificationCriterion {
  id: string;
  description: string;
  expected: string;
}

export interface StructuredFailure {
  criterion: string;
  expected: string;
  observed: string;
}

export interface LoopOptions extends Omit<PatternRuntime, "caps"> {
  caps: LoopCaps;
  maker: InvocationPlan;
  verifier: InvocationPlan;
  rubric: readonly VerificationCriterion[];
}

export interface LoopResult {
  output: string;
  iterations: number;
  verified: true;
  spend: PatternSpendReceipt;
}

export type OrchestrationPatternErrorCode =
  | "invalid_input"
  | "iteration_cap"
  | "malformed_response"
  | "refusal"
  | "spend_cap"
  | "token_cap"
  | "wall_clock_cap";

export class OrchestrationPatternError extends Error {
  constructor(
    public readonly code: OrchestrationPatternErrorCode,
    message: string
  ) {
    super(message);
    this.name = "OrchestrationPatternError";
  }
}

export async function fanOutSynthesize(
  subtasks: readonly FanOutSubtask[],
  options: FanOutOptions
): Promise<FanOutResult> {
  validateSubtasks(subtasks);
  validateRuntime(options);
  validatePlan(options.worker, "worker");
  validatePlan(options.synthesizer, "synthesizer");

  const workerPrediction = predictedCost(options.worker, options.pricingDate);
  const synthesisPrediction = predictedCost(options.synthesizer, options.pricingDate);
  const predicted = workerPrediction * subtasks.length + synthesisPrediction;
  const meter = new RunMeter("fanOutSynthesize", predicted, options);

  try {
    meter.assertPredictedSpendFits();
    const workerBudget = proportionalBudget(workerPrediction, predicted, options.caps.maxSpendUsd);
    const workerSettlements = await Promise.allSettled(
      subtasks.map(async (subtask) => {
        const result = await meter.invoke(
          `worker:${subtask.id}`,
          options.worker,
          "You are an isolated worker. Answer only the supplied slice. Return JSON only; do not include chain-of-thought, hidden reasoning, or self-assessment.",
          JSON.stringify({ subtask: { id: subtask.id, input: subtask.input } }),
          WORKER_SCHEMA,
          workerBudget
        );
        return {
          subtaskId: subtask.id,
          output: requiredText(parseExactJson(result.text, ["output"], `worker:${subtask.id}`), "output")
        };
      })
    );
    const workerFailure = workerSettlements.find(
      (settlement): settlement is PromiseRejectedResult => settlement.status === "rejected"
    );
    if (workerFailure) throw workerFailure.reason;
    const workerResults = workerSettlements.map((settlement) =>
      (settlement as PromiseFulfilledResult<{ subtaskId: string; output: string }>).value
    );

    const synthesisResult = await meter.invoke(
      "synthesizer",
      options.synthesizer,
      "You are the synthesis barrier. Apply every supplied rubric criterion. Return JSON only; do not include chain-of-thought or hidden reasoning.",
      JSON.stringify({ workerOutputs: workerResults, rubric: SYNTHESIS_BARRIER_RUBRIC }),
      synthesisSchema()
    );
    const synthesis = parseSynthesis(synthesisResult.text);
    const spend = meter.complete();
    return { workerOutputs: workerResults, synthesis, spend };
  } catch (error) {
    meter.fail(error);
    throw error;
  }
}

export async function adversarial(task: string, options: AdversarialOptions): Promise<AdversarialResult> {
  boundedText(task, "task", 20_000);
  validateRuntime(options);
  validatePlan(options.maker, "maker");
  validatePlan(options.critic, "critic");
  validatePlan(options.judge, "judge");

  const predicted =
    predictedCost(options.maker, options.pricingDate) +
    predictedCost(options.critic, options.pricingDate) +
    predictedCost(options.judge, options.pricingDate);
  const meter = new RunMeter("adversarial", predicted, options);

  try {
    meter.assertPredictedSpendFits();
    const makerResult = await meter.invoke(
      "maker",
      options.maker,
      "Produce the strongest answer to the task. Return JSON only with the answer, not chain-of-thought, hidden reasoning, or self-assessment.",
      JSON.stringify({ task }),
      MAKER_SCHEMA
    );
    const makerOutput = requiredText(parseExactJson(makerResult.text, ["output"], "maker"), "output");

    const criticResult = await meter.invoke(
      "critic",
      options.critic,
      "Act as a refuting critic. Challenge material errors or unsupported claims in the supplied answer. Set position to refute when a material flaw exists; otherwise set position to concede. Return JSON only; do not include chain-of-thought or hidden reasoning.",
      JSON.stringify({ task, makerOutput }),
      CRITIC_SCHEMA
    );
    const criticized = parseExactJson(criticResult.text, ["position", "refutation"], "critic");
    const criticPosition = requiredText(criticized, "position");
    if (criticPosition !== "refute" && criticPosition !== "concede") {
      malformed("critic.position must be refute or concede");
    }
    const criticRefutation = requiredText(criticized, "refutation");

    const judgeResult = await meter.invoke(
      "judge",
      options.judge,
      "Judge only the task and the two visible outputs. You have no access to either agent's reasoning. Prefer material correctness over stylistic objections. The output field must be the corrected final answer that directly satisfies the task and its constraints, never analysis about the answer; put the decision rationale only in justification. Return JSON only.",
      JSON.stringify({
        task,
        makerOutput,
        criticPosition,
        criticRefutation,
        criteria: ["correctness", "materiality of refutation", "actionable final resolution"]
      }),
      JUDGE_SCHEMA
    );
    const judged = parseExactJson(judgeResult.text, ["verdict", "output", "justification"], "judge");
    const verdict = requiredText(judged, "verdict");
    if (verdict !== "maker" && verdict !== "critic" && verdict !== "mixed") {
      malformed("judge.verdict must be maker, critic, or mixed");
    }
    if (criticPosition === "concede" && verdict === "critic") {
      malformed("judge cannot select a conceding critic");
    }
    const spend = meter.complete();
    return {
      makerOutput,
      criticPosition,
      criticRefutation,
      verdict,
      output: requiredText(judged, "output"),
      justification: requiredText(judged, "justification"),
      spend
    };
  } catch (error) {
    meter.fail(error);
    throw error;
  }
}

export async function loopUntilDone(task: string, options: LoopOptions): Promise<LoopResult> {
  boundedText(task, "task", 20_000);
  validateRuntime(options);
  positiveInteger(options.caps.maxIterations, "maxIterations");
  validatePlan(options.maker, "maker");
  validatePlan(options.verifier, "verifier");
  validateRubric(options.rubric);

  const perIterationPrediction =
    predictedCost(options.maker, options.pricingDate) + predictedCost(options.verifier, options.pricingDate);
  const predicted = perIterationPrediction * options.caps.maxIterations;
  const meter = new RunMeter("loopUntilDone", predicted, options);
  let failures: StructuredFailure[] = [];

  try {
    meter.assertPredictedSpendFits();
    for (let iteration = 1; iteration <= options.caps.maxIterations; iteration += 1) {
      const makerResult = await meter.invoke(
        `maker:${iteration}`,
        options.maker,
        "Produce a candidate for the task. On retries, use only the structured failure list. Return JSON only; do not include chain-of-thought, hidden reasoning, or self-assessment.",
        JSON.stringify({ task, failures }),
        LOOP_MAKER_SCHEMA
      );
      const candidate = requiredText(parseExactJson(makerResult.text, ["candidate"], "loop maker"), "candidate");

      const verifierResult = await meter.invoke(
        `verifier:${iteration}`,
        options.verifier,
        "Independently verify the candidate against the rubric. You receive no maker reasoning or self-assessment. Return JSON only.",
        JSON.stringify({ task, rubric: options.rubric, candidate }),
        verifierSchema(options.rubric)
      );
      const verification = parseVerification(verifierResult.text);
      if (verification.pass) {
        const spend = meter.complete();
        return { output: candidate, iterations: iteration, verified: true, spend };
      }
      validateVerificationFailures(verification.failures, options.rubric);
      failures = verification.failures;
    }
    throw new OrchestrationPatternError(
      "iteration_cap",
      `verification did not pass within ${options.caps.maxIterations} iterations`
    );
  } catch (error) {
    meter.fail(error);
    throw error;
  }
}

class RunMeter {
  private readonly startedAt: number;
  private readonly now: () => number;
  private readonly calls: PatternCallReceipt[] = [];
  private usage: ModelTokenUsage = emptyUsage();
  private actualCostUsd = 0;
  private emitted = false;

  constructor(
    private readonly pattern: PatternSpendLog["pattern"],
    private readonly predictedCostUsd: number,
    private readonly runtime: PatternRuntime
  ) {
    this.now = runtime.now ?? Date.now;
    this.startedAt = this.now();
  }

  assertPredictedSpendFits(): void {
    if (this.predictedCostUsd > this.runtime.caps.maxSpendUsd) {
      throw new OrchestrationPatternError(
        "spend_cap",
        `predicted spend ${this.predictedCostUsd} exceeds cap ${this.runtime.caps.maxSpendUsd}`
      );
    }
  }

  async invoke(
    role: string,
    plan: InvocationPlan,
    system: string,
    prompt: string,
    jsonSchema: Record<string, unknown>,
    allocatedBudgetUsd?: number
  ): Promise<CompletionResult> {
    this.assertBeforeCall();
    const remainingMs = this.runtime.caps.maxWallClockMs - (this.now() - this.startedAt);
    const remainingSpend = this.runtime.caps.maxSpendUsd - this.actualCostUsd;
    const maxBudgetUsd = Math.min(remainingSpend, allocatedBudgetUsd ?? remainingSpend);
    if (!(maxBudgetUsd > 0)) {
      throw new OrchestrationPatternError("spend_cap", "no spend budget remains for another model call");
    }

    const request: CompletionRequest = {
      model: plan.model,
      system,
      prompt,
      maxBudgetUsd,
      timeoutMs: Math.max(1, Math.floor(remainingMs)),
      jsonSchema
    };
    const result = await this.runtime.provider.complete(request);
    validateCompletion(result, plan.model, role);

    const receipt: PatternCallReceipt = {
      role,
      requestedModel: plan.model,
      exactModels: [...result.exactModels],
      predictedCostUsd: predictedCost(plan, this.runtime.pricingDate),
      actualCostUsd: result.costUsd,
      usage: { ...result.usage }
    };
    this.calls.push(receipt);
    this.actualCostUsd += result.costUsd;
    this.usage = addUsage(this.usage, result.usage);

    if (result.refused || result.stopReason === "refusal") {
      throw new OrchestrationPatternError("refusal", `${role} returned a refusal`);
    }
    this.assertAfterCall();
    return result;
  }

  complete(): PatternSpendReceipt {
    const receipt = this.receipt();
    this.emit({ ...receipt, pattern: this.pattern, status: "completed" });
    return receipt;
  }

  fail(error: unknown): void {
    if (this.emitted) return;
    this.emit({
      ...this.receipt(),
      pattern: this.pattern,
      status: "failed",
      failureCode: error instanceof OrchestrationPatternError ? error.code : "provider_error"
    });
  }

  private assertBeforeCall(): void {
    if (tokenTotal(this.usage) >= this.runtime.caps.maxTokens) {
      throw new OrchestrationPatternError("token_cap", "token cap exhausted before model call");
    }
    if (this.actualCostUsd >= this.runtime.caps.maxSpendUsd) {
      throw new OrchestrationPatternError("spend_cap", "spend cap exhausted before model call");
    }
    if (this.now() - this.startedAt >= this.runtime.caps.maxWallClockMs) {
      throw new OrchestrationPatternError("wall_clock_cap", "wall-clock cap exhausted before model call");
    }
  }

  private assertAfterCall(): void {
    if (this.actualCostUsd > this.runtime.caps.maxSpendUsd) {
      throw new OrchestrationPatternError("spend_cap", "model receipts exceeded the hard spend cap");
    }
    if (tokenTotal(this.usage) > this.runtime.caps.maxTokens) {
      throw new OrchestrationPatternError("token_cap", "model receipts exceeded the hard token cap");
    }
    if (this.now() - this.startedAt > this.runtime.caps.maxWallClockMs) {
      throw new OrchestrationPatternError("wall_clock_cap", "model call exceeded the hard wall-clock cap");
    }
  }

  private receipt(): PatternSpendReceipt {
    return {
      predictedCostUsd: this.predictedCostUsd,
      actualCostUsd: this.actualCostUsd,
      usage: { ...this.usage },
      exactModels: [...new Set(this.calls.flatMap((call) => call.exactModels))].sort(),
      calls: this.calls.map((call) => ({ ...call, exactModels: [...call.exactModels], usage: { ...call.usage } }))
    };
  }

  private emit(entry: PatternSpendLog): void {
    this.emitted = true;
    this.runtime.log(entry);
  }
}

function parseSynthesis(text: string): SynthesisBarrierResult {
  const value = parseExactJson(text, ["output", "deduplicatedClaims", "conflicts", "rubric"], "synthesizer");
  const rubric = recordArray(value.rubric, "synthesizer.rubric").map((entry, index) => {
    exactKeys(entry, ["criterionId", "pass", "justification"], `synthesizer.rubric[${index}]`);
    const pass = requiredBoolean(entry, "pass");
    if (!pass) malformed(`synthesizer barrier criterion ${String(entry.criterionId)} did not pass`);
    return {
      criterionId: requiredText(entry, "criterionId"),
      pass: true as const,
      justification: requiredText(entry, "justification")
    };
  });
  const expectedIds = SYNTHESIS_BARRIER_RUBRIC.map((criterion) => criterion.criterionId).sort();
  const actualIds = rubric.map((criterion) => criterion.criterionId).sort();
  if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
    malformed("synthesizer rubric must report every barrier criterion exactly once");
  }

  const conflicts = recordArray(value.conflicts, "synthesizer.conflicts").map((entry, index) => {
    exactKeys(entry, ["left", "right", "resolution"], `synthesizer.conflicts[${index}]`);
    return {
      left: requiredText(entry, "left"),
      right: requiredText(entry, "right"),
      resolution: requiredText(entry, "resolution")
    };
  });
  return {
    output: requiredText(value, "output"),
    deduplicatedClaims: textArray(value.deduplicatedClaims, "synthesizer.deduplicatedClaims"),
    conflicts,
    rubric
  };
}

function parseVerification(text: string): { pass: boolean; failures: StructuredFailure[] } {
  const value = parseExactJson(text, ["pass", "failures"], "verifier");
  const pass = requiredBoolean(value, "pass");
  const failures = recordArray(value.failures, "verifier.failures").map((entry, index) => {
    exactKeys(entry, ["criterion", "expected", "observed"], `verifier.failures[${index}]`);
    return {
      criterion: requiredText(entry, "criterion"),
      expected: requiredText(entry, "expected"),
      observed: requiredText(entry, "observed")
    };
  });
  if (pass && failures.length > 0) malformed("passing verifier response cannot include failures");
  if (!pass && failures.length === 0) malformed("failing verifier response must include structured failures");
  return { pass, failures };
}

function validateSubtasks(subtasks: readonly FanOutSubtask[]): void {
  if (!Array.isArray(subtasks) || subtasks.length === 0 || subtasks.length > 32) {
    invalid("subtasks must contain 1-32 slices");
  }
  const ids = new Set<string>();
  for (const [index, subtask] of subtasks.entries()) {
    if (typeof subtask !== "object" || subtask === null) invalid(`subtasks[${index}] must be an object`);
    boundedId(subtask.id, `subtasks[${index}].id`);
    boundedText(subtask.input, `subtasks[${index}].input`, 10_000);
    if (ids.has(subtask.id)) invalid(`duplicate subtask id: ${subtask.id}`);
    ids.add(subtask.id);
  }
}

function validateRubric(rubric: readonly VerificationCriterion[]): void {
  if (!Array.isArray(rubric) || rubric.length === 0 || rubric.length > 20) invalid("rubric must contain 1-20 criteria");
  const ids = new Set<string>();
  for (const [index, criterion] of rubric.entries()) {
    boundedId(criterion.id, `rubric[${index}].id`);
    boundedText(criterion.description, `rubric[${index}].description`, 1_000);
    boundedText(criterion.expected, `rubric[${index}].expected`, 1_000);
    if (ids.has(criterion.id)) invalid(`duplicate rubric criterion: ${criterion.id}`);
    ids.add(criterion.id);
  }
}

function validateVerificationFailures(
  failures: readonly StructuredFailure[],
  rubric: readonly VerificationCriterion[]
): void {
  const criteria = new Map(rubric.map((criterion) => [criterion.id, criterion]));
  const seen = new Set<string>();
  for (const failure of failures) {
    const criterion = criteria.get(failure.criterion);
    if (!criterion) malformed(`verifier failure references unknown criterion: ${failure.criterion}`);
    if (failure.expected !== criterion.expected) {
      malformed(`verifier failure changed expected value for criterion: ${failure.criterion}`);
    }
    if (seen.has(failure.criterion)) malformed(`verifier repeated criterion failure: ${failure.criterion}`);
    seen.add(failure.criterion);
  }
}

function validateRuntime(runtime: PatternRuntime): void {
  if (!runtime.provider || typeof runtime.provider.complete !== "function") invalid("provider is required");
  if (typeof runtime.log !== "function") invalid("spend logger is required");
  if (runtime.now !== undefined && typeof runtime.now !== "function") invalid("now must be a function");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(runtime.pricingDate)) invalid("pricingDate must use YYYY-MM-DD");
  positiveInteger(runtime.caps.maxTokens, "maxTokens");
  positiveInteger(runtime.caps.maxWallClockMs, "maxWallClockMs");
  positiveNumber(runtime.caps.maxSpendUsd, "maxSpendUsd");
}

function validatePlan(plan: InvocationPlan, name: string): void {
  if (typeof plan !== "object" || plan === null) invalid(`${name} plan is required`);
  boundedText(plan.model, `${name}.model`, 100);
  positiveInteger(plan.estimate.inputTokens, `${name}.estimate.inputTokens`);
  positiveInteger(plan.estimate.outputTokens, `${name}.estimate.outputTokens`);
}

function validateCompletion(result: CompletionResult, model: ModelId, role: string): void {
  if (typeof result !== "object" || result === null) malformed(`${role}: provider result must be an object`);
  if (result.requestedModel !== model) malformed(`${role}: provider requestedModel does not match request`);
  if (
    !Array.isArray(result.exactModels) ||
    result.exactModels.length === 0 ||
    result.exactModels.some((id) => typeof id !== "string" || id.length === 0)
  ) {
    malformed(`${role}: provider must report at least one exact model`);
  }
  if (typeof result.refused !== "boolean") malformed(`${role}.refused must be boolean`);
  if (typeof result.stopReason !== "string" && result.stopReason !== null) {
    malformed(`${role}.stopReason must be text or null`);
  }
  nonNegativeNumber(result.costUsd, `${role}.costUsd`, malformed);
  nonNegativeNumber(result.durationMs, `${role}.durationMs`, malformed);
  if (typeof result.usage !== "object" || result.usage === null || Array.isArray(result.usage)) {
    malformed(`${role}.usage must be an object`);
  }
  const usageKeys: Array<keyof ModelTokenUsage> = [
    "inputTokens",
    "outputTokens",
    "cacheReadInputTokens",
    "cacheCreationInputTokens"
  ];
  for (const key of usageKeys) {
    const value = result.usage[key];
    if (!Number.isInteger(value) || value < 0) malformed(`${role}.usage.${key} must be a non-negative integer`);
  }
  if (typeof result.text !== "string" || result.text.length === 0) malformed(`${role}: provider text is empty`);
}

function predictedCost(plan: InvocationPlan, pricingDate: string): number {
  return estimateCost({ modelId: plan.model, ...plan.estimate, onDate: pricingDate }).totalUsd;
}

function proportionalBudget(predicted: number, total: number, cap: number): number {
  return total === 0 ? cap : (predicted / total) * cap;
}

function parseExactJson(text: string, keys: readonly string[], source: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    malformed(`${source}: response is not valid JSON`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    malformed(`${source}: response must be an object`);
  }
  const record = value as Record<string, unknown>;
  exactKeys(record, keys, source);
  return record;
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[], source: string): void {
  const expected = new Set(keys);
  for (const key of Object.keys(record)) if (!expected.has(key)) malformed(`${source}.${key}: unknown field`);
  for (const key of keys) if (!Object.prototype.hasOwnProperty.call(record, key)) malformed(`${source}.${key}: missing field`);
}

function requiredText(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) malformed(`${key} must be non-empty text`);
  return value;
}

function requiredBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") malformed(`${key} must be boolean`);
  return value;
}

function recordArray(value: unknown, path: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) malformed(`${path} must be an array`);
  return value.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) malformed(`${path}[${index}] must be an object`);
    return entry as Record<string, unknown>;
  });
}

function textArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) malformed(`${path} must be an array`);
  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim().length === 0) malformed(`${path}[${index}] must be non-empty text`);
    return entry;
  });
}

function emptyUsage(): ModelTokenUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
}

function addUsage(left: ModelTokenUsage, right: ModelTokenUsage): ModelTokenUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadInputTokens: left.cacheReadInputTokens + right.cacheReadInputTokens,
    cacheCreationInputTokens: left.cacheCreationInputTokens + right.cacheCreationInputTokens
  };
}

function tokenTotal(usage: ModelTokenUsage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
}

function boundedId(value: unknown, path: string): void {
  boundedText(value, path, 100);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value as string)) invalid(`${path} must be lowercase kebab-case`);
}

function boundedText(value: unknown, path: string, max: number): void {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0 || value.length > max) {
    invalid(`${path} must be non-empty trimmed text of at most ${max} characters`);
  }
}

function positiveInteger(value: unknown, path: string): void {
  if (!Number.isInteger(value) || (value as number) <= 0) invalid(`${path} must be a positive integer`);
}

function positiveNumber(value: unknown, path: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) invalid(`${path} must be a positive number`);
}

function nonNegativeNumber(value: unknown, path: string, fail: (message: string) => never): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) fail(`${path} must be a non-negative number`);
}

function invalid(message: string): never {
  throw new OrchestrationPatternError("invalid_input", message);
}

function malformed(message: string): never {
  throw new OrchestrationPatternError("malformed_response", message);
}

const stringField = { type: "string", minLength: 1 } as const;
const booleanField = { type: "boolean" } as const;
const closedObject = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> => ({
  type: "object",
  additionalProperties: false,
  properties,
  required
});

const WORKER_SCHEMA = closedObject({ output: stringField }, ["output"]);
const MAKER_SCHEMA = closedObject({ output: stringField }, ["output"]);
const CRITIC_SCHEMA = closedObject(
  { position: { type: "string", enum: ["refute", "concede"] }, refutation: stringField },
  ["position", "refutation"]
);
const LOOP_MAKER_SCHEMA = closedObject({ candidate: stringField }, ["candidate"]);
const JUDGE_SCHEMA = closedObject(
  { verdict: { type: "string", enum: ["maker", "critic", "mixed"] }, output: stringField, justification: stringField },
  ["verdict", "output", "justification"]
);
function verifierSchema(rubric: readonly VerificationCriterion[]): Record<string, unknown> {
  return closedObject(
    {
      pass: booleanField,
      failures: {
        type: "array",
        maxItems: rubric.length,
        items: closedObject(
          {
            criterion: { type: "string", enum: rubric.map(({ id }) => id) },
            expected: stringField,
            observed: stringField
          },
          ["criterion", "expected", "observed"]
        )
      }
    },
    ["pass", "failures"]
  );
}

function synthesisSchema(): Record<string, unknown> {
  return closedObject(
    {
      output: stringField,
      deduplicatedClaims: { type: "array", items: stringField },
      conflicts: {
        type: "array",
        items: closedObject({ left: stringField, right: stringField, resolution: stringField }, [
          "left",
          "right",
          "resolution"
        ])
      },
      rubric: {
        type: "array",
        minItems: SYNTHESIS_BARRIER_RUBRIC.length,
        maxItems: SYNTHESIS_BARRIER_RUBRIC.length,
        items: closedObject(
          {
            criterionId: {
              type: "string",
              enum: SYNTHESIS_BARRIER_RUBRIC.map(({ criterionId }) => criterionId)
            },
            pass: booleanField,
            justification: stringField
          },
          ["criterionId", "pass", "justification"]
        )
      }
    },
    ["output", "deduplicatedClaims", "conflicts", "rubric"]
  );
}
