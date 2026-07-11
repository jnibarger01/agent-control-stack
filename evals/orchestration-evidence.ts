import type { ModelTokenUsage } from "../harness/model-provider.js";
import type { PatternCaps, PatternSpendLog, PatternSpendReceipt } from "../harness/orchestration-patterns.js";

export interface OrchestrationEvidence {
  schemaVersion: 1;
  kind: "orchestration-pattern-evidence";
  recordedAt: string;
  executionMode: "headless-deterministic-fixture" | "headless-claude-cli";
  platformFact: "docs/platform-facts.md:52";
  pattern: PatternSpendLog["pattern"];
  taskIds: string[];
  caps: PatternCaps & { maxIterations?: number };
  expectedFailure: null | "iteration_cap";
  result: unknown | null;
  spendLog: PatternSpendLog;
}

export function assertOrchestrationEvidence(value: unknown): asserts value is OrchestrationEvidence {
  const evidence = record(value, "orchestration evidence");
  equal(evidence.schemaVersion, 1, "schemaVersion");
  equal(evidence.kind, "orchestration-pattern-evidence", "kind");
  isoTimestamp(evidence.recordedAt, "recordedAt");
  const mode = evidence.executionMode;
  if (mode !== "headless-deterministic-fixture" && mode !== "headless-claude-cli") {
    throw new Error("executionMode is invalid");
  }
  equal(evidence.platformFact, "docs/platform-facts.md:52", "platformFact");
  if (!isPattern(evidence.pattern)) throw new Error("pattern is invalid");
  const pattern = evidence.pattern;
  if (!Array.isArray(evidence.taskIds) || evidence.taskIds.length < 1 || evidence.taskIds.some((id) => typeof id !== "string" || !id)) {
    throw new Error("taskIds must contain at least one task ID");
  }
  if (new Set(evidence.taskIds).size !== evidence.taskIds.length) throw new Error("taskIds must be unique");

  const caps = record(evidence.caps, "caps");
  const maxTokens = positiveInteger(caps.maxTokens, "caps.maxTokens");
  positiveInteger(caps.maxWallClockMs, "caps.maxWallClockMs");
  const maxSpendUsd = positive(caps.maxSpendUsd, "caps.maxSpendUsd");
  const maxIterations = caps.maxIterations === undefined
    ? undefined
    : positiveInteger(caps.maxIterations, "caps.maxIterations");
  if (pattern === "loopUntilDone" && maxIterations === undefined) throw new Error("loop evidence requires maxIterations");
  if (pattern !== "loopUntilDone" && maxIterations !== undefined) throw new Error("non-loop evidence cannot set maxIterations");

  const log = record(evidence.spendLog, "spendLog");
  equal(log.pattern, pattern, "spendLog.pattern");
  if (log.status !== "completed" && log.status !== "failed") throw new Error("spendLog.status is invalid");
  const predictedCostUsd = positive(log.predictedCostUsd, "spendLog.predictedCostUsd");
  const actualCostUsd = nonNegative(log.actualCostUsd, "spendLog.actualCostUsd");
  const elapsedMs = nonNegative(log.elapsedMs, "spendLog.elapsedMs");
  if (predictedCostUsd > maxSpendUsd + 1e-9) throw new Error("predicted spend exceeds cap");
  if (actualCostUsd > maxSpendUsd + 1e-9) throw new Error("actual spend exceeds cap");
  if (elapsedMs > (caps.maxWallClockMs as number)) throw new Error("elapsed wall time exceeds cap");
  const aggregateUsage = validateUsage(log.usage, "spendLog.usage");
  if (tokenTotal(aggregateUsage) > maxTokens) throw new Error("actual token usage exceeds cap");
  const aggregateModels = stringArray(log.exactModels, "spendLog.exactModels");
  if (!Array.isArray(log.calls) || log.calls.length < 1) throw new Error("spendLog.calls must not be empty");

  let callCost = 0;
  let callPredicted = 0;
  let callUsage = emptyUsage();
  const callModels = new Set<string>();
  const roles: string[] = [];
  for (const [index, rawCall] of log.calls.entries()) {
    const label = `spendLog.calls[${index}]`;
    const call = record(rawCall, label);
    roles.push(nonEmpty(call.role, `${label}.role`));
    nonEmpty(call.requestedModel, `${label}.requestedModel`);
    for (const model of stringArray(call.exactModels, `${label}.exactModels`)) callModels.add(model);
    callPredicted += positive(call.predictedCostUsd, `${label}.predictedCostUsd`);
    callCost += nonNegative(call.actualCostUsd, `${label}.actualCostUsd`);
    callUsage = addUsage(callUsage, validateUsage(call.usage, `${label}.usage`));
  }
  if (new Set(roles).size !== roles.length) throw new Error("spendLog call roles must be unique");
  if (Math.abs(callCost - actualCostUsd) > 1e-9) throw new Error("spendLog.actualCostUsd must equal call receipts");
  if (callPredicted - predictedCostUsd > 1e-9) throw new Error("call predictions exceed run prediction");
  if (JSON.stringify(callUsage) !== JSON.stringify(aggregateUsage)) throw new Error("spendLog.usage must equal call usage");
  if (JSON.stringify([...callModels].sort()) !== JSON.stringify([...aggregateModels].sort())) {
    throw new Error("spendLog.exactModels must equal call exact models");
  }
  validateRoles(pattern, roles, maxIterations);

  if (mode === "headless-deterministic-fixture") {
    if (aggregateModels.some((id) => !id.startsWith("fixture:"))) throw new Error("fixture evidence must use fixture models");
    equal(actualCostUsd, 0, "spendLog.actualCostUsd");
  } else {
    if (aggregateModels.some((id) => id.startsWith("fixture:"))) throw new Error("live evidence cannot use fixture models");
    positive(actualCostUsd, "spendLog.actualCostUsd");
  }

  if (evidence.expectedFailure === null) {
    equal(log.status, "completed", "spendLog.status");
    if (log.failureCode !== undefined) throw new Error("completed spendLog cannot have failureCode");
    const result = record(evidence.result, "result");
    const resultSpend = record(result.spend, "result.spend");
    if (JSON.stringify(resultSpend) !== JSON.stringify(spendProjection(log))) {
      throw new Error("result.spend must equal spendLog receipt");
    }
    validateCompletedResult(pattern, result, maxIterations, roles.length);
  } else {
    equal(evidence.expectedFailure, "iteration_cap", "expectedFailure");
    equal(pattern, "loopUntilDone", "pattern");
    equal(log.status, "failed", "spendLog.status");
    equal(log.failureCode, "iteration_cap", "spendLog.failureCode");
    equal(evidence.result, null, "result");
    equal(roles.length, (maxIterations as number) * 2, "iteration-cap call count");
  }
}

