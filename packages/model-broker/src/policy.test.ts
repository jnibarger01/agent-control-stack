import { describe, expect, it } from "vitest";
import { GiB, availability, catalog, compute, iso, policy } from "./fixtures.test-support.js";
import { candidateKey, circuitState, percentile, rankModels, wilsonLowerBound } from "./policy.js";
import type { CircuitState, EvidenceStats, RouteRequest } from "./types.js";

const request = (overrides: Partial<RouteRequest> = {}): RouteRequest => ({
  requestId: "r1",
  taskType: "code_generation",
  privacy: "internal",
  ...overrides
});
const stats = (overrides: Partial<EvidenceStats> = {}): EvidenceStats => ({
  attempts: 0,
  providerFailures: 0,
  verified: 0,
  verifiedPassed: 0,
  costReportedFor: 0,
  ...overrides
});
const evidence = (entries: Record<string, { stats?: Partial<EvidenceStats>; circuit?: CircuitState }>) =>
  new Map(
    Object.entries(entries).map(([model, value]) => [
      candidateKey(model.startsWith("frontier") ? "hosted-a" : "ollama", model),
      { stats: stats(value.stats), circuit: value.circuit ?? "closed" }
    ])
  );
const rank = (req: RouteRequest, extra: Partial<Parameters<typeof rankModels>[0]> = {}) =>
  rankModels({ request: req, catalog: catalog(), availability: availability(), compute: compute(), evidence: new Map(), policy: policy(), ...extra });
const reasons = (result: ReturnType<typeof rank>, model: string) => result.rejected.find((r) => r.model === model)?.reasons;

describe("wilsonLowerBound / percentile", () => {
  it("is conservative with few samples and converges with many", () => {
    expect(wilsonLowerBound(5, 5)).toBeLessThan(0.6);
    expect(wilsonLowerBound(500, 500)).toBeGreaterThan(0.99);
    expect(wilsonLowerBound(0, 0)).toBe(0);
    expect(wilsonLowerBound(0, 10)).toBe(0);
  });
  it("computes nearest-rank percentiles", () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([], 50)).toBeUndefined();
  });
});

describe("circuitState", () => {
  const fail = (at: number, kind: "provider" | "request" = "provider") => ({ ok: false, failureKind: kind, recordedAt: iso(at) });
  const ok = (at: number) => ({ ok: true, failureKind: null, recordedAt: iso(at) });
  const p = policy();
  it("opens after N consecutive provider failures inside the cooldown", () => {
    expect(circuitState([fail(-1000), fail(-2000), fail(-3000)], p, new Date(iso()))).toBe("open");
  });
  it("half-opens once the cooldown has elapsed", () => {
    expect(circuitState([fail(-100_000), fail(-110_000), fail(-120_000)], p, new Date(iso()))).toBe("half_open");
  });
  it("a success in the streak keeps it closed", () => {
    expect(circuitState([fail(-1000), ok(-2000), fail(-3000)], p, new Date(iso()))).toBe("closed");
  });
  it("ignores request failures and needs a full streak", () => {
    expect(circuitState([fail(-1000), fail(-2000, "request"), fail(-3000, "request"), ok(-4000)], p, new Date(iso()))).toBe("closed");
    expect(circuitState([fail(-1000), fail(-2000)], p, new Date(iso()))).toBe("closed");
    expect(circuitState([], p, new Date(iso()))).toBe("closed");
  });
});

