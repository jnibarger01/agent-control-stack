import { createHash } from "node:crypto";

export const GOAL_EVIDENCE_SCHEMA_VERSION = 2 as const;

export interface RawGoalReceipt {
  binary: "claude";
  argv: string[];
  startedAt: string;
  completedAt: string;
  exitCode: 0;
  stderrBytes: number;
  envelope: Record<string, unknown>;
  envelopeSha256: string;
}

export interface GoalEvidence {
  schemaVersion: typeof GOAL_EVIDENCE_SCHEMA_VERSION;
  kind: "claude-goal-evidence";
  recordedAt: string;
  claudeCodeVersion: string;
  taskId: string;
  sessionId: string;
  condition: string;
  platformFact: "docs/platform-facts.md:48";
  invocation: {
    mode: "claude -p";
    requestedModel: string;
    toolsDisabled: true;
    permissionMode: "plan";
    hooksEnabled: true;
    maxTurns: number;
    maxBudgetUsd: number;
  };
  result: {
    exitCode: 0;
    subtype: "success";
    output: string;
    expectedOutput: string;
    numTurns: number;
    terminalReason: "completed";
    stopReason: string;
    actualCostUsd: number;
    exactModels: string[];
    usage: {
      inputTokens: number;
      outputTokens: number;
      cacheReadInputTokens: number;
      cacheCreationInputTokens: number;
    };
  };
  statusQuery: {
    sessionId: string;
    command: "/goal";
    exitCode: 0;
    output: "No goal set. Usage: `/goal <condition>`";
    actualCostUsd: number;
  };
  rawReceipts: {
    initial: RawGoalReceipt;
    status: RawGoalReceipt;
  };
  workspaceStatus: {
    beforeSha256: string;
    afterSha256: string;
    unchanged: true;
  };
  proof: {
    manualClearIssued: false;
    evaluatorClearedGoal: true;
    filesModifiedByInvocation: [];
    method: string;
  };
}

export function envelopeSha256(envelope: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(envelope), "utf8").digest("hex");
}

