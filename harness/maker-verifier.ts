import type {
  CompletionRequest,
  CompletionResult,
  ModelProvider,
  ModelTokenUsage,
  ModelUsageReceipt
} from "./model-provider.js";
import { route, type ModelId, type TaskClass } from "./routing.js";

export const MAX_MAKER_VERIFIER_ITERS = 20;

export interface MakerVerifierTask {
  id: string;
  taskClass: TaskClass;
  input: string;
  context: unknown;
}

export interface MakerVerifierCriterion {
  id: string;
  description: string;
  expected: string;
}

export type MakerVerifierRubric = readonly MakerVerifierCriterion[];

export interface MakerSelfAssessment {
  pass: boolean;
  summary: string;
}

export interface VerificationCriterionResult {
  criterion: string;
  pass: boolean;
  observed: string;
}

export interface StructuredFailure {
  criterion: string;
  expected: string;
  observed: string;
}

export interface ModelCallTraceReceipt {
  requestedModel: string;
  exactModels: string[];
  stopReason: string | null;
  refused: boolean;
  costUsd: number;
  durationMs: number;
  usage: ModelTokenUsage;
  modelUsage: ModelUsageReceipt[];
}

export interface MakerVerifierIterationTrace {
  iteration: number;
  maker: {
    completedAt: string;
    output: string;
    selfAssessment: MakerSelfAssessment;
    receipt: ModelCallTraceReceipt;
  };
  verifier: {
    completedAt: string;
    pass: boolean;
    criteria: VerificationCriterionResult[];
    receipt: ModelCallTraceReceipt;
  };
  failures: StructuredFailure[];
  normalizedFailureSet: string;
}

export interface MakerVerifierEscalationTrace {
  iteration: number;
  reason: "identical_failure_set";
  fromModel: ModelId;
  toModel: ModelId;
}

export type MakerVerifierStopReason = "verified" | "max_iters";

export interface MakerVerifierTrace {
  schemaVersion: 1;
  taskId: string;
  taskClass: TaskClass;
  startedAt: string;
  completedAt: string;
  maxIters: number;
  stoppedBy: MakerVerifierStopReason;
  iterations: MakerVerifierIterationTrace[];
  escalations: MakerVerifierEscalationTrace[];
  totalCostUsd: number;
  totalUsage: ModelTokenUsage;
}

export interface MakerVerifierResult {
  pass: boolean;
  output: string;
  failures: StructuredFailure[];
  iterations: number;
  stoppedBy: MakerVerifierStopReason;
  trace: MakerVerifierTrace;
}

export interface CreateMakerVerifierOptions {
  makerProvider: ModelProvider;
  verifierProvider: ModelProvider;
  maxBudgetUsd: number;
  timeoutMs: number;
  availableModelIds?: readonly ModelId[];
  now?: () => string;
}

export type MakerVerifier = (
  task: MakerVerifierTask,
  rubric: MakerVerifierRubric,
  maxIters: number
) => Promise<MakerVerifierResult>;

const MAKER_SYSTEM_PROMPT = `You are the maker in an independently verified loop.

Return exactly one JSON object with output and selfAssessment. selfAssessment
must contain pass and a one-line summary. Do not expose chain-of-thought or
private reasoning. On retries, revise from the supplied structured failures.`;

const VERIFIER_SYSTEM_PROMPT = `You are an independent verifier in a fresh model call.

Evaluate only the supplied task, rubric, and candidateOutput. Do not request or
infer maker reasoning, hidden state, or self-assessment. Return exactly one
structured result for every criterion. JSON only.`;

const MAKER_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    output: { type: "string" },
    selfAssessment: {
      type: "object",
      additionalProperties: false,
      properties: {
        pass: { type: "boolean" },
        summary: { type: "string" }
      },
      required: ["pass", "summary"]
    }
  },
  required: ["output", "selfAssessment"]
} as const;

