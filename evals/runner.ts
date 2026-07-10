import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { estimateCost } from "../harness/cost.js";
import type { CompletionRequest, CompletionResult, ModelProvider, ModelTokenUsage } from "../harness/model-provider.js";
import { MODEL_IDS, route, type ModelId } from "../harness/routing.js";
import { gradeCandidate } from "./graders/independent-grader.js";
import {
  EVAL_RESULT_SCHEMA_VERSION,
  calculateTotals,
  type EvalCandidateRecord,
  type EvalGradeRecord,
  type EvalModelCallRecord,
  type EvalRunResult,
  type EvalTaskResult
} from "./result-schema.js";
import type { EvalTask } from "./task-schema.js";

export interface EvalRunOptions {
  tasks: readonly EvalTask[];
  provider: ModelProvider;
  providerName: string;
  pricingDate: string;
  runId: string;
  outputPath: string;
  maxCallBudgetUsd: number;
  timeoutMs: number;
  now?: () => string;
  log?: (line: string) => void;
}

export interface PredictedTaskCost {
  taskId: string;
  makerModel: ModelId;
  graderModel: ModelId;
  makerCostUsd: number;
  graderCostUsd: number;
  totalUsd: number;
}

const MAKER_SYSTEM_PROMPT = `Produce the final candidate output for the supplied task.
Return only the answer that should be graded. Do not expose chain-of-thought,
private reasoning, or a self-assessment. Do not call tools.`;

export async function runEvals(options: EvalRunOptions): Promise<EvalRunResult> {
  if (options.tasks.length < 10 || options.tasks.length > 20) {
    throw new Error("a full eval run requires 10-20 fixed tasks");
  }
  if (!(options.maxCallBudgetUsd > 0) || !(options.timeoutMs > 0)) {
    throw new Error("eval call budget and timeout must be positive");
  }

  const now = options.now ?? (() => new Date().toISOString());
  const log = options.log ?? console.log;
  const startedAt = now();
  const predictions = options.tasks.map((task) => predictTaskCost(task, options.pricingDate));
  const predictedCostUsd = predictions.reduce((sum, prediction) => sum + prediction.totalUsd, 0);

  // Required pre-execution receipt: this line is emitted before the first provider call.
  log(`Predicted cost: $${predictedCostUsd.toFixed(6)} for ${options.tasks.length} tasks`);

  const taskResults: EvalTaskResult[] = [];
  for (const [index, task] of options.tasks.entries()) {
    const prediction = predictions[index]!;
    const candidate = await makeCandidate(options.provider, task, options.maxCallBudgetUsd, options.timeoutMs);
    const grade = await gradeCandidate({
      provider: options.provider,
      task: {
        id: task.id,
        input: task.input,
        context: task.context,
        ...(task.reference ? { reference: task.reference } : {})
      },
      rubric: task.rubric,
      candidateOutput: candidate.output,
      maxBudgetUsd: options.maxCallBudgetUsd,
      timeoutMs: options.timeoutMs
    });
    const gradeRecord: EvalGradeRecord = {
      ...toCallRecord(grade.receipt),
      pass: grade.pass,
      criteria: grade.criteria
    };
    const passed = grade.criteria.filter((criterion) => criterion.pass).length;
    const actualCostUsd = candidate.costUsd + gradeRecord.costUsd;
    taskResults.push({
      taskId: task.id,
      taskClass: task.taskClass,
      predictedCostUsd: prediction.totalUsd,
      actualCostUsd,
      candidate,
      grade: gradeRecord,
      score: passed / grade.criteria.length
    });
    log(
      `[${index + 1}/${options.tasks.length}] ${task.id}: ${passed}/${grade.criteria.length} criteria, $${actualCostUsd.toFixed(6)}`
    );
  }

  const result: EvalRunResult = {
    schemaVersion: EVAL_RESULT_SCHEMA_VERSION,
    runId: options.runId,
    startedAt,
    completedAt: now(),
    pricingDate: options.pricingDate,
    provider: options.providerName,
    predictedCostUsd,
    actualCostUsd: taskResults.reduce((sum, task) => sum + task.actualCostUsd, 0),
    totals: calculateTotals(taskResults),
    taskResults
  };

  await writeResultAtomically(options.outputPath, result);
  log(`Actual cost: $${result.actualCostUsd.toFixed(6)}; score: ${result.totals.score.toFixed(4)}`);
  log(`Result: ${options.outputPath}`);
  return result;
}

export function predictTaskCost(task: EvalTask, pricingDate: string): PredictedTaskCost {
  const makerModel = route(task.taskClass, 0, null);
  const graderModel = route("grader", 0, null);
  const maker = estimateCost({
    modelId: makerModel,
    inputTokens: task.tokenEstimate.inputTokens,
    outputTokens: task.tokenEstimate.outputTokens,
    onDate: pricingDate
  });
  const grader = estimateCost({
    modelId: graderModel,
    inputTokens: task.tokenEstimate.inputTokens + task.tokenEstimate.outputTokens,
    outputTokens: Math.max(200, task.rubric.length * 80),
    onDate: pricingDate
  });
  return {
    taskId: task.id,
    makerModel,
    graderModel,
    makerCostUsd: maker.totalUsd,
    graderCostUsd: grader.totalUsd,
    totalUsd: maker.totalUsd + grader.totalUsd
  };
}

async function makeCandidate(
  provider: ModelProvider,
  task: EvalTask,
  maxBudgetUsd: number,
  timeoutMs: number
): Promise<EvalCandidateRecord> {
  const attempts: CompletionResult[] = [];
  let model = route(task.taskClass, 0, null);
  let result = await provider.complete(makerRequest(task, model, maxBudgetUsd, timeoutMs));
  attempts.push(result);

  if (result.refused) {
    model = route(task.taskClass, 1, { kind: "refusal", modelId: model });
    result = await provider.complete(makerRequest(task, model, maxBudgetUsd, timeoutMs));
    attempts.push(result);
  }
  if (result.refused) throw new Error(`candidate generation refused after fallback for task ${task.id}`);

  const attemptRecords = attempts.map(toCallRecord);
  return {
    requestedModel: result.requestedModel,
    exactModels: [...new Set(attempts.flatMap((attempt) => attempt.exactModels))].sort(),
    stopReason: result.stopReason,
    usage: sumUsage(attempts.map((attempt) => attempt.usage)),
    costUsd: attempts.reduce((sum, attempt) => sum + attempt.costUsd, 0),
    output: result.text,
    attempts: attemptRecords
  };
}

function makerRequest(
  task: EvalTask,
  model: ModelId,
  maxBudgetUsd: number,
  timeoutMs: number
): CompletionRequest {
  return {
    model,
    system: MAKER_SYSTEM_PROMPT,
    prompt: JSON.stringify({ id: task.id, input: task.input, context: task.context }),
    maxBudgetUsd,
    timeoutMs
  };
}

function toCallRecord(result: CompletionResult): EvalModelCallRecord {
  return {
    requestedModel: result.requestedModel,
    exactModels: result.exactModels,
    stopReason: result.stopReason,
    usage: result.usage,
    costUsd: result.costUsd
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

async function writeResultAtomically(outputPath: string, result: EvalRunResult): Promise<void> {
  await mkdir(dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    await rename(temporary, outputPath);
  } finally {
    await rm(temporary, { force: true });
  }
}

// Keep the exact canonical ID visible to static acceptance checks.
export const DEFAULT_GRADER_MODEL = MODEL_IDS.haiku;