export function assertGoalEvidence(value: unknown): asserts value is GoalEvidence {
  const evidence = record(value, "goal evidence");
  equal(evidence.schemaVersion, GOAL_EVIDENCE_SCHEMA_VERSION, "schemaVersion");
  equal(evidence.kind, "claude-goal-evidence", "kind");
  isoTimestamp(evidence.recordedAt, "recordedAt");
  const version = nonEmptyString(evidence.claudeCodeVersion, "claudeCodeVersion");
  if (!/^\d+\.\d+\.\d+ \(Claude Code\)$/.test(version)) throw new Error("claudeCodeVersion is malformed");
  nonEmptyString(evidence.taskId, "taskId");
  const sessionId = uuid(evidence.sessionId, "sessionId");
  const condition = nonEmptyString(evidence.condition, "condition");
  if (condition.length > 4_000) throw new Error("condition must not exceed 4000 characters");
  equal(evidence.platformFact, "docs/platform-facts.md:48", "platformFact");

  const invocation = record(evidence.invocation, "invocation");
  equal(invocation.mode, "claude -p", "invocation.mode");
  const requestedModel = nonEmptyString(invocation.requestedModel, "invocation.requestedModel");
  equal(invocation.toolsDisabled, true, "invocation.toolsDisabled");
  equal(invocation.permissionMode, "plan", "invocation.permissionMode");
  equal(invocation.hooksEnabled, true, "invocation.hooksEnabled");
  const maxTurns = positiveInteger(invocation.maxTurns, "invocation.maxTurns");
  const maxBudgetUsd = nonNegativeNumber(invocation.maxBudgetUsd, "invocation.maxBudgetUsd");

  const rawReceipts = record(evidence.rawReceipts, "rawReceipts");
  const initial = validateRawReceipt(rawReceipts.initial, "rawReceipts.initial");
  const status = validateRawReceipt(rawReceipts.status, "rawReceipts.status");
  validateCommand(initial.argv, {
    sessionFlag: "--session-id",
    sessionId,
    requestedModel,
    maxTurns,
    maxBudgetUsd,
    finalArgument: `/goal ${condition}`
  }, "rawReceipts.initial.argv");
  validateCommand(status.argv, {
    sessionFlag: "--resume",
    sessionId,
    requestedModel,
    maxTurns: 2,
    maxBudgetUsd: 0.02,
    finalArgument: "/goal"
  }, "rawReceipts.status.argv");

  const initialEnvelope = initial.envelope;
  validateResultEnvelope(initialEnvelope, sessionId, "rawReceipts.initial.envelope");
  const statusEnvelope = status.envelope;
  validateResultEnvelope(statusEnvelope, sessionId, "rawReceipts.status.envelope");

  const result = record(evidence.result, "result");
  equal(result.exitCode, 0, "result.exitCode");
  equal(result.subtype, "success", "result.subtype");
  const output = nonEmptyString(result.output, "result.output");
  equal(output, nonEmptyString(result.expectedOutput, "result.expectedOutput"), "result.output");
  equal(initialEnvelope.result, output, "rawReceipts.initial.envelope.result");
  equal(result.numTurns, positiveInteger(initialEnvelope.num_turns, "rawReceipts.initial.envelope.num_turns"), "result.numTurns");
  equal(result.terminalReason, "completed", "result.terminalReason");
  if (initialEnvelope.terminal_reason !== undefined) {
    equal(initialEnvelope.terminal_reason, "completed", "rawReceipts.initial.envelope.terminal_reason");
  }
  equal(result.stopReason, nonEmptyString(initialEnvelope.stop_reason, "rawReceipts.initial.envelope.stop_reason"), "result.stopReason");
  equal(result.actualCostUsd, nonNegativeNumber(initialEnvelope.total_cost_usd, "rawReceipts.initial.envelope.total_cost_usd"), "result.actualCostUsd");
  const rawUsage = modelUsageSummary(initialEnvelope.modelUsage);
  stringArray(result.exactModels, "result.exactModels", 1);
  if (JSON.stringify(result.exactModels) !== JSON.stringify(rawUsage.exactModels)) {
    throw new Error("result.exactModels must equal raw modelUsage keys");
  }
  if (JSON.stringify(result.usage) !== JSON.stringify(rawUsage.usage)) {
    throw new Error("result.usage must equal raw modelUsage totals");
  }

  const statusQuery = record(evidence.statusQuery, "statusQuery");
  equal(statusQuery.sessionId, sessionId, "statusQuery.sessionId");
  equal(statusQuery.command, "/goal", "statusQuery.command");
  equal(statusQuery.exitCode, 0, "statusQuery.exitCode");
  equal(statusQuery.output, "No goal set. Usage: `/goal <condition>`", "statusQuery.output");
  equal(statusEnvelope.result, statusQuery.output, "rawReceipts.status.envelope.result");
  equal(statusQuery.actualCostUsd, nonNegativeNumber(statusEnvelope.total_cost_usd, "rawReceipts.status.envelope.total_cost_usd"), "statusQuery.actualCostUsd");
  equal(statusEnvelope.num_turns, 0, "rawReceipts.status.envelope.num_turns");

  const workspace = record(evidence.workspaceStatus, "workspaceStatus");
  const before = sha256(workspace.beforeSha256, "workspaceStatus.beforeSha256");
  const after = sha256(workspace.afterSha256, "workspaceStatus.afterSha256");
  equal(before, after, "workspace status hashes");
  equal(workspace.unchanged, true, "workspaceStatus.unchanged");

  const proof = record(evidence.proof, "proof");
  equal(proof.manualClearIssued, false, "proof.manualClearIssued");
  equal(proof.evaluatorClearedGoal, true, "proof.evaluatorClearedGoal");
  if (!Array.isArray(proof.filesModifiedByInvocation) || proof.filesModifiedByInvocation.length !== 0) {
    throw new Error("proof.filesModifiedByInvocation must be empty");
  }
  nonEmptyString(proof.method, "proof.method");
}

function validateRawReceipt(value: unknown, label: string): RawGoalReceipt {
  const receipt = record(value, label);
  equal(receipt.binary, "claude", `${label}.binary`);
  if (!Array.isArray(receipt.argv) || receipt.argv.some((arg) => typeof arg !== "string")) {
    throw new Error(`${label}.argv must be a string array`);
  }
  const started = isoTimestamp(receipt.startedAt, `${label}.startedAt`);
  const completed = isoTimestamp(receipt.completedAt, `${label}.completedAt`);
  if (completed < started) throw new Error(`${label} timestamps are reversed`);
  equal(receipt.exitCode, 0, `${label}.exitCode`);
  nonNegativeInteger(receipt.stderrBytes, `${label}.stderrBytes`);
  const envelope = record(receipt.envelope, `${label}.envelope`);
  equal(receipt.envelopeSha256, envelopeSha256(envelope), `${label}.envelopeSha256`);
  return { ...(receipt as unknown as RawGoalReceipt), envelope };
}

