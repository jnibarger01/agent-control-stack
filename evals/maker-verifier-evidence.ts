import type {
  MakerVerifierRubric,
  MakerVerifierTrace,
  ModelCallTraceReceipt,
  StructuredFailure,
  VerificationCriterionResult
} from "../harness/maker-verifier.js";
import type { ModelTokenUsage } from "../harness/model-provider.js";
import { createHash } from "node:crypto";
import { parseEvalTask } from "./task-schema.js";

export interface MakerVerifierEvidence {
  schemaVersion: 2;
  kind: "maker-verifier-evidence";
  recordedAt: string;
  taskFile: string;
  taskSha256: string;
  rubric: MakerVerifierRubric;
  provider: "claude-cli";
  faultInjection: null | {
    kind: "seeded-first-maker-omission";
    criterion: string;
    seededReceiptModel: "fixture:seeded-maker-error";
  };
  trace: MakerVerifierTrace;
}

export function assertMakerVerifierEvidence(
  value: unknown,
  taskSource: string
): asserts value is MakerVerifierEvidence {
  const evidence = record(value, "maker-verifier evidence");
  equal(evidence.schemaVersion, 2, "schemaVersion");
  equal(evidence.kind, "maker-verifier-evidence", "kind");
  isoTimestamp(evidence.recordedAt, "recordedAt");
  const taskFile = nonEmpty(evidence.taskFile, "taskFile");
  const taskHash = sha256(evidence.taskSha256, "taskSha256");
  equal(taskHash, createHash("sha256").update(taskSource, "utf8").digest("hex"), "taskSha256");
  let rawTask: unknown;
  try {
    rawTask = JSON.parse(taskSource) as unknown;
  } catch {
    throw new Error("taskSource must be valid JSON");
  }
  const sourceTask = parseEvalTask(rawTask, taskFile);
  equal(evidence.provider, "claude-cli", "provider");
  const rubric = validateRubric(evidence.rubric);
  if (JSON.stringify(rubric) !== JSON.stringify(sourceTask.rubric)) {
    throw new Error("evidence rubric must equal source task rubric");
  }
  const rubricIds = rubric.map(({ id }) => id);
  const rubricById = new Map(rubric.map((criterion) => [criterion.id, criterion]));

  const trace = record(evidence.trace, "trace");
  equal(trace.schemaVersion, 1, "trace.schemaVersion");
  const taskId = nonEmpty(trace.taskId, "trace.taskId");
  equal(taskId, sourceTask.id, "trace.taskId");
  equal(taskFile, `evals/tasks/${taskId}.json`, "taskFile");
  const startedAt = isoTimestamp(trace.startedAt, "trace.startedAt");
  const completedAt = isoTimestamp(trace.completedAt, "trace.completedAt");
  if (completedAt < startedAt) throw new Error("trace timestamps are reversed");
  const maxIters = positiveInteger(trace.maxIters, "trace.maxIters");
  if (trace.stoppedBy !== "verified" && trace.stoppedBy !== "max_iters") {
    throw new Error("trace.stoppedBy must be verified or max_iters");
  }
  if (!Array.isArray(trace.iterations) || trace.iterations.length < 1 || trace.iterations.length > maxIters) {
    throw new Error("trace.iterations must contain 1 through maxIters entries");
  }

  let totalCostUsd = 0;
  let totalUsage = emptyUsage();
  let previousTime = startedAt;
  let fixtureMakerSeen = false;
  for (const [index, rawIteration] of trace.iterations.entries()) {
    const label = `trace.iterations[${index}]`;
    const iteration = record(rawIteration, label);
    equal(iteration.iteration, index + 1, `${label}.iteration`);
    const maker = record(iteration.maker, `${label}.maker`);
    const makerTime = isoTimestamp(maker.completedAt, `${label}.maker.completedAt`);
    if (makerTime < previousTime) throw new Error(`${label}.maker timestamp is out of order`);
    nonEmpty(maker.output, `${label}.maker.output`);
    const selfAssessment = record(maker.selfAssessment, `${label}.maker.selfAssessment`);
    if (typeof selfAssessment.pass !== "boolean") throw new Error(`${label}.maker.selfAssessment.pass must be boolean`);
    const summary = nonEmpty(selfAssessment.summary, `${label}.maker.selfAssessment.summary`);
    if (/\r|\n/.test(summary)) throw new Error(`${label}.maker.selfAssessment.summary must be one line`);
    const makerReceipt = validateReceipt(maker.receipt, `${label}.maker.receipt`);
    validateDuration(makerReceipt, previousTime, makerTime, `${label}.maker.receipt.durationMs`);

    const verifier = record(iteration.verifier, `${label}.verifier`);
    const verifierTime = isoTimestamp(verifier.completedAt, `${label}.verifier.completedAt`);
    if (verifierTime < makerTime) throw new Error(`${label}.verifier timestamp is out of order`);
    previousTime = verifierTime;
    if (typeof verifier.pass !== "boolean") throw new Error(`${label}.verifier.pass must be boolean`);
    const criteria = validateCriteria(verifier.criteria, rubricIds, `${label}.verifier.criteria`);
    equal(verifier.pass, criteria.every(({ pass }) => pass), `${label}.verifier.pass`);
    const verifierReceipt = validateReceipt(verifier.receipt, `${label}.verifier.receipt`);
    validateDuration(verifierReceipt, makerTime, verifierTime, `${label}.verifier.receipt.durationMs`);

    const failures = validateFailures(iteration.failures, criteria, rubricById, `${label}.failures`);
    equal(iteration.normalizedFailureSet, normalizeFailureSet(failures), `${label}.normalizedFailureSet`);
    totalCostUsd += makerReceipt.costUsd + verifierReceipt.costUsd;
    totalUsage = addUsage(totalUsage, makerReceipt.usage);
    totalUsage = addUsage(totalUsage, verifierReceipt.usage);
    fixtureMakerSeen ||= makerReceipt.exactModels.includes("fixture:seeded-maker-error");
  }
  if (previousTime > completedAt) throw new Error("trace.completedAt precedes an iteration receipt");
  if (Math.abs(totalCostUsd - nonNegative(trace.totalCostUsd, "trace.totalCostUsd")) > 1e-9) {
    throw new Error("trace.totalCostUsd must equal receipt costs");
  }
  if (JSON.stringify(trace.totalUsage) !== JSON.stringify(totalUsage)) {
    throw new Error("trace.totalUsage must equal receipt usage");
  }
  const lastVerifierPass = (trace.iterations.at(-1) as { verifier: { pass: boolean } }).verifier.pass;
  if (trace.stoppedBy === "verified" && !lastVerifierPass) throw new Error("verified trace must end with verifier pass");
  if (trace.stoppedBy === "max_iters" && (lastVerifierPass || trace.iterations.length !== maxIters)) {
    throw new Error("max_iters trace must exhaust iterations without verifier pass");
  }

  if (evidence.faultInjection === null) {
    if (fixtureMakerSeen) throw new Error("unlabeled fixture maker receipt");
  } else {
    const fault = record(evidence.faultInjection, "faultInjection");
    equal(fault.kind, "seeded-first-maker-omission", "faultInjection.kind");
    const criterion = nonEmpty(fault.criterion, "faultInjection.criterion");
    if (!rubricById.has(criterion)) throw new Error("faultInjection.criterion is not in rubric");
    equal(fault.seededReceiptModel, "fixture:seeded-maker-error", "faultInjection.seededReceiptModel");
    if (!fixtureMakerSeen) throw new Error("fault injection lacks seeded maker receipt");
  }
}

