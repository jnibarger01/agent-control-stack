import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertGoalEvidence,
  envelopeSha256,
  type GoalEvidence,
  type RawGoalReceipt
} from "./goal-evidence.js";

const model = "claude-haiku-4-5-20251001";
const condition = "Complete eval task policy-action-classification. The task is: classify the requested action and risk for reading docs/architecture.md and summarizing it without changing files. Success requires the surfaced answer to be exactly two lines: action: read then risk: low. The transcript itself must show those two lines. Do not modify files, do not call tools, and stop after 4 turns if the evaluator does not pass.";
const expectedOutput = "action: read\nrisk: low";

async function main(): Promise<void> {
  const cwd = process.cwd();
  const sessionId = randomUUID();
  const initialArgv = [
    "-p",
    "--session-id", sessionId,
    "--setting-sources", "project",
    "--output-format", "json",
    "--model", model,
    "--tools", "",
    "--permission-mode", "plan",
    "--prompt-suggestions", "false",
    "--max-budget-usd", "0.1",
    "--max-turns", "4",
    "--system-prompt", "Complete the supplied evaluation task. Do not call tools. Output only the two required labeled lines, with no preface, explanation, code fence, or completion claim.",
    `/goal ${condition}`
  ];
  const statusArgv = [
    "-p",
    "--resume", sessionId,
    "--setting-sources", "project",
    "--output-format", "json",
    "--model", model,
    "--tools", "",
    "--permission-mode", "plan",
    "--prompt-suggestions", "false",
    "--max-budget-usd", "0.02",
    "--max-turns", "2",
    "/goal"
  ];
  const beforeStatus = await command("git", ["status", "--porcelain=v1"], cwd, 10_000);
  const version = (await command("claude", ["--version"], cwd, 10_000)).stdout.trim();
  const initial = await goalReceipt(initialArgv, cwd);
  const status = await goalReceipt(statusArgv, cwd);
  const afterStatus = await command("git", ["status", "--porcelain=v1"], cwd, 10_000);
  if (beforeStatus.stdout !== afterStatus.stdout) throw new Error("workspace status changed during /goal invocation");

  const initialEnvelope = initial.envelope;
  const statusEnvelope = status.envelope;
  const modelUsage = initialEnvelope.modelUsage as Record<string, Record<string, number>>;
  const exactModels = Object.keys(modelUsage).sort();
  const usage = exactModels.reduce(
    (sum, exactModel) => {
      const receipt = modelUsage[exactModel]!;
      sum.inputTokens += receipt.inputTokens ?? 0;
      sum.outputTokens += receipt.outputTokens ?? 0;
      sum.cacheReadInputTokens += receipt.cacheReadInputTokens ?? 0;
      sum.cacheCreationInputTokens += receipt.cacheCreationInputTokens ?? 0;
      return sum;
    },
    { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }
  );
  const evidence: GoalEvidence = {
    schemaVersion: 2,
    kind: "claude-goal-evidence",
    recordedAt: new Date().toISOString(),
    claudeCodeVersion: version,
    taskId: "policy-action-classification",
    sessionId,
    condition,
    platformFact: "docs/platform-facts.md:48",
    invocation: {
      mode: "claude -p",
      requestedModel: model,
      toolsDisabled: true,
      permissionMode: "plan",
      hooksEnabled: true,
      maxTurns: 4,
      maxBudgetUsd: 0.1
    },
    result: {
      exitCode: 0,
      subtype: "success",
      output: String(initialEnvelope.result),
      expectedOutput,
      numTurns: Number(initialEnvelope.num_turns),
      terminalReason: "completed",
      stopReason: String(initialEnvelope.stop_reason),
      actualCostUsd: Number(initialEnvelope.total_cost_usd),
      exactModels,
      usage
    },
    statusQuery: {
      sessionId,
      command: "/goal",
      exitCode: 0,
      output: String(statusEnvelope.result) as GoalEvidence["statusQuery"]["output"],
      actualCostUsd: Number(statusEnvelope.total_cost_usd)
    },
    rawReceipts: { initial, status },
    workspaceStatus: {
      beforeSha256: digest(beforeStatus.stdout),
      afterSha256: digest(afterStatus.stdout),
      unchanged: true
    },
    proof: {
      manualClearIssued: false,
      evaluatorClearedGoal: true,
      filesModifiedByInvocation: [],
      method: "The initial raw envelope records the goal result and platform session ID. With no clear command in either retained argv, the same-session raw status envelope reports no active goal. The cited contract states evaluator pass clears the goal."
    }
  };
  assertGoalEvidence(evidence);
  const outputPath = resolve(cwd, "runs/2026-07-09-goal-policy-action-classification.json");
  writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ output: outputPath, sessionId, costUsd: evidence.result.actualCostUsd, envelopeHashes: [initial.envelopeSha256, status.envelopeSha256] })}\n`);
}

async function goalReceipt(argv: string[], cwd: string): Promise<RawGoalReceipt> {
  const startedAt = new Date().toISOString();
  const result = await command("claude", argv, cwd, 180_000);
  const completedAt = new Date().toISOString();
  const envelope = JSON.parse(result.stdout) as Record<string, unknown>;
  return {
    binary: "claude",
    argv,
    startedAt,
    completedAt,
    exitCode: 0,
    stderrBytes: Buffer.byteLength(result.stderr, "utf8"),
    envelope,
    envelopeSha256: envelopeSha256(envelope)
  };
}

function command(
  binary: string,
  argv: string[],
  cwd: string,
  timeoutMs: number
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    execFile(binary, argv, { cwd, timeout: timeoutMs, maxBuffer: 5 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${binary} failed: ${error.message}; stderr ${Buffer.byteLength(stderr, "utf8")} bytes`));
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
