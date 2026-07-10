import { describe, expect, it } from "vitest";
import type { CompletionRequest, CompletionResult, ModelProvider } from "./model-provider.js";
import { createMakerVerifier, type MakerVerifierRubric, type MakerVerifierTask } from "./maker-verifier.js";
import { MODEL_IDS } from "./routing.js";

const task: MakerVerifierTask = {
  id: "task-maker-verifier",
  taskClass: "bulk_worker",
  input: "Return the approved actor and action.",
  context: { facts: ["actor=operator", "action=read"], constraints: ["no approval bypass"] }
};

const rubric: MakerVerifierRubric = [
  { id: "actor", description: "Names the actor", expected: "operator" },
  { id: "action", description: "Names the action", expected: "read" },
  { id: "approval", description: "Preserves approval", expected: "no bypass" }
];

function maker(output: string, pass = true): string {
  return JSON.stringify({ output, selfAssessment: { pass, summary: pass ? "Looks complete." : "Needs work." } });
}

function verification(failures: string[] = []): string {
  return JSON.stringify({
    criteria: rubric.map((criterion) => ({
      criterion: criterion.id,
      pass: !failures.includes(criterion.id),
      observed: failures.includes(criterion.id) ? `${criterion.id} was absent` : `${criterion.id} was observed`
    }))
  });
}

class ScriptedProvider implements ModelProvider {
  readonly requests: CompletionRequest[] = [];

  constructor(
    private readonly replies: string[],
    private readonly costUsd: number,
    private readonly inputTokens: number,
    private readonly outputTokens: number
  ) {}

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    this.requests.push(structuredClone(request));
    const text = this.replies.shift();
    if (text === undefined) throw new Error("scripted provider exhausted");
    return {
      text,
      requestedModel: request.model,
      exactModels: [`${request.model}-exact`],
      stopReason: "end_turn",
      refused: false,
      costUsd: this.costUsd,
      durationMs: 5,
      usage: {
        inputTokens: this.inputTokens,
        outputTokens: this.outputTokens,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0
      },
      modelUsage: []
    };
  }
}

function factory(makerProvider: ModelProvider, createVerifierProvider: () => ModelProvider) {
  return createMakerVerifier({
    makerProvider,
    createVerifierProvider,
    maxBudgetUsd: 0.1,
    timeoutMs: 1_000,
    now: sequenceClock()
  });
}

function freshVerifier(delegate: ModelProvider): () => ModelProvider {
  return () => ({ complete: (request) => delegate.complete(request) });
}

