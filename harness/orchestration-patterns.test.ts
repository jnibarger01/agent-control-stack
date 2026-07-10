import { describe, expect, it } from "vitest";
import { loadEvalTaskCorpus } from "../evals/task-schema.js";
import type { CompletionRequest, CompletionResult, ModelProvider, ModelTokenUsage } from "./model-provider.js";
import {
  SYNTHESIS_BARRIER_RUBRIC,
  adversarial,
  fanOutSynthesize,
  loopUntilDone,
  type AdversarialOptions,
  type FanOutOptions,
  type LoopOptions,
  type PatternSpendLog
} from "./orchestration-patterns.js";
import { MODEL_IDS } from "./routing.js";

type Fixture = string | ((request: CompletionRequest) => CompletionResult | Promise<CompletionResult>);

class FixtureProvider implements ModelProvider {
  readonly requests: CompletionRequest[] = [];

  constructor(private readonly fixtures: Fixture[]) {}

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    this.requests.push(structuredClone(request));
    const fixture = this.fixtures.shift();
    if (fixture === undefined) throw new Error("fixture queue exhausted");
    return typeof fixture === "function" ? fixture(request) : completion(request, fixture);
  }
}

const usage = (inputTokens = 10, outputTokens = 5): ModelTokenUsage => ({
  inputTokens,
  outputTokens,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0
});

const completion = (
  request: CompletionRequest,
  text: string,
  overrides: Partial<CompletionResult> = {}
): CompletionResult => ({
  text,
  requestedModel: request.model,
  exactModels: [request.model],
  stopReason: "end_turn",
  refused: false,
  costUsd: 0.01,
  durationMs: 1,
  usage: usage(),
  modelUsage: [],
  ...overrides
});

const plan = { model: MODEL_IDS.haiku, estimate: { inputTokens: 100, outputTokens: 50 } } as const;
const caps = { maxTokens: 10_000, maxWallClockMs: 10_000, maxSpendUsd: 1 } as const;
const evalTasks = loadEvalTaskCorpus(new URL("../evals/tasks/", import.meta.url));
const approvalTask = evalTasks.find((task) => task.id === "approval-binding-check")!;
const auditTask = evalTasks.find((task) => task.id === "audit-replay-invariant")!;
const synthesis = JSON.stringify({
  output: "combined",
  deduplicatedClaims: ["claim-a", "claim-b"],
  conflicts: [],
  rubric: SYNTHESIS_BARRIER_RUBRIC.map((criterion) => ({
    criterionId: criterion.criterionId,
    pass: true,
    justification: "fixture satisfied"
  }))
});

const fanOptions = (provider: ModelProvider, log?: (entry: PatternSpendLog) => void): FanOutOptions => ({
  provider,
  pricingDate: "2026-07-09",
  caps,
  worker: plan,
  synthesizer: plan,
  log: log ?? (() => undefined)
});

const adversarialOptions = (provider: ModelProvider): AdversarialOptions => ({
  provider,
  pricingDate: "2026-07-09",
  caps,
  maker: plan,
  critic: plan,
  judge: plan,
  log: () => undefined
});

const loopOptions = (
  provider: ModelProvider,
  overrides: Partial<LoopOptions> = {}
): LoopOptions => ({
  provider,
  pricingDate: "2026-07-09",
  caps: { ...caps, maxIterations: 2 },
  maker: plan,
  verifier: plan,
  rubric: [{ id: "correct", description: "The answer is correct.", expected: "Return 4." }],
  log: () => undefined,
  ...overrides
});