export function createMakerVerifier(options: CreateMakerVerifierOptions): MakerVerifier {
  if (!(options.maxBudgetUsd > 0) || !Number.isFinite(options.maxBudgetUsd)) {
    throw new Error("maxBudgetUsd must be positive");
  }
  if (!(options.timeoutMs > 0) || !Number.isFinite(options.timeoutMs)) {
    throw new Error("timeoutMs must be positive");
  }

  const now = options.now ?? (() => new Date().toISOString());

  return async function makerVerifier(
    task: MakerVerifierTask,
    rubric: MakerVerifierRubric,
    maxIters: number
  ): Promise<MakerVerifierResult> {
    validateTask(task);
    validateRubric(rubric);
    if (!Number.isInteger(maxIters) || maxIters < 1 || maxIters > MAX_MAKER_VERIFIER_ITERS) {
      throw new Error(`maxIters must be an integer from 1 through ${MAX_MAKER_VERIFIER_ITERS}`);
    }

    const availability = options.availableModelIds
      ? { kind: "availability" as const, availableModelIds: options.availableModelIds }
      : null;
    let makerModel = route(task.taskClass, 0, availability);
    const verifierModel = route("grader", 0, availability);
    const startedAt = now();
    let completedAt = startedAt;
    let feedback: StructuredFailure[] | undefined;
    let previousFailureSet: string | undefined;
    let lastOutput = "";
    let lastFailures: StructuredFailure[] = [];
    const iterations: MakerVerifierIterationTrace[] = [];
    const escalations: MakerVerifierEscalationTrace[] = [];
    const receipts: CompletionResult[] = [];

    for (let iteration = 1; iteration <= maxIters; iteration += 1) {
      const makerReceipt = await options.makerProvider.complete(
        makerRequest(task, rubric, feedback, makerModel, options.maxBudgetUsd, options.timeoutMs)
      );
      const makerCompletedAt = now();
      assertNotRefused(makerReceipt, "maker");
      const makerResult = parseMakerResponse(makerReceipt.text);
      receipts.push(makerReceipt);

      const verifierReceipt = await options.verifierProvider.complete(
        verifierRequest(
          task,
          rubric,
          makerResult.output,
          verifierModel,
          options.maxBudgetUsd,
          options.timeoutMs
        )
      );
      const verifierCompletedAt = now();
      completedAt = verifierCompletedAt;
      assertNotRefused(verifierReceipt, "verifier");
      const criteria = parseVerifierResponse(verifierReceipt.text, rubric);
      receipts.push(verifierReceipt);

      const failures = toStructuredFailures(criteria, rubric);
      const normalizedFailureSet = normalizeFailureSet(failures);
      const verifierPass = failures.length === 0;
      iterations.push({
        iteration,
        maker: {
          completedAt: makerCompletedAt,
          output: makerResult.output,
          selfAssessment: makerResult.selfAssessment,
          receipt: toTraceReceipt(makerReceipt)
        },
        verifier: {
          completedAt: verifierCompletedAt,
          pass: verifierPass,
          criteria,
          receipt: toTraceReceipt(verifierReceipt)
        },
        failures,
        normalizedFailureSet
      });

      lastOutput = makerResult.output;
      lastFailures = failures;

      if (verifierPass) {
        return finish({
          task,
          maxIters,
          startedAt,
          completedAt,
          output: lastOutput,
          failures: [],
          stoppedBy: "verified",
          iterations,
          escalations,
          receipts
        });
      }

      if (previousFailureSet === normalizedFailureSet) {
        const escalatedModel = route(task.taskClass, 2, {
          kind: "verifier_failure",
          ...(options.availableModelIds ? { availableModelIds: options.availableModelIds } : {})
        });
        if (escalatedModel !== makerModel) {
          escalations.push({
            iteration,
            reason: "identical_failure_set",
            fromModel: makerModel,
            toModel: escalatedModel
          });
        }
        makerModel = escalatedModel;
      }

      previousFailureSet = normalizedFailureSet;
      feedback = failures;
    }

    return finish({
      task,
      maxIters,
      startedAt,
      completedAt,
      output: lastOutput,
      failures: lastFailures,
      stoppedBy: "max_iters",
      iterations,
      escalations,
      receipts
    });
  };
}

interface FinishInput {
  task: MakerVerifierTask;
  maxIters: number;
  startedAt: string;
  completedAt: string;
  output: string;
  failures: StructuredFailure[];
  stoppedBy: MakerVerifierStopReason;
  iterations: MakerVerifierIterationTrace[];
  escalations: MakerVerifierEscalationTrace[];
  receipts: CompletionResult[];
}