interface CommandExpectation {
  sessionFlag: "--session-id" | "--resume";
  sessionId: string;
  requestedModel: string;
  maxTurns: number;
  maxBudgetUsd: number;
  finalArgument: string;
}

function validateCommand(argv: string[], expected: CommandExpectation, label: string): void {
  equal(argv[0], "-p", `${label}[0]`);
  flagValue(argv, expected.sessionFlag, expected.sessionId, label);
  flagValue(argv, "--output-format", "json", label);
  flagValue(argv, "--model", expected.requestedModel, label);
  flagValue(argv, "--tools", "", label);
  flagValue(argv, "--permission-mode", "plan", label);
  flagValue(argv, "--setting-sources", "project", label);
  flagValue(argv, "--max-turns", String(expected.maxTurns), label);
  flagValue(argv, "--max-budget-usd", String(expected.maxBudgetUsd), label);
  if (argv.includes("--no-session-persistence")) throw new Error(`${label} disables session persistence`);
  if (argv.some((arg) => /^\/goal\s+(clear|none|off)\b/i.test(arg))) throw new Error(`${label} contains a clear command`);
  equal(argv.at(-1), expected.finalArgument, `${label} final argument`);
}

function flagValue(argv: string[], flag: string, expected: string, label: string): void {
  const index = argv.indexOf(flag);
  if (index < 0) throw new Error(`${label} is missing ${flag}`);
  equal(argv[index + 1], expected, `${label} ${flag}`);
}

function validateResultEnvelope(envelope: Record<string, unknown>, sessionId: string, label: string): void {
  equal(envelope.type, "result", `${label}.type`);
  equal(envelope.subtype, "success", `${label}.subtype`);
  equal(envelope.is_error, false, `${label}.is_error`);
  equal(envelope.session_id, sessionId, `${label}.session_id`);
  uuid(envelope.uuid, `${label}.uuid`);
}

function modelUsageSummary(value: unknown): {
  exactModels: string[];
  usage: GoalEvidence["result"]["usage"];
} {
  const modelUsage = record(value, "rawReceipts.initial.envelope.modelUsage");
  const exactModels = Object.keys(modelUsage).sort();
  if (exactModels.length < 1) throw new Error("raw modelUsage must not be empty");
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0
  };
  for (const model of exactModels) {
    const receipt = record(modelUsage[model], `modelUsage.${model}`);
    usage.inputTokens += nonNegativeInteger(receipt.inputTokens, `modelUsage.${model}.inputTokens`);
    usage.outputTokens += nonNegativeInteger(receipt.outputTokens, `modelUsage.${model}.outputTokens`);
    usage.cacheReadInputTokens += nonNegativeInteger(receipt.cacheReadInputTokens, `modelUsage.${model}.cacheReadInputTokens`);
    usage.cacheCreationInputTokens += nonNegativeInteger(receipt.cacheCreationInputTokens, `modelUsage.${model}.cacheCreationInputTokens`);
    nonNegativeNumber(receipt.costUSD, `modelUsage.${model}.costUSD`);
  }
  return { exactModels, usage };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function stringArray(value: unknown, label: string, minimum: number): asserts value is string[] {
  if (!Array.isArray(value) || value.length < minimum || value.some((entry) => typeof entry !== "string" || !entry)) {
    throw new Error(`${label} must contain at least ${minimum} non-empty string`);
  }
}

function nonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${label} must be non-negative`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = nonNegativeInteger(value, label);
  if (parsed === 0) throw new Error(`${label} must be positive`);
  return parsed;
}

function nonNegativeInteger(value: unknown, label: string): number {
  const parsed = nonNegativeNumber(value, label);
  if (!Number.isInteger(parsed)) throw new Error(`${label} must be an integer`);
  return parsed;
}

function isoTimestamp(value: unknown, label: string): string {
  const timestamp = nonEmptyString(value, label);
  if (Number.isNaN(Date.parse(timestamp))) throw new Error(`${label} must be an ISO timestamp`);
  return timestamp;
}

function uuid(value: unknown, label: string): string {
  const id = nonEmptyString(value, label);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error(`${label} must be a UUID`);
  }
  return id;
}

function sha256(value: unknown, label: string): string {
  const hash = nonEmptyString(value, label);
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`${label} must be a SHA-256 digest`);
  return hash;
}

function equal(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) throw new Error(`${label} must equal ${String(expected)}`);
}
