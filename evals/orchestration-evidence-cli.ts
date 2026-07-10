import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  SYNTHESIS_BARRIER_RUBRIC,
  adversarial,
  fanOutSynthesize,
  loopUntilDone,
  OrchestrationPatternError,
  type LoopCaps,
  type PatternSpendLog
} from "../harness/orchestration-patterns.js";
import type { CompletionRequest, CompletionResult, ModelProvider } from "../harness/model-provider.js";
import { MODEL_IDS } from "../harness/routing.js";
import type { OrchestrationEvidence } from "./orchestration-evidence.js";
import { loadEvalTaskCorpus, type EvalTask } from "./task-schema.js";

const pricingDate = "2026-07-09";
const caps = { maxTokens: 10_000, maxWallClockMs: 10_000, maxSpendUsd: 1 } as const;
const loopCaps: LoopCaps = { ...caps, maxIterations: 2 };
const plan = { model: MODEL_IDS.haiku, estimate: { inputTokens: 100, outputTokens: 50 } } as const;

async function main(): Promise<void> {
  const cwd = process.cwd();
  const tasks = loadEvalTaskCorpus(new URL("./tasks/", import.meta.url));
  const approval = findTask(tasks, "approval-binding-check");
  const audit = findTask(tasks, "audit-replay-invariant");
  const policy = findTask(tasks, "policy-action-classification");

  await writeCompleted(
    resolve(cwd, "runs/2026-07-09-orchestration-fan-out-synthesize.json"),
    "fanOutSynthesize",
    [approval.id, audit.id],
    caps,
    async (log) => fanOutSynthesize(
      [
        { id: approval.id, input: approval.input },
        { id: audit.id, input: audit.input }
      ],
      {
        provider: new QueueFixtureProvider([
          { output: "Approval is bound to the exact action hash." },
          { output: "Replay fails because w1 ran before approval." },
          {
            output: "Approval binding and replay ordering are distinct enforced invariants.",
            deduplicatedClaims: ["exact action-hash binding", "running requires prior approval"],
            conflicts: [],
            rubric: SYNTHESIS_BARRIER_RUBRIC.map(({ criterionId }) => ({
              criterionId,
              pass: true,
              justification: "All fixture slices are represented without conflict."
            }))
          }
        ]),
        pricingDate,
        caps,
        worker: plan,
        synthesizer: plan,
        log
      }
    )
  );

  await writeCompleted(
    resolve(cwd, "runs/2026-07-09-orchestration-adversarial.json"),
    "adversarial",
    [approval.id],
    caps,
    async (log) => adversarial(approval.input, {
      provider: new QueueFixtureProvider([
        { output: "Approval is valid when the request ID matches." },
        {
          position: "refute",
          refutation: "Request ID alone is insufficient; actor and action hash must also match."
        },
        {
          verdict: "critic",
          output: "Require request ID, canonical actor, and exact action hash to match before execution.",
          justification: "The refutation identifies two material binding requirements omitted by the maker."
        }
      ]),
      pricingDate,
      caps,
      maker: plan,
      critic: plan,
      judge: plan,
      log
    })
  );

  await writeCompleted(
    resolve(cwd, "runs/2026-07-09-orchestration-loop-until-done.json"),
    "loopUntilDone",
    [policy.id],
    loopCaps,
    async (log) => loopUntilDone(policy.input, {
      provider: new QueueFixtureProvider([
        { candidate: "action: read" },
        {
          pass: false,
          failures: [{
            criterion: "low-risk",
            expected: "risk: low",
            observed: "The risk line is absent."
          }]
        },
        { candidate: "action: read\nrisk: low" },
        { pass: true, failures: [] }
      ]),
      pricingDate,
      caps: loopCaps,
      maker: plan,
      verifier: plan,
      rubric: policy.rubric,
      log
    })
  );

  await writeExpectedCap(
    resolve(cwd, "runs/2026-07-09-orchestration-loop-iteration-cap.json"),
    audit,
    loopCaps
  );
}

async function writeCompleted(
  outputPath: string,
  pattern: PatternSpendLog["pattern"],
  taskIds: string[],
  runCaps: OrchestrationEvidence["caps"],
  execute: (log: (entry: PatternSpendLog) => void) => Promise<unknown>
): Promise<void> {
  const logs: PatternSpendLog[] = [];
  const result = await execute((entry) => logs.push(entry));
  if (logs.length !== 1) throw new Error(`${pattern} must emit exactly one spend log`);
  writeEvidence(outputPath, {
    schemaVersion: 1,
    kind: "orchestration-pattern-evidence",
    recordedAt: new Date().toISOString(),
    executionMode: "headless-deterministic-fixture",
    platformFact: "docs/platform-facts.md:52",
    pattern,
    taskIds,
    caps: runCaps,
    expectedFailure: null,
    result,
    spendLog: logs[0]!
  });
}

async function writeExpectedCap(outputPath: string, task: EvalTask, runCaps: LoopCaps): Promise<void> {
  const failure = {
    pass: false,
    failures: [{
      criterion: task.rubric[0]!.id,
      expected: task.rubric[0]!.expected,
      observed: "The deliberately unbounded fixture never satisfies this criterion."
    }]
  };
  const logs: PatternSpendLog[] = [];
  try {
    await loopUntilDone(task.input, {
      provider: new QueueFixtureProvider([
        { candidate: "unbounded candidate 1" },
        failure,
        { candidate: "unbounded candidate 2" },
        failure
      ]),
      pricingDate,
      caps: runCaps,
      maker: plan,
      verifier: plan,
      rubric: task.rubric,
      log: (entry) => logs.push(entry)
    });
    throw new Error("deliberately unbounded loop unexpectedly passed");
  } catch (error) {
    if (!(error instanceof OrchestrationPatternError) || error.code !== "iteration_cap") throw error;
  }
  if (logs.length !== 1) throw new Error("capped loop must emit exactly one spend log");
  writeEvidence(outputPath, {
    schemaVersion: 1,
    kind: "orchestration-pattern-evidence",
    recordedAt: new Date().toISOString(),
    executionMode: "headless-deterministic-fixture",
    platformFact: "docs/platform-facts.md:52",
    pattern: "loopUntilDone",
    taskIds: [task.id],
    caps: runCaps,
    expectedFailure: "iteration_cap",
    result: null,
    spendLog: logs[0]!
  });
}

class QueueFixtureProvider implements ModelProvider {
  constructor(private readonly values: Array<Record<string, unknown>>) {}

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const value = this.values.shift();
    if (!value) throw new Error("fixture queue exhausted");
    return {
      text: JSON.stringify(value),
      requestedModel: request.model,
      exactModels: [`fixture:${request.model}`],
      stopReason: "end_turn",
      refused: false,
      costUsd: 0,
      durationMs: 0,
      usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      modelUsage: []
    };
  }
}

function writeEvidence(path: string, evidence: OrchestrationEvidence): void {
  writeFileSync(path, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  process.stdout.write(`${path}\n`);
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