function finish(input: FinishInput): MakerVerifierResult {
  return {
    pass: input.stoppedBy === "verified",
    output: input.output,
    failures: input.failures,
    iterations: input.iterations.length,
    stoppedBy: input.stoppedBy,
    trace: {
      schemaVersion: 1,
      taskId: input.task.id,
      taskClass: input.task.taskClass,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      maxIters: input.maxIters,
      stoppedBy: input.stoppedBy,
      iterations: input.iterations,
      escalations: input.escalations,
      totalCostUsd: input.receipts.reduce((sum, receipt) => sum + receipt.costUsd, 0),
      totalUsage: sumUsage(input.receipts.map((receipt) => receipt.usage))
    }
  };
}

function makerRequest(
  task: MakerVerifierTask,
  rubric: MakerVerifierRubric,
  feedback: StructuredFailure[] | undefined,
  model: ModelId,
  maxBudgetUsd: number,
  timeoutMs: number
): CompletionRequest {
  const taskPayload = { input: task.input, context: task.context };
  const prompt = feedback === undefined
    ? { task: taskPayload, rubric }
    : { task: taskPayload, failures: feedback };
  return {
    model,
    system: MAKER_SYSTEM_PROMPT,
    prompt: JSON.stringify(prompt),
    maxBudgetUsd,
    timeoutMs,
    jsonSchema: MAKER_JSON_SCHEMA
  };
}

function verifierRequest(
  task: MakerVerifierTask,
  rubric: MakerVerifierRubric,
  candidateOutput: string,
  model: ModelId,
  maxBudgetUsd: number,
  timeoutMs: number
): CompletionRequest {
  return {
    model,
    system: VERIFIER_SYSTEM_PROMPT,
    prompt: JSON.stringify({
      task: { input: task.input, context: task.context },
      rubric,
      candidateOutput
    }),
    maxBudgetUsd,
    timeoutMs,
    jsonSchema: verifierJsonSchema(rubric)
  };
}

function verifierJsonSchema(rubric: MakerVerifierRubric): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      criteria: {
        type: "array",
        minItems: rubric.length,
        maxItems: rubric.length,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            criterion: { type: "string", enum: rubric.map(({ id }) => id) },
            pass: { type: "boolean" },
            observed: { type: "string" }
          },
          required: ["criterion", "pass", "observed"]
        }
      }
    },
    required: ["criteria"]
  };
}

function parseMakerResponse(raw: string): { output: string; selfAssessment: MakerSelfAssessment } {
  const value = parseJsonObject(raw, "maker");
  if (!isRecord(value) || !hasExactKeys(value, ["output", "selfAssessment"])) {
    throw new Error("maker response must contain only output and selfAssessment");
  }
  if (typeof value.output !== "string" || value.output.trim().length === 0) {
    throw new Error("maker response output must be a non-empty string");
  }
  if (!isRecord(value.selfAssessment) || !hasExactKeys(value.selfAssessment, ["pass", "summary"])) {
    throw new Error("maker response selfAssessment must contain only pass and summary");
  }
  const { pass, summary } = value.selfAssessment;
  if (typeof pass !== "boolean" || typeof summary !== "string" || summary.trim().length === 0 || /[\r\n]/.test(summary)) {
    throw new Error("maker response selfAssessment is malformed");
  }
  return { output: value.output, selfAssessment: { pass, summary: summary.trim() } };
}

function parseVerifierResponse(
  raw: string,
  rubric: MakerVerifierRubric
): VerificationCriterionResult[] {
  const value = parseJsonObject(raw, "verifier");
  if (!isRecord(value) || !hasExactKeys(value, ["criteria"]) || !Array.isArray(value.criteria)) {
    throw new Error("verifier response must contain only a criteria array");
  }
  const expectedIds = new Set(rubric.map((criterion) => criterion.id));
  const seen = new Set<string>();
  const criteria = value.criteria.map((entry): VerificationCriterionResult => {
    if (!isRecord(entry) || !hasExactKeys(entry, ["criterion", "pass", "observed"])) {
      throw new Error("verifier response contains a malformed criterion result");
    }
    const { criterion, pass, observed } = entry;
    if (typeof criterion !== "string" || !expectedIds.has(criterion) || seen.has(criterion)) {
      throw new Error(`verifier response contains an unknown or duplicate criterion: ${String(criterion)}`);
    }
    if (typeof pass !== "boolean") throw new Error(`verifier response criterion ${criterion} pass must be boolean`);
    if (typeof observed !== "string" || observed.trim().length === 0 || /[\r\n]/.test(observed)) {
      throw new Error(`verifier response criterion ${criterion} observed must be one non-empty line`);
    }
    seen.add(criterion);
    return { criterion, pass, observed: observed.trim() };
  });
  if (seen.size !== expectedIds.size) {
    throw new Error("verifier response omitted one or more rubric criteria");
  }
  return criteria;
}