describe("rankModels: eligibility", () => {
  it("never offers an installed embedding model for code generation", () => {
    const result = rank(request());
    expect(reasons(result, "embed:300m")).toContain("task_unsupported");
    expect(result.ranking.map((r) => r.model)).not.toContain("embed:300m");
  });

  it("rejects what is not installed or not reachable", () => {
    expect(reasons(rank(request(), { availability: availability({ ollama: { models: ["small:4b"] } }) }), "large:20b")).toContain("not_available");
    expect(reasons(rank(request(), { availability: availability({ ollama: { reachable: false } }) }), "small:4b")).toContain("provider_unreachable");
    expect(reasons(rank(request(), { availability: availability({ "hosted-a": { credentialPresent: false } }) }), "frontier")).toContain("not_available");
    expect(reasons(rank(request(), { availability: [] }), "small:4b")).toContain("not_available");
  });

  it("enforces privacy as a hard rule: a hosted model cannot serve confidential data", () => {
    const result = rank(request({ privacy: "confidential" }));
    expect(reasons(result, "frontier")).toContain("privacy_not_allowed");
    expect(result.ranking.every((r) => r.kind === "local")).toBe(true);
  });

  it("evidence never overrides privacy", () => {
    const result = rank(request({ privacy: "restricted" }), {
      evidence: evidence({ frontier: { stats: { correctnessLowerBound: 0.99, verified: 100, verifiedPassed: 100 } } })
    });
    expect(result.ranking.map((r) => r.model)).not.toContain("frontier");
  });

  it("checks the context window and fails closed when it is unknown", () => {
    expect(reasons(rank(request({ requiredContextTokens: 10_000 })), "small:4b")).toContain("context_too_small");
    expect(rank(request({ requiredContextTokens: 10_000 })).ranking.map((r) => r.model)).toContain("large:20b");
    const unknown = rank(request({ requiredContextTokens: 10 }), {
      catalog: catalog().map((e) => (e.model === "small:4b" ? { ...e, contextWindow: undefined } : e))
    });
    expect(reasons(unknown, "small:4b")).toContain("context_window_unknown");
    expect(reasons(rank(request()), "small:4b")).toBeUndefined();
  });

  it("rejects a local model that does not fit in memory, unless it is already loaded", () => {
    const tight = compute({ memory: { totalBytes: 29 * GiB, availableBytes: 8 * GiB } });
    expect(reasons(rank(request(), { compute: tight }), "large:20b")).toContain("insufficient_memory");
    expect(reasons(rank(request(), { compute: tight }), "small:4b")).toBeUndefined();
    const loaded = rank(request(), { compute: tight, availability: availability({ ollama: { loadedModels: ["large:20b"] } }) });
    expect(reasons(loaded, "large:20b")).toBeUndefined();
  });

  it("keeps the memory reserve", () => {
    const edge = compute({ memory: { totalBytes: 29 * GiB, availableBytes: 4 * GiB } });
    expect(reasons(rank(request(), { compute: edge }), "small:4b")).toContain("insufficient_memory");
  });

  it("warns, without rejecting, when a local model declares no memory need", () => {
    const result = rank(request(), { catalog: catalog().map((e) => (e.model === "small:4b" ? { ...e, memoryBytes: undefined } : e)) });
    expect(result.ranking.find((r) => r.model === "small:4b")?.warnings).toEqual(["memory requirement not declared in the catalog"]);
  });

  it("fails closed on a GPU requirement it cannot confirm", () => {
    const gpuCatalog = catalog().map((e) => (e.model === "large:20b" ? { ...e, needsGpu: true, vramBytes: 12 * GiB } : e));
    expect(reasons(rank(request(), { catalog: gpuCatalog }), "large:20b")).toContain("gpu_unconfirmed");
    const none = compute({ gpus: { status: "none", devices: [] } });
    expect(reasons(rank(request(), { catalog: gpuCatalog, compute: none }), "large:20b")).toContain("gpu_unconfirmed");
    const small = compute({ gpus: { status: "present", devices: [{ name: "g", totalBytes: 8 * GiB, freeBytes: 6 * GiB }] } });
    expect(reasons(rank(request(), { catalog: gpuCatalog, compute: small }), "large:20b")).toContain("gpu_unconfirmed");
    const big = compute({ gpus: { status: "present", devices: [{ name: "g", totalBytes: 24 * GiB, freeBytes: 20 * GiB }] } });
    expect(reasons(rank(request(), { catalog: gpuCatalog, compute: big }), "large:20b")).toBeUndefined();
  });

  it("does not trust listed GPU devices unless the host actually answered", () => {
    const gpuCatalog = catalog().map((e) => (e.model === "large:20b" ? { ...e, needsGpu: true, vramBytes: 12 * GiB } : e));
    const inconsistent = compute({ gpus: { status: "unknown", devices: [{ name: "g", totalBytes: 24 * GiB, freeBytes: 20 * GiB }] } });
    expect(reasons(rank(request(), { catalog: gpuCatalog, compute: inconsistent }), "large:20b")).toContain("gpu_unconfirmed");
  });

  it("rejects a provider whose circuit is open and warns on half-open", () => {
    const open = rank(request(), { evidence: evidence({ "small:4b": { circuit: "open" } }) });
    expect(reasons(open, "small:4b")).toContain("circuit_open");
    const half = rank(request(), { evidence: evidence({ "small:4b": { circuit: "half_open" } }) });
    expect(half.ranking.find((r) => r.model === "small:4b")?.warnings[0]).toMatch(/half-open/);
  });

  it("collects every reason a candidate fails", () => {
    const result = rank(request({ privacy: "restricted", requiredContextTokens: 500_000 }), { availability: [] });
    expect(reasons(result, "frontier")).toEqual(expect.arrayContaining(["not_available", "privacy_not_allowed", "context_too_small"]));
  });

  it("returns mode none when nothing is eligible", () => {
    expect(rank(request({ taskType: "telepathy" }))).toMatchObject({ mode: "none", ranking: [] });
  });
});