describe("makerVerifier", () => {
  it("uses a fresh verifier call containing only task, rubric, and candidate output", async () => {
    const makerProvider = new ScriptedProvider([maker("operator read; no bypass")], 0.01, 100, 20);
    const verifierProvider = new ScriptedProvider([verification()], 0.002, 80, 10);

    const result = await factory(makerProvider, freshVerifier(verifierProvider))(task, rubric, 1);

    expect(result.pass).toBe(true);
    expect(makerProvider.requests).toHaveLength(1);
    expect(verifierProvider.requests).toHaveLength(1);
    const payload = JSON.parse(verifierProvider.requests[0]!.prompt);
    expect(Object.keys(payload)).toEqual(["task", "rubric", "candidateOutput"]);
    expect(Object.keys(payload.task)).toEqual(["input", "context"]);
    expect(JSON.stringify(payload)).not.toContain("selfAssessment");
    expect(JSON.stringify(payload)).not.toContain("Looks complete");
    const criterionSchema = (
      verifierProvider.requests[0]!.jsonSchema as {
        properties: { criteria: { items: { properties: { criterion: { enum: string[] } } } } };
      }
    ).properties.criteria.items.properties.criterion;
    expect(criterionSchema.enum).toEqual(rubric.map(({ id }) => id));
  });

  it("sends the next maker only original input/context and structured failures", async () => {
    const makerProvider = new ScriptedProvider(
      [maker("missing actor"), maker("operator read; no bypass")],
      0.01,
      100,
      20
    );
    const verifierProvider = new ScriptedProvider([verification(["actor"]), verification()], 0.002, 80, 10);

    let verifierCalls = 0;
    const result = await factory(makerProvider, () => {
      verifierCalls += 1;
      return { complete: (request) => verifierProvider.complete(request) };
    })(task, rubric, 2);

    expect(result.pass).toBe(true);
    expect(verifierCalls).toBe(2);
    const retry = JSON.parse(makerProvider.requests[1]!.prompt);
    expect(Object.keys(retry)).toEqual(["task", "failures"]);
    expect(retry.task).toEqual({ input: task.input, context: task.context });
    expect(retry.failures).toEqual([
      { criterion: "actor", expected: "operator", observed: "actor was absent" }
    ]);
    expect(JSON.stringify(retry)).not.toContain("justification");
    expect(JSON.stringify(retry)).not.toContain('"pass"');
    expect(JSON.stringify(retry)).not.toContain("action was observed");
  });

  it("escalates through route() when the normalized failure set repeats", async () => {
    const makerProvider = new ScriptedProvider(
      [maker("attempt 1"), maker("attempt 2"), maker("operator read; no bypass")],
      0.01,
      100,
      20
    );
    const verifierProvider = new ScriptedProvider(
      [verification(["actor"]), verification(["actor"]), verification()],
      0.002,
      80,
      10
    );

    const result = await factory(makerProvider, freshVerifier(verifierProvider))(task, rubric, 3);

    expect(makerProvider.requests.map((request) => request.model)).toEqual([
      MODEL_IDS.sonnet,
      MODEL_IDS.sonnet,
      MODEL_IDS.fable
    ]);
    expect(result.trace.escalations).toEqual([
      {
        iteration: 2,
        reason: "identical_failure_set",
        fromModel: MODEL_IDS.sonnet,
        toModel: MODEL_IDS.fable
      }
    ]);
  });

  it("stops at maxIters without allowing the maker to declare success", async () => {
    const makerProvider = new ScriptedProvider([maker("bad", true), maker("still bad", true)], 0.01, 100, 20);
    const verifierProvider = new ScriptedProvider(
      [verification(["actor"]), verification(["action"])],
      0.002,
      80,
      10
    );

    const result = await factory(makerProvider, freshVerifier(verifierProvider))(task, rubric, 2);

    expect(result).toMatchObject({ pass: false, stoppedBy: "max_iters", iterations: 2 });
    expect(result.trace.iterations).toHaveLength(2);
    expect(makerProvider.requests).toHaveLength(2);
    expect(verifierProvider.requests).toHaveLength(2);
  });

  it("fails closed on malformed maker output", async () => {
    const makerProvider = new ScriptedProvider(['{"output":"answer"}'], 0.01, 100, 20);
    const verifierProvider = new ScriptedProvider([verification()], 0.002, 80, 10);

    await expect(factory(makerProvider, freshVerifier(verifierProvider))(task, rubric, 1)).rejects.toThrow("maker response");
    expect(verifierProvider.requests).toHaveLength(0);
  });

  it("fails closed on malformed verifier output", async () => {
    const makerProvider = new ScriptedProvider([maker("answer")], 0.01, 100, 20);
    const verifierProvider = new ScriptedProvider(['{"criteria":[]}'], 0.002, 80, 10);

    await expect(factory(makerProvider, freshVerifier(verifierProvider))(task, rubric, 1)).rejects.toThrow("verifier response");
  });

  it("records evidence when maker self-critique passes but independent verification fails", async () => {
    const makerProvider = new ScriptedProvider([maker("confident but incomplete", true)], 0.01, 100, 20);
    const verifierProvider = new ScriptedProvider([verification(["approval"])], 0.002, 80, 10);

    const result = await factory(makerProvider, freshVerifier(verifierProvider))(task, rubric, 1);

    expect(result.pass).toBe(false);
    expect(result.trace.iterations[0]!.maker.selfAssessment.pass).toBe(true);
    expect(result.trace.iterations[0]!.verifier.pass).toBe(false);
    expect(result.trace.iterations[0]!.failures).toEqual([
      { criterion: "approval", expected: "no bypass", observed: "approval was absent" }
    ]);
  });

  it("aggregates per-call model, usage, cost, and timing receipts into the trace", async () => {
    const makerProvider = new ScriptedProvider([maker("bad"), maker("good")], 0.01, 100, 20);
    const verifierProvider = new ScriptedProvider([verification(["actor"]), verification()], 0.002, 80, 10);

    const result = await factory(makerProvider, freshVerifier(verifierProvider))(task, rubric, 2);

    expect(result.trace).toMatchObject({
      schemaVersion: 1,
      taskId: task.id,
      maxIters: 2,
      stoppedBy: "verified",
      totalCostUsd: 0.024,
      totalUsage: {
        inputTokens: 360,
        outputTokens: 60,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0
      }
    });
    expect(result.trace.iterations[0]!.maker.receipt).toMatchObject({
      requestedModel: MODEL_IDS.sonnet,
      exactModels: [`${MODEL_IDS.sonnet}-exact`],
      costUsd: 0.01,
      durationMs: 5
    });
    expect(result.trace.startedAt).toBe("2026-07-09T00:00:00.000Z");
    expect(result.trace.completedAt).toBe("2026-07-09T00:00:04.000Z");
  });

  it("rejects an invalid iteration guard before making calls", async () => {
    const makerProvider = new ScriptedProvider([], 0.01, 100, 20);
    const verifierProvider = new ScriptedProvider([], 0.002, 80, 10);

    await expect(factory(makerProvider, freshVerifier(verifierProvider))(task, rubric, 0)).rejects.toThrow("maxIters");
    expect(makerProvider.requests).toHaveLength(0);
  });

  it("rejects a verifier provider that carries maker or prior-verifier context", async () => {
    const makerProvider = new ScriptedProvider([maker("bad"), maker("still bad")], 0.01, 100, 20);
    const reusedVerifier = new ScriptedProvider([verification(["actor"])], 0.002, 80, 10);

    await expect(factory(makerProvider, () => reusedVerifier)(task, rubric, 2)).rejects.toThrow("no prior context");
    expect(reusedVerifier.requests).toHaveLength(1);

    const sharedProvider = new ScriptedProvider([maker("answer")], 0.01, 100, 20);
    await expect(factory(sharedProvider, () => sharedProvider)(task, rubric, 1)).rejects.toThrow("no prior context");
  });
});

function sequenceClock(): () => string {
  let tick = 0;
  return () => `2026-07-09T00:00:0${tick++}.000Z`;
}