describe("fanOutSynthesize", () => {
  it("isolates worker slices, applies the synthesis barrier, and logs spend", async () => {
    const provider = new FixtureProvider([
      JSON.stringify({ output: "worker-a" }),
      JSON.stringify({ output: "worker-b" }),
      synthesis
    ]);
    const logs: PatternSpendLog[] = [];

    const result = await fanOutSynthesize(
      [
        { id: approvalTask.id, input: approvalTask.input },
        { id: auditTask.id, input: auditTask.input }
      ],
      fanOptions(provider, (entry) => logs.push(entry))
    );

    expect(provider.requests[0]!.prompt).toContain(approvalTask.id);
    expect(provider.requests[0]!.prompt).not.toContain(auditTask.id);
    expect(provider.requests[1]!.prompt).toContain(auditTask.id);
    expect(provider.requests[1]!.prompt).not.toContain(approvalTask.id);
    expect(provider.requests[2]!.prompt).toContain("worker-a");
    expect(provider.requests[2]!.prompt).toContain("worker-b");
    for (const criterion of SYNTHESIS_BARRIER_RUBRIC) {
      expect(provider.requests[2]!.prompt).toContain(criterion.criterionId);
    }
    expect(JSON.stringify(provider.requests[2]!.jsonSchema)).toContain(
      '"enum":["deduplicate","resolve-conflicts","preserve-coverage"]'
    );
    expect(result.synthesis.output).toBe("combined");
    expect(result.spend.actualCostUsd).toBeCloseTo(0.03);
    expect(result.spend.predictedCostUsd).toBeGreaterThan(0);
    expect(result.spend.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(logs).toMatchObject([{ pattern: "fanOutSynthesize", status: "completed", actualCostUsd: 0.03 }]);
  });

  it("fails closed when the synthesizer does not pass every barrier criterion", async () => {
    const failedBarrier = JSON.stringify({
      output: "unsafe synthesis",
      deduplicatedClaims: [],
      conflicts: [],
      rubric: SYNTHESIS_BARRIER_RUBRIC.map((criterion, index) => ({
        criterionId: criterion.criterionId,
        pass: index !== 0,
        justification: "fixture"
      }))
    });
    const provider = new FixtureProvider([JSON.stringify({ output: "worker" }), failedBarrier]);

    await expect(
      fanOutSynthesize([{ id: "slice", input: "one slice" }], fanOptions(provider))
    ).rejects.toMatchObject({ code: "malformed_response" });
  });

  it("waits for every parallel worker receipt before logging a worker failure", async () => {
    const provider = new FixtureProvider([
      JSON.stringify({ wrong: "malformed" }),
      JSON.stringify({ output: "second worker completed" })
    ]);
    const logs: PatternSpendLog[] = [];

    await expect(
      fanOutSynthesize(
        [
          { id: "first-slice", input: "first" },
          { id: "second-slice", input: "second" }
        ],
        fanOptions(provider, (entry) => logs.push(entry))
      )
    ).rejects.toMatchObject({ code: "malformed_response" });

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ status: "failed", actualCostUsd: 0.02 });
    expect(logs[0]!.calls).toHaveLength(2);
  });
});

describe("adversarial", () => {
  it("gives the judge only the task and visible outputs, never agent reasoning", async () => {
    const provider = new FixtureProvider([
      JSON.stringify({ output: "MAKER_VISIBLE_OUTPUT" }),
      JSON.stringify({ position: "refute", refutation: "CRITIC_VISIBLE_OUTPUT" }),
      JSON.stringify({ verdict: "mixed", output: "FINAL_OUTPUT", justification: "material issue corrected" })
    ]);

    const result = await adversarial(approvalTask.input, adversarialOptions(provider));

    expect(provider.requests[0]!.prompt).toContain(approvalTask.input);
    expect(provider.requests[0]!.prompt).not.toContain("CRITIC_VISIBLE_OUTPUT");
    expect(provider.requests[1]!.prompt).toContain("MAKER_VISIBLE_OUTPUT");
    expect(provider.requests[2]!.prompt).toContain("MAKER_VISIBLE_OUTPUT");
    expect(provider.requests[2]!.prompt).toContain("CRITIC_VISIBLE_OUTPUT");
    expect(provider.requests[2]!.prompt).not.toContain("reasoning");
    expect(provider.requests[2]!.system).toContain("corrected final answer");
    expect(result).toMatchObject({ verdict: "mixed", output: "FINAL_OUTPUT" });
    expect(result.spend.actualCostUsd).toBeCloseTo(0.03);
  });

  it("rejects a judge that selects a conceding critic", async () => {
    const provider = new FixtureProvider([
      JSON.stringify({ output: "maker answer" }),
      JSON.stringify({ position: "concede", refutation: "No material flaw found." }),
      JSON.stringify({ verdict: "critic", output: "maker answer", justification: "inconsistent verdict" })
    ]);

    await expect(adversarial(approvalTask.input, adversarialOptions(provider))).rejects.toMatchObject({
      code: "malformed_response"
    });
  });
});