describe("rankModels: ranking", () => {
  const good = (lb: number, extra: Partial<EvidenceStats> = {}) => ({
    stats: { verified: 20, verifiedPassed: 18, correctnessLowerBound: lb, ...extra }
  });

  it("with no evidence, ranks by catalog priority and says so", () => {
    const result = rank(request());
    expect(result.mode).toBe("default_priority");
    expect(result.ranking.map((r) => r.model)).toEqual(["large:20b", "small:4b", "frontier"]);
    expect(result.ranking.every((r) => r.score === undefined)).toBe(true);
  });

  it("prefers a model whose measured correctness clears the bar over a higher-priority unmeasured one", () => {
    const result = rank(request(), { evidence: evidence({ "small:4b": good(0.9) }) });
    expect(result.mode).toBe("evidence");
    expect(result.ranking[0]!.model).toBe("small:4b");
    expect(result.ranking.map((r) => r.model)).toEqual(["small:4b", "large:20b", "frontier"]);
  });

  it("ranks measured models by score: correctness, then latency and cost penalties", () => {
    const result = rank(request(), {
      evidence: evidence({
        "small:4b": good(0.9, { latencyP95Ms: 1000, meanCostMicroUsd: 0 }),
        "large:20b": good(0.9, { latencyP95Ms: 4000, meanCostMicroUsd: 0 })
      })
    });
    expect(result.ranking.map((r) => r.model).slice(0, 2)).toEqual(["small:4b", "large:20b"]);
    expect(result.ranking[0]!.score!).toBeGreaterThan(result.ranking[1]!.score!);
  });

  it("a clearly more correct model beats a faster one", () => {
    const result = rank(request(), {
      evidence: evidence({ "small:4b": good(0.7, { latencyP95Ms: 100 }), "large:20b": good(0.95, { latencyP95Ms: 5000 }) })
    });
    expect(result.ranking[0]!.model).toBe("large:20b");
  });

  it("puts a measured-but-unacceptable model after the unmeasured ones, as a last resort", () => {
    const result = rank(request(), { evidence: evidence({ "large:20b": good(0.2) }) });
    expect(result.mode).toBe("default_priority");
    expect(result.ranking.map((r) => r.model)).toEqual(["small:4b", "frontier", "large:20b"]);
    const onlyPoor = rank(request(), { catalog: catalog().filter((e) => e.model === "large:20b"), evidence: evidence({ "large:20b": good(0.2) }) });
    expect(onlyPoor.mode).toBe("last_resort");
  });

  it("is deterministic and breaks ties by priority then name", () => {
    const tied = evidence({ "small:4b": good(0.8), "large:20b": good(0.8) });
    const a = rank(request(), { evidence: tied });
    const b = rank(request(), { evidence: tied });
    expect(a).toEqual(b);
    expect(a.ranking[0]!.model).toBe("large:20b");
  });

  it("does not count unreported latency or cost as zero or as a penalty", () => {
    const result = rank(request(), { evidence: evidence({ "small:4b": good(0.9), "large:20b": good(0.9, { latencyP95Ms: 3000 }) }) });
    expect(result.ranking[0]!.model).toBe("small:4b");
  });
});
