import { describe, expect, it } from "vitest";
import { ModelBroker, resolveRoutingPolicy, type CallResult } from "./broker.js";
import { availability, catalog, compute, iso, policy, store } from "./fixtures.test-support.js";
import type { ProviderAvailability, RoutingPolicy } from "./types.js";

function setup(opts: { clock?: { ms: number }; avail?: () => ProviderAvailability[]; policy?: Partial<RoutingPolicy> } = {}) {
  const s = store();
  const clock = opts.clock ?? { ms: 0 };
  const broker = new ModelBroker({
    catalog: catalog(),
    store: s.store,
    availability: async () => (opts.avail ? opts.avail() : availability()),
    compute: async () => compute(),
    now: () => new Date(iso(clock.ms)),
    ...(opts.policy ? { policy: opts.policy } : {})
  });
  return { ...s, broker, clock };
}
const req = (requestId: string, extra: Record<string, unknown> = {}) => ({
  requestId,
  taskType: "code_generation",
  privacy: "internal" as const,
  ...extra
});
const okCall = (latencyMs = 100): CallResult<string> => ({ ok: true, value: "answer", latencyMs });
const provFail: CallResult<string> = { ok: false, failureKind: "provider" };

describe("route", () => {
  it("chooses from what is installed and catalogued, and records why", async () => {
    const { broker } = setup();
    const decision = await broker.route(req("r1"));
    expect(decision.mode).toBe("default_priority");
    expect(decision.ranking.map((r) => r.model)).toEqual(["large:20b", "small:4b", "frontier"]);
    expect(decision.rejected).toEqual([{ providerId: "ollama", model: "embed:300m", reasons: ["task_unsupported"] }]);
    expect(decision.computeHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(decision.replayed).toBe(false);
  });

  it("does not assume a model is installed", async () => {
    const { broker } = setup({ avail: () => availability({ ollama: { models: ["small:4b"] } }) });
    const decision = await broker.route(req("r1"));
    expect(decision.ranking.map((r) => r.model)).toEqual(["small:4b", "frontier"]);
    expect(decision.rejected.find((r) => r.model === "large:20b")?.reasons).toContain("not_available");
  });

  it("is idempotent on the request id even if the host changed", async () => {
    let installed = ["small:4b", "large:20b", "embed:300m"];
    const { broker } = setup({ avail: () => availability({ ollama: { models: installed } }) });
    const first = await broker.route(req("r1"));
    installed = [];
    const again = await broker.route(req("r1"));
    expect(again).toMatchObject({ decisionId: first.decisionId, replayed: true });
    expect(again.ranking).toEqual(first.ranking);
  });

  it("rejects malformed requests before touching anything", async () => {
    const { broker, db } = setup();
    for (const bad of [{}, req("r", { privacy: "secret" }), req("../x"), req("r", { taskType: "Bad Type" }), req("r", { requiredContextTokens: 0 }), req("r", { prompt: "leak" })]) {
      await expect(broker.route(bad as never)).rejects.toThrow();
    }
    expect(db.prepare("SELECT COUNT(*) AS n FROM model_route_decisions").get()).toEqual({ n: 0 });
  });

  it("returns an empty ranking, not a guess, when nothing is eligible", async () => {
    const { broker } = setup({ avail: () => [] });
    const decision = await broker.route(req("r1"));
    expect(decision).toMatchObject({ mode: "none", ranking: [] });
    expect(await broker.execute(decision, async () => okCall())).toMatchObject({ ok: false, stoppedBecause: "no_candidates" });
  });

  it("routes confidential work only to local models", async () => {
    const { broker } = setup();
    const decision = await broker.route(req("r1", { privacy: "confidential" }));
    expect(decision.ranking.every((r) => r.kind === "local")).toBe(true);
    expect(decision.rejected.find((r) => r.model === "frontier")?.reasons).toContain("privacy_not_allowed");
  });
});

describe("learning from verified outcomes", () => {
  /** Verified history for small:4b on this task, written through the store the way a validator would. */
  async function seedHistory(t: ReturnType<typeof setup>, n: number, passedOf: (i: number) => boolean) {
    for (let i = 0; i < n; i += 1) {
      t.clock.ms += 1000;
      const decision = await t.broker.route(req(`seed-${i}`));
      const outcomeId = t.store.recordOutcome({
        decisionId: decision.decisionId,
        attempt: 1,
        providerId: "ollama",
        model: "small:4b",
        taskType: "code_generation",
        ok: true,
        latencyMs: 120,
        recordedAt: iso(t.clock.ms)
      });
      t.broker.verify(outcomeId, passedOf(i), "tests");
    }
    t.clock.ms += 120_000;
  }

  it("does not let measured evidence change routing before the minimum sample size", async () => {
    const t = setup();
    await seedHistory(t, 3, () => true);
    const decision = await t.broker.route(req("after-3"));
    expect(decision.mode).toBe("default_priority");
    expect(decision.ranking[0]).toMatchObject({ model: "large:20b" });
    expect(decision.ranking.find((r) => r.model === "small:4b")!.stats).toMatchObject({ verified: 3 });
  });

  it("promotes a model with enough verified correct outcomes over a higher-priority unmeasured one", async () => {
    const t = setup();
    await seedHistory(t, 12, () => true);
    const decision = await t.broker.route(req("after-12"));
    expect(decision.mode).toBe("evidence");
    expect(decision.ranking.map((r) => r.model)).toEqual(["small:4b", "large:20b", "frontier"]);
    expect(decision.ranking[0]!.stats.correctnessLowerBound).toBeGreaterThan(0.6);
    expect(decision.ranking[0]!.stats.latencyP95Ms).toBe(120);
  });

  it("demotes a model that keeps failing verification", async () => {
    const t = setup();
    await seedHistory(t, 12, () => false);
    const decision = await t.broker.route(req("after-12"));
    expect(decision.ranking.at(-1)!.model).toBe("small:4b");
  });

  it("learns from outcomes served through execute once they are verified", async () => {
    const t = setup({ avail: () => availability({ ollama: { models: ["small:4b"] } }) });
    for (let i = 0; i < 6; i += 1) {
      t.clock.ms += 1000;
      const decision = await t.broker.route(req(`live-${i}`, { privacy: "confidential" }));
      const result = await t.broker.execute(decision, async () => okCall(80));
      expect(result.served?.model).toBe("small:4b");
      t.broker.verify(result.served!.outcomeId, true, "tests");
    }
    t.clock.ms += 120_000;
    const decision = await t.broker.route(req("final", { privacy: "confidential" }));
    expect(decision).toMatchObject({ mode: "evidence" });
    expect(decision.ranking[0]!.stats).toMatchObject({ verified: 6, verifiedPassed: 6, latencyP95Ms: 80 });
  });
});

describe("execute: failover", () => {
  it("serves from the best model and records the outcome", async () => {
    const { broker, db } = setup();
    const decision = await broker.route(req("r1"));
    const result = await broker.execute(decision, async () => okCall(250));
    expect(result).toMatchObject({ ok: true, value: "answer", served: { model: "large:20b" } });
    expect(result.attempts).toHaveLength(1);
    expect(db.prepare("SELECT ok, latency_ms FROM model_route_outcomes").all()).toEqual([{ ok: 1, latency_ms: 250 }]);
  });

  it("fails over on a provider failure, skipping the failed provider's other models", async () => {
    const { broker } = setup();
    const decision = await broker.route(req("r1"));
    const seen: string[] = [];
    const result = await broker.execute(decision, async (target) => {
      seen.push(`${target.providerId}/${target.model}`);
      return target.providerId === "ollama" ? provFail : okCall();
    });
    expect(seen).toEqual(["ollama/large:20b", "hosted-a/frontier"]);
    expect(result).toMatchObject({ ok: true, served: { providerId: "hosted-a" } });
    expect(result.attempts.map((a) => a.ok)).toEqual([false, true]);
  });

  it("does not fail over on a request failure", async () => {
    const { broker } = setup();
    const decision = await broker.route(req("r1"));
    let calls = 0;
    const result = await broker.execute(decision, async () => {
      calls += 1;
      return { ok: false, failureKind: "request" } as CallResult<string>;
    });
    expect(calls).toBe(1);
    expect(result).toMatchObject({ ok: false, stoppedBecause: "request_failure" });
  });

  it("treats a thrown error as a provider failure and never stores its message", async () => {
    const { broker, db } = setup();
    const decision = await broker.route(req("r1"));
    const result = await broker.execute(decision, async (target) => {
      if (target.providerId === "ollama") throw new Error("boom: secret prompt text");
      return okCall();
    });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(db.prepare("SELECT * FROM model_route_outcomes").all())).not.toContain("secret prompt");
  });

  it("is bounded by maxAttempts", async () => {
    const t = setup({ policy: { maxAttempts: 1 } });
    const decision = await t.broker.route(req("r1"));
    const result = await t.broker.execute(decision, async () => provFail);
    expect(result).toMatchObject({ ok: false, stoppedBecause: "attempts_exhausted" });
    expect(result.attempts).toHaveLength(1);
  });

  it("reports exhaustion when every provider fails", async () => {
    const { broker } = setup();
    const decision = await broker.route(req("r1"));
    const result = await broker.execute(decision, async () => provFail);
    expect(result).toMatchObject({ ok: false, stoppedBecause: "attempts_exhausted" });
    expect(result.attempts.map((a) => a.providerId)).toEqual(["ollama", "hosted-a"]);
  });

  it("never overwrites earlier evidence when the same decision is executed again", async () => {
    const { broker, db } = setup();
    const decision = await broker.route(req("r1"));
    await broker.execute(decision, async () => provFail);
    await broker.execute(decision, async () => okCall());
    const rows = db.prepare("SELECT attempt, ok FROM model_route_outcomes ORDER BY attempt").all();
    expect(rows).toEqual([
      { attempt: 1, ok: 0 },
      { attempt: 2, ok: 0 },
      { attempt: 3, ok: 1 }
    ]);
  });

  it("opens a provider's circuit after repeated failures, so the next request avoids it, then probes again after the cooldown", async () => {
    const t = setup();
    for (let i = 0; i < 3; i += 1) {
      t.clock.ms += 1000;
      const d = await t.broker.route(req(`f${i}`));
      await t.broker.execute(d, async (target) => (target.providerId === "ollama" ? provFail : okCall()));
    }
    t.clock.ms += 1000;
    const during = await t.broker.route(req("during"));
    expect(during.ranking.map((r) => r.providerId)).toEqual(["hosted-a"]);
    expect(during.rejected.filter((r) => r.providerId === "ollama").every((r) => r.reasons.includes("circuit_open"))).toBe(true);
    t.clock.ms += 120_000;
    const after = await t.broker.route(req("after"));
    expect(after.ranking.some((r) => r.providerId === "ollama")).toBe(true);
    expect(after.ranking.find((r) => r.providerId === "ollama")!.circuit).toBe("half_open");
  });
});

describe("verification", () => {
  it("only accepts a verdict for a real, successful outcome", async () => {
    const { broker } = setup();
    const decision = await broker.route(req("r1"));
    const failed = await broker.execute(decision, async () => provFail);
    expect(() => broker.verify(failed.attempts[0]!.outcomeId, true, "v")).toThrow(/successful/);
    expect(() => broker.verify("f".repeat(64), true, "v")).toThrow(/no such outcome/);
  });
});

describe("resolveRoutingPolicy", () => {
  it("fills defaults and rejects out-of-bounds values", () => {
    expect(resolveRoutingPolicy(undefined)).toEqual(policy());
    for (const bad of [{ maxAttempts: 0 }, { maxAttempts: 6 }, { minSamples: 0 }, { minAcceptableCorrectness: 2 }, { weights: { correctness: -1, latency: 0, cost: 0 } }, { evidenceWindowMs: 0 }, { circuit: { failureThreshold: 0, cooldownMs: 1 } }]) {
      expect(() => resolveRoutingPolicy(bad as never), JSON.stringify(bad)).toThrowError(expect.objectContaining({ code: "model_routing_policy_invalid" }));
    }
  });
});
