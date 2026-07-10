import { writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { relative, resolve, sep } from "node:path";
import { collectSensitiveJsonValuesFromText, redactValue } from "../packages/shared/src/redact.js";
import { ClaudeCliProvider } from "../harness/claude-cli-provider.js";
import {
  createMakerVerifier,
  type MakerVerifierTask
} from "../harness/maker-verifier.js";
import type { CompletionRequest, CompletionResult, ModelProvider } from "../harness/model-provider.js";
import type { MakerVerifierEvidence } from "./maker-verifier-evidence.js";
import { loadEvalTaskFile } from "./task-schema.js";

interface CliOptions {
  taskFile: string;
  outputFile: string;
  maxIters: number;
  maxBudgetUsd: number;
  timeoutMs: number;
  seededMissingCriterion?: string;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const taskPath = resolve(cwd, options.taskFile);
  const outputPath = resolve(cwd, options.outputFile);
  assertInside(resolve(cwd, "evals", "tasks"), taskPath, "task");
  assertInside(resolve(cwd, "runs"), outputPath, "output");

  const task = loadEvalTaskFile(taskPath);
  const taskSha256 = createHash("sha256").update(readFileSync(taskPath)).digest("hex");
  if (options.seededMissingCriterion && !task.rubric.some(({ id }) => id === options.seededMissingCriterion)) {
    throw new Error(`unknown seeded criterion ${options.seededMissingCriterion}`);
  }

  const liveMaker = new ClaudeCliProvider({ cwd });
  const makerProvider = options.seededMissingCriterion
    ? new SeededFirstMakerProvider(liveMaker, options.seededMissingCriterion)
    : liveMaker;
  const verifierProvider = new ClaudeCliProvider({ cwd });
  const makerVerifier = createMakerVerifier({
    makerProvider,
    verifierProvider,
    maxBudgetUsd: options.maxBudgetUsd,
    timeoutMs: options.timeoutMs
  });
  const makerTask: MakerVerifierTask = {
    id: task.id,
    taskClass: task.taskClass,
    input: task.input,
    context: task.context
  };
  const result = await makerVerifier(makerTask, task.rubric, options.maxIters);
  const evidence: MakerVerifierEvidence = {
    schemaVersion: 2,
    kind: "maker-verifier-evidence",
    recordedAt: new Date().toISOString(),
    taskFile: relative(cwd, taskPath),
    taskSha256,
    rubric: task.rubric,
    provider: "claude-cli",
    faultInjection: options.seededMissingCriterion
      ? {
          kind: "seeded-first-maker-omission",
          criterion: options.seededMissingCriterion,
          seededReceiptModel: "fixture:seeded-maker-error"
        }
      : null,
    trace: result.trace
  };
  const taskTexts = [task.input, ...task.context.facts, ...task.context.constraints];
  const taskSecrets = [...new Set(taskTexts.flatMap(collectSensitiveJsonValuesFromText))];
  const sanitizedEvidence = redactValue(evidence, taskSecrets) as MakerVerifierEvidence;
  writeFileSync(outputPath, `${JSON.stringify(sanitizedEvidence, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ output: relative(cwd, outputPath), pass: result.pass, stoppedBy: result.stoppedBy, iterations: result.iterations, actualCostUsd: result.trace.totalCostUsd })}\n`);
}

class SeededFirstMakerProvider implements ModelProvider {
  private seeded = false;

  constructor(
    private readonly delegate: ModelProvider,
    private readonly omittedCriterion: string
  ) {}

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    if (this.seeded) return this.delegate.complete(request);
    this.seeded = true;
    return {
      text: JSON.stringify({
        output: `Seeded fault: answer intentionally omits rubric criterion ${this.omittedCriterion}.`,
        selfAssessment: { pass: true, summary: "Seeded self-assessment incorrectly approves the incomplete answer." }
      }),
      requestedModel: request.model,
      exactModels: ["fixture:seeded-maker-error"],
      stopReason: "end_turn",
      refused: false,
      costUsd: 0,
      durationMs: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      modelUsage: []
    };
  }
}

function parseArgs(args: string[]): CliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error("arguments must be --name value pairs");
    values.set(key, value);
  }
  const taskFile = required(values, "--task");
  const outputFile = required(values, "--output");
  const maxIters = positiveInteger(values.get("--max-iters") ?? "2", "--max-iters");
  const maxBudgetUsd = positiveNumber(values.get("--max-budget-usd") ?? "0.08", "--max-budget-usd");
  const timeoutMs = positiveInteger(values.get("--timeout-ms") ?? "120000", "--timeout-ms");
  return {
    taskFile,
    outputFile,
    maxIters,
    maxBudgetUsd,
    timeoutMs,
    ...(values.has("--seed-missing-criterion")
      ? { seededMissingCriterion: required(values, "--seed-missing-criterion") }
      : {})
  };
}

function required(values: ReadonlyMap<string, string>, key: string): string {
  const value = values.get(key);
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function positiveInteger(raw: string, label: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function positiveNumber(raw: string, label: string): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be positive`);
  return value;
}

function assertInside(directory: string, candidate: string, label: string): void {
  if (candidate !== directory && !candidate.startsWith(`${directory}${sep}`)) {
    throw new Error(`${label} path must stay under ${directory}`);
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