describe("loopUntilDone", () => {
  it("keeps verifier context independent and exits only on a structured pass", async () => {
    const criterion = auditTask.rubric[0]!;
    const provider = new FixtureProvider([
      JSON.stringify({ candidate: "candidate-v1" }),
      JSON.stringify({
        pass: false,
        failures: [{ criterion: criterion.id, expected: criterion.expected, observed: "Returned 5." }]
      }),
      JSON.stringify({ candidate: "candidate-v2" }),
      JSON.stringify({ pass: true, failures: [] })
    ]);

    const result = await loopUntilDone(
      auditTask.input,
      loopOptions(provider, {
        rubric: auditTask.rubric.map((criterion) => ({
          id: criterion.id,
          description: criterion.description,
          expected: criterion.expected
        }))
      })
    );

    expect(provider.requests[1]!.prompt).toContain("candidate-v1");
    expect(provider.requests[1]!.prompt).toContain(criterion.expected);
    for (const rubricCriterion of auditTask.rubric) {
      expect(JSON.stringify(provider.requests[1]!.jsonSchema)).toContain(
        `"criterion":{"type":"string","const":"${rubricCriterion.id}"}`
      );
      expect(JSON.stringify(provider.requests[1]!.jsonSchema)).toContain(
        `"expected":{"type":"string","const":"${rubricCriterion.expected}"}`
      );
    }
    expect(provider.requests[2]!.prompt).toContain("Returned 5.");
    expect(provider.requests[2]!.prompt).not.toContain("candidate-v1");
    expect(result).toMatchObject({ output: "candidate-v2", iterations: 2, verified: true });
  });

  it("halts an unbounded failing loop at the hard iteration cap", async () => {
    const failed = JSON.stringify({
      pass: false,
      failures: [{ criterion: "correct", expected: "Return 4.", observed: "Still wrong." }]
    });
    const provider = new FixtureProvider([
      JSON.stringify({ candidate: "v1" }),
      failed,
      JSON.stringify({ candidate: "v2" }),
      failed
    ]);

    await expect(loopUntilDone("never passes", loopOptions(provider))).rejects.toMatchObject({
      code: "iteration_cap"
    });
    expect(provider.requests).toHaveLength(4);
  });

  it("fails closed when actual usage crosses the token cap", async () => {
    const logs: PatternSpendLog[] = [];
    const provider = new FixtureProvider([
      (request) =>
        completion(request, JSON.stringify({ candidate: "too expensive" }), {
          usage: usage(10, 1)
        })
    ]);

    await expect(
      loopUntilDone(
        "token bounded",
        loopOptions(provider, {
          caps: { ...caps, maxIterations: 1, maxTokens: 10 },
          log: (entry) => logs.push(entry)
        })
      )
    ).rejects.toMatchObject({ code: "token_cap" });
    expect(logs).toMatchObject([{ status: "failed", failureCode: "token_cap" }]);
  });

  it("fails closed when a call crosses the wall-clock cap", async () => {
    let clock = 0;
    const provider = new FixtureProvider([
      (request) => {
        clock = 101;
        return completion(request, JSON.stringify({ candidate: "late" }));
      }
    ]);

    await expect(
      loopUntilDone(
        "time bounded",
        loopOptions(provider, {
          caps: { ...caps, maxIterations: 1, maxWallClockMs: 100 },
          now: () => clock
        })
      )
    ).rejects.toMatchObject({ code: "wall_clock_cap" });
  });

  it("fails closed when final parsing crosses the wall-clock cap", async () => {
    let clockReads = 0;
    const provider = new FixtureProvider([
      JSON.stringify({ candidate: "on time" }),
      JSON.stringify({ pass: true, failures: [] })
    ]);
    const logs: PatternSpendLog[] = [];

    await expect(
      loopUntilDone(
        "terminal time boundary",
        loopOptions(provider, {
          caps: { ...caps, maxIterations: 1, maxWallClockMs: 100 },
          now: () => (clockReads++ < 7 ? 0 : 101),
          log: (entry) => logs.push(entry)
        })
      )
    ).rejects.toMatchObject({ code: "wall_clock_cap" });

    expect(logs).toMatchObject([
      { status: "failed", failureCode: "wall_clock_cap", elapsedMs: 101 }
    ]);
  });

  it("fails closed when actual receipts cross the spend cap", async () => {
    const provider = new FixtureProvider([
      (request) =>
        completion(request, JSON.stringify({ candidate: "over budget" }), {
          costUsd: 0.02
        })
    ]);

    await expect(
      loopUntilDone(
        "spend bounded",
        loopOptions(provider, {
          caps: { ...caps, maxIterations: 1, maxSpendUsd: 0.01 }
        })
      )
    ).rejects.toMatchObject({ code: "spend_cap" });
  });

  it("rejects malformed verifier responses instead of treating them as success", async () => {
    const provider = new FixtureProvider([
      JSON.stringify({ candidate: "candidate" }),
      JSON.stringify({ pass: false, failures: [] })
    ]);

    await expect(loopUntilDone("malformed verifier", loopOptions(provider))).rejects.toMatchObject({
      code: "malformed_response"
    });
  });
});