export function caughtSelfApprovedError(evidence: MakerVerifierEvidence): boolean {
  return evidence.trace.iterations.some(
    (iteration) => iteration.maker.selfAssessment.pass && !iteration.verifier.pass
  );
}

function validateRubric(value: unknown): MakerVerifierRubric {
  if (!Array.isArray(value) || value.length < 3 || value.length > 7) throw new Error("rubric must contain 3-7 criteria");
  const ids = new Set<string>();
  const rubric = value.map((raw, index) => {
    const criterion = record(raw, `rubric[${index}]`);
    const id = nonEmpty(criterion.id, `rubric[${index}].id`);
    if (ids.has(id)) throw new Error(`duplicate rubric ID ${id}`);
    ids.add(id);
    return {
      id,
      description: nonEmpty(criterion.description, `rubric[${index}].description`),
      expected: nonEmpty(criterion.expected, `rubric[${index}].expected`)
    };
  });
  return rubric;
}

function validateCriteria(value: unknown, rubricIds: string[], label: string): VerificationCriterionResult[] {
  if (!Array.isArray(value) || value.length !== rubricIds.length) throw new Error(`${label} must match rubric length`);
  const criteria = value.map((raw, index) => {
    const entry = record(raw, `${label}[${index}]`);
    const criterion = nonEmpty(entry.criterion, `${label}[${index}].criterion`);
    if (typeof entry.pass !== "boolean") throw new Error(`${label}[${index}].pass must be boolean`);
    return { criterion, pass: entry.pass, observed: nonEmpty(entry.observed, `${label}[${index}].observed`) };
  });
  const actualIds = criteria.map(({ criterion }) => criterion).sort();
  if (JSON.stringify(actualIds) !== JSON.stringify([...rubricIds].sort())) throw new Error(`${label} IDs must equal rubric IDs`);
  return criteria;
}

function validateFailures(
  value: unknown,
  criteria: VerificationCriterionResult[],
  rubric: Map<string, MakerVerifierRubric[number]>,
  label: string
): StructuredFailure[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const failures = value.map((raw, index) => {
    const failure = record(raw, `${label}[${index}]`);
    return {
      criterion: nonEmpty(failure.criterion, `${label}[${index}].criterion`),
      expected: nonEmpty(failure.expected, `${label}[${index}].expected`),
      observed: nonEmpty(failure.observed, `${label}[${index}].observed`)
    };
  });
  const expected = criteria.filter(({ pass }) => !pass).map(({ criterion, observed }) => ({
    criterion,
    expected: rubric.get(criterion)!.expected,
    observed
  }));
  if (JSON.stringify(failures) !== JSON.stringify(expected)) throw new Error(`${label} must equal failed verifier criteria`);
  return failures;
}