function validateRoles(
  pattern: PatternSpendLog["pattern"],
  roles: string[],
  maxIterations: number | undefined
): void {
  if (pattern === "fanOutSynthesize") {
    if (roles.filter((role) => role.startsWith("worker:")).length < 1 || roles.filter((role) => role === "synthesizer").length !== 1) {
      throw new Error("fan-out roles require workers and one synthesizer");
    }
    if (roles.some((role) => role !== "synthesizer" && !role.startsWith("worker:"))) throw new Error("fan-out has unknown role");
    return;
  }
  if (pattern === "adversarial") {
    if (JSON.stringify(roles) !== JSON.stringify(["maker", "critic", "judge"])) throw new Error("adversarial roles are invalid");
    return;
  }
  if (roles.length % 2 !== 0 || roles.length > (maxIterations as number) * 2) throw new Error("loop call count is invalid");
  for (let index = 0; index < roles.length / 2; index += 1) {
    if (roles[index * 2] !== `maker:${index + 1}` || roles[index * 2 + 1] !== `verifier:${index + 1}`) {
      throw new Error("loop roles are invalid");
    }
  }
}

function validateCompletedResult(
  pattern: PatternSpendLog["pattern"],
  result: Record<string, unknown>,
  maxIterations: number | undefined,
  callCount: number
): void {
  if (pattern === "fanOutSynthesize") {
    if (!Array.isArray(result.workerOutputs) || result.workerOutputs.length < 1) throw new Error("fan-out result lacks workers");
    record(result.synthesis, "result.synthesis");
    return;
  }
  if (pattern === "adversarial") {
    nonEmpty(result.makerOutput, "result.makerOutput");
    const position = nonEmpty(result.criticPosition, "result.criticPosition");
    if (position !== "refute" && position !== "concede") throw new Error("result.criticPosition is invalid");
    nonEmpty(result.criticRefutation, "result.criticRefutation");
    const verdict = nonEmpty(result.verdict, "result.verdict");
    if (verdict !== "maker" && verdict !== "critic" && verdict !== "mixed") throw new Error("result.verdict is invalid");
    if (position === "concede" && verdict === "critic") throw new Error("judge selected a conceding critic");
    nonEmpty(result.output, "result.output");
    nonEmpty(result.justification, "result.justification");
    return;
  }
  equal(result.verified, true, "result.verified");
  const iterations = positiveInteger(result.iterations, "result.iterations");
  if (iterations > (maxIterations as number)) throw new Error("result.iterations exceeds cap");
  equal(callCount, iterations * 2, "loop call count");
  nonEmpty(result.output, "result.output");
}

function spendProjection(log: Record<string, unknown>): PatternSpendReceipt {
  return {
    predictedCostUsd: log.predictedCostUsd as number,
    actualCostUsd: log.actualCostUsd as number,
    elapsedMs: log.elapsedMs as number,
    usage: log.usage as ModelTokenUsage,
    exactModels: log.exactModels as string[],
    calls: log.calls as PatternSpendReceipt["calls"]
  };
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

function isPattern(value: unknown): value is PatternSpendLog["pattern"] {
  return value === "fanOutSynthesize" || value === "adversarial" || value === "loopUntilDone";
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

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.some((entry) => typeof entry !== "string" || !entry)) {
    throw new Error(`${label} must contain non-empty strings`);
  }
  return value as string[];
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be non-empty text`);
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
  if (number < 1) throw new Error(`${label} must be positive`);
  return number;
}

function positive(value: unknown, label: string): number {
  const number = nonNegative(value, label);
  if (number <= 0) throw new Error(`${label} must be positive`);
  return number;
}

function isoTimestamp(value: unknown, label: string): string {
  const timestamp = nonEmpty(value, label);
  if (Number.isNaN(Date.parse(timestamp))) throw new Error(`${label} must be an ISO timestamp`);
  return timestamp;
}

function equal(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) throw new Error(`${label} must equal ${String(expected)}`);
}