function toStructuredFailures(
  criteria: readonly VerificationCriterionResult[],
  rubric: MakerVerifierRubric
): StructuredFailure[] {
  const expected = new Map(rubric.map((criterion) => [criterion.id, criterion.expected]));
  return criteria
    .filter((criterion) => !criterion.pass)
    .map((criterion) => ({
      criterion: criterion.criterion,
      expected: expected.get(criterion.criterion)!,
      observed: criterion.observed
    }));
}

function normalizeFailureSet(failures: readonly StructuredFailure[]): string {
  return JSON.stringify(
    [...failures]
      .map((failure) => ({
        criterion: normalizeText(failure.criterion),
        expected: normalizeText(failure.expected),
        observed: normalizeText(failure.observed)
      }))
      .sort((left, right) => left.criterion.localeCompare(right.criterion))
  );
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function toTraceReceipt(receipt: CompletionResult): ModelCallTraceReceipt {
  return {
    requestedModel: receipt.requestedModel,
    exactModels: [...receipt.exactModels],
    stopReason: receipt.stopReason,
    refused: receipt.refused,
    costUsd: receipt.costUsd,
    durationMs: receipt.durationMs,
    usage: { ...receipt.usage },
    modelUsage: receipt.modelUsage.map((entry) => ({ ...entry }))
  };
}

function sumUsage(usages: readonly ModelTokenUsage[]): ModelTokenUsage {
  return usages.reduce<ModelTokenUsage>(
    (sum, usage) => ({
      inputTokens: sum.inputTokens + usage.inputTokens,
      outputTokens: sum.outputTokens + usage.outputTokens,
      cacheReadInputTokens: sum.cacheReadInputTokens + usage.cacheReadInputTokens,
      cacheCreationInputTokens: sum.cacheCreationInputTokens + usage.cacheCreationInputTokens
    }),
    { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
  );
}

function assertNotRefused(receipt: CompletionResult, role: "maker" | "verifier"): void {
  if (receipt.refused) throw new Error(`${role} call refused; no partial output is accepted`);
}

function parseJsonObject(raw: string, role: "maker" | "verifier"): unknown {
  const trimmed = raw.trim();
  const unfenced = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
    : trimmed;
  try {
    return JSON.parse(unfenced) as unknown;
  } catch {
    throw new Error(`${role} response returned invalid JSON`);
  }
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateTask(task: MakerVerifierTask): void {
  if (!task || typeof task !== "object" || typeof task.id !== "string" || task.id.trim().length === 0) {
    throw new Error("makerVerifier task id is required");
  }
  if (typeof task.input !== "string" || task.input.trim().length === 0) {
    throw new Error("makerVerifier task input is required");
  }
}

function validateRubric(rubric: MakerVerifierRubric): void {
  if (!Array.isArray(rubric) || rubric.length < 3 || rubric.length > 7) {
    throw new Error("makerVerifier rubric must contain 3-7 criteria");
  }
  const ids = new Set<string>();
  for (const criterion of rubric) {
    if (
      !criterion ||
      typeof criterion.id !== "string" ||
      criterion.id.trim().length === 0 ||
      typeof criterion.description !== "string" ||
      criterion.description.trim().length === 0 ||
      typeof criterion.expected !== "string" ||
      criterion.expected.trim().length === 0
    ) {
      throw new Error("makerVerifier rubric contains a malformed criterion");
    }
    if (ids.has(criterion.id)) throw new Error(`makerVerifier rubric contains duplicate criterion ${criterion.id}`);
    ids.add(criterion.id);
  }
}