function validateReceipt(value: unknown, label: string): ModelCallTraceReceipt {
  const receipt = record(value, label);
  nonEmpty(receipt.requestedModel, `${label}.requestedModel`);
  if (!Array.isArray(receipt.exactModels) || receipt.exactModels.length < 1 || receipt.exactModels.some((id) => typeof id !== "string" || !id)) {
    throw new Error(`${label}.exactModels must not be empty`);
  }
  if (receipt.stopReason !== null && typeof receipt.stopReason !== "string") throw new Error(`${label}.stopReason is invalid`);
  equal(receipt.refused, false, `${label}.refused`);
  const costUsd = nonNegative(receipt.costUsd, `${label}.costUsd`);
  nonNegative(receipt.durationMs, `${label}.durationMs`);
  const usage = validateUsage(receipt.usage, `${label}.usage`);
  if (!Array.isArray(receipt.modelUsage)) throw new Error(`${label}.modelUsage must be an array`);
  if (receipt.modelUsage.length === 0) {
    if (!(receipt.exactModels as string[]).every((model) => model.startsWith("fixture:")) || costUsd !== 0 || tokenTotal(usage) !== 0) {
      throw new Error(`${label} empty modelUsage is allowed only for zero-cost fixtures`);
    }
  } else {
    let modelCost = 0;
    let modelTokens = emptyUsage();
    const models: string[] = [];
    for (const [index, rawModel] of receipt.modelUsage.entries()) {
      const model = record(rawModel, `${label}.modelUsage[${index}]`);
      models.push(nonEmpty(model.model, `${label}.modelUsage[${index}].model`));
      modelCost += nonNegative(model.costUsd, `${label}.modelUsage[${index}].costUsd`);
      modelTokens = addUsage(modelTokens, validateUsage(model, `${label}.modelUsage[${index}]`));
    }
    if (JSON.stringify([...new Set(models)].sort()) !== JSON.stringify([...(receipt.exactModels as string[])].sort())) {
      throw new Error(`${label}.exactModels must equal modelUsage models`);
    }
    if (Math.abs(modelCost - costUsd) > 1e-9) throw new Error(`${label}.costUsd must equal modelUsage cost`);
    if (JSON.stringify(modelTokens) !== JSON.stringify(usage)) throw new Error(`${label}.usage must equal modelUsage tokens`);
  }
  return receipt as unknown as ModelCallTraceReceipt;
}

function validateDuration(
  receipt: ModelCallTraceReceipt,
  startedAt: string,
  completedAt: string,
  label: string
): void {
  const elapsedMs = Date.parse(completedAt) - Date.parse(startedAt);
  const fixture = receipt.exactModels.every((model) => model.startsWith("fixture:"));
  if (!fixture && receipt.durationMs <= 0) throw new Error(`${label} must be positive for live calls`);
  if (receipt.durationMs > elapsedMs + 2_000) throw new Error(`${label} exceeds timestamp interval`);
}

function validateUsage(value: unknown, label: string): ModelTokenUsage {
  const usage = record(value, label);
  return {
    inputTokens: nonNegativeInteger(usage.inputTokens, `${label}.inputTokens`),
    outputTokens: nonNegativeInteger(usage.outputTokens, `${label}.outputTokens`),
    cacheReadInputTokens: nonNegativeInteger(usage.cacheReadInputTokens, `${label}.cacheReadInputTokens`),
    cacheCreationInputTokens: nonNegativeInteger(usage.cacheCreationInputTokens, `${label}.cacheCreationInputTokens`)
  };
}

function normalizeFailureSet(failures: readonly StructuredFailure[]): string {
  return JSON.stringify(
    [...failures]
      .map((failure) => ({
        criterion: normalize(failure.criterion),
        expected: normalize(failure.expected),
        observed: normalize(failure.observed)
      }))
      .sort((left, right) => left.criterion.localeCompare(right.criterion))
  );
}

function normalize(value: string): string {
  return value.trim().replace(/\s+/g, " ");
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

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function nonNegative(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${label} must be non-negative`);
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  const number = nonNegative(value, label);
  if (!Number.isInteger(number)) throw new Error(`${label} must be an integer`);
  return number;
}

function positiveInteger(value: unknown, label: string): number {
  const number = nonNegativeInteger(value, label);
  if (number < 1) throw new Error(`${label} must be a positive integer`);
  return number;
}

function isoTimestamp(value: unknown, label: string): string {
  const timestamp = nonEmpty(value, label);
  if (Number.isNaN(Date.parse(timestamp))) throw new Error(`${label} must be an ISO timestamp`);
  return timestamp;
}

function sha256(value: unknown, label: string): string {
  const hash = nonEmpty(value, label);
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`${label} must be a SHA-256 digest`);
  return hash;
}

function equal(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) throw new Error(`${label} must equal ${String(expected)}`);
}
