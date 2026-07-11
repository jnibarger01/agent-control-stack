import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { redactValue } from "../packages/shared/src/redact.js";
import { ClaudeCliProvider } from "../harness/claude-cli-provider.js";
import {
  adversarial,
  fanOutSynthesize,
  loopUntilDone,
  type PatternSpendLog
} from "../harness/orchestration-patterns.js";
import { MODEL_IDS } from "../harness/routing.js";
import type { OrchestrationEvidence } from "./orchestration-evidence.js";
import { loadEvalTaskCorpus, type EvalTask } from "./task-schema.js";

type LivePattern = "fan-out" | "adversarial" | "loop";

const pricingDate = "2026-07-09";
const caps = { maxTokens: 100_000, maxWallClockMs: 180_000, maxSpendUsd: 0.2 } as const;
const loopCaps = { ...caps, maxIterations: 2 } as const;
const plan = { model: MODEL_IDS.haiku, estimate: { inputTokens: 500, outputTokens: 250 } } as const;

async function main(): Promise<void> {
  const pattern = parsePattern(process.argv.slice(2));
  const cwd = process.cwd();
  const tasks = loadEvalTaskCorpus(new URL("./tasks/", import.meta.url));
  const provider = new ClaudeCliProvider({ cwd });
  const logs: PatternSpendLog[] = [];
  let taskIds: string[];
  let result: unknown;
  let evidencePattern: PatternSpendLog["pattern"];
  let runCaps: OrchestrationEvidence["caps"];

  if (pattern === "fan-out") {
    const approval = findTask(tasks, "approval-binding-check");
    const taskPayload = JSON.stringify({ input: approval.input, context: approval.context, rubric: approval.rubric });
    taskIds = [approval.id];
    evidencePattern = "fanOutSynthesize";
    runCaps = caps;
    result = await fanOutSynthesize(
      [
        {
          id: "approval-action-binding",
          input: `For eval task ${approval.id}, decide execution and analyze exact action-hash binding. Task: ${taskPayload}`
        },
        {
          id: "approval-remediation-audit",
          input: `For eval task ${approval.id}, analyze only required remediation and blocked-attempt audit evidence. Task: ${taskPayload}`
        }
      ],
      { provider, pricingDate, caps, worker: plan, synthesizer: plan, log: (entry) => logs.push(entry) }
    );
  } else if (pattern === "adversarial") {
    const policy = findTask(tasks, "policy-action-classification");
    taskIds = [policy.id];
    evidencePattern = "adversarial";
    runCaps = caps;
    const expectedOutput = policy.reference?.content;
    if (!expectedOutput) throw new Error("policy task requires an exact reference");
    const adversarialResult = await adversarial(
      JSON.stringify({
        input: policy.input,
        context: policy.context,
        rubric: policy.rubric,
        exactReference: expectedOutput,
        finalOutputConstraint: "The judge output field must equal exactReference byte-for-byte."
      }),
      {
      provider,
      pricingDate,
      caps,
      maker: plan,
      critic: plan,
      judge: plan,
      log: (entry) => logs.push(entry)
      }
    );
    if (adversarialResult.output !== expectedOutput) throw new Error("adversarial final output missed exact task oracle");
    result = adversarialResult;
  } else {
    const policy = findTask(tasks, "policy-action-classification");
    taskIds = [policy.id];
    evidencePattern = "loopUntilDone";
    runCaps = loopCaps;
    const loopResult = await loopUntilDone(JSON.stringify({ input: policy.input, context: policy.context }), {
      provider,
      pricingDate,
      caps: loopCaps,
      maker: plan,
      verifier: plan,
      rubric: policy.rubric,
      log: (entry) => logs.push(entry)
    });
    if (policy.reference?.content && loopResult.output !== policy.reference.content) {
      throw new Error("loop final output missed exact task oracle");
    }
    result = loopResult;
  }

  if (logs.length !== 1) throw new Error(`${evidencePattern} must emit exactly one spend log`);
  const evidence: OrchestrationEvidence = {
    schemaVersion: 1,
    kind: "orchestration-pattern-evidence",
    recordedAt: new Date().toISOString(),
    executionMode: "headless-claude-cli",
    platformFact: "docs/platform-facts.md:52",
    pattern: evidencePattern,
    taskIds,
    caps: runCaps,
    expectedFailure: null,
    result,
    spendLog: logs[0]!
  };
  const outputPath = resolve(cwd, `runs/2026-07-09-orchestration-live-${pattern}.json`);
  writeFileSync(outputPath, `${JSON.stringify(redactValue(evidence), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ output: outputPath, pattern: evidencePattern, predictedCostUsd: logs[0]!.predictedCostUsd, actualCostUsd: logs[0]!.actualCostUsd, exactModels: logs[0]!.exactModels })}\n`);
}

function parsePattern(args: string[]): LivePattern {
  if (args.length !== 2 || args[0] !== "--pattern") throw new Error("usage: --pattern fan-out|adversarial|loop");
  const value = args[1];
  if (value !== "fan-out" && value !== "adversarial" && value !== "loop") throw new Error("unknown pattern");
  return value;
}

function findTask(tasks: readonly EvalTask[], id: string): EvalTask {
  const task = tasks.find((candidate) => candidate.id === id);
  if (!task) throw new Error(`missing eval task ${id}`);
  return task;
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
