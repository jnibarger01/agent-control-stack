import { describe, expect, it } from "vitest";
import { FACTORY_INTENT_VERSION, FACTORY_PROPOSAL_VERSION, FactoryIntentError, createFactoryProposal, parseFactoryIntent } from "./plan.js";

function valid(): Record<string, unknown> {
  return {
    schemaVersion: FACTORY_INTENT_VERSION,
    orderId: "factory_001",
    objective: "Implement a bounded endpoint with tests",
    repository: "jnibarger01/agent-control-stack",
    baseSha: "a".repeat(40),
    acceptanceCriteria: ["Healthy fixture returns HTTP 200", "Unauthorized calls return 403"],
    permittedPaths: ["apps/gateway/src", "packages/ai-factory/src"],
    forbiddenPaths: ["apps/gateway/src/credentials"],
    budget: { maxLanes: 2, maxWallClockMs: 1_200_000, maxSpendMicrousd: 2_000_000 },
    delivery: { mode: "draft_pr" }
  };
}

describe("AI Factory F0 proposal contract", () => {
  it("accepts bounded input without issuing authority", () => {
    const p = createFactoryProposal(valid());
    expect(p.schemaVersion).toBe(FACTORY_PROPOSAL_VERSION);
    expect(p.intentHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(p.executionMode).toBe("proposal_only");
    expect(p.authority).toBe("none");
    expect(p.delivery).toBe("draft_pr");
    expect(p).not.toHaveProperty("approvalId");
    expect(p).not.toHaveProperty("leaseId");
  });

  it("is deterministic independently of property insertion order", () => {
    const a = valid();
    expect(createFactoryProposal(a)).toEqual(createFactoryProposal(Object.fromEntries(Object.entries(a).reverse())));
  });

  it("clones nested caller-owned data", () => {
    const a = valid();
    const result = createFactoryProposal(a);
    (a.acceptanceCriteria as string[])[0] = "changed after parse";
    (a.budget as { maxLanes: number }).maxLanes = 8;
    expect(result.intent.acceptanceCriteria[0]).toBe("Healthy fixture returns HTTP 200");
    expect(result.intent.budget.maxLanes).toBe(2);
  });

  it("rejects caller-provided authority fields", () => {
    for (const field of ["actor", "approved", "approvalId", "leaseId", "capability", "allowPush", "autoMerge"]) {
      expect(() => parseFactoryIntent({ ...valid(), [field]: true })).toThrow(FactoryIntentError);
    }
    expect(() => parseFactoryIntent({ ...valid(), delivery: { mode: "draft_pr", approved: true } })).toThrow();
  });

  it("rejects unknown version, missing and nested unknown fields", () => {
    const { baseSha: _sha, ...missing } = valid();
    expect(() => parseFactoryIntent(missing)).toThrow();
    expect(() => parseFactoryIntent({ ...valid(), schemaVersion: "acs.ai-factory.intent.v2" })).toThrow();
    expect(() => parseFactoryIntent({ ...valid(), budget: { maxLanes: 2, maxWallClockMs: 1000, maxSpendMicrousd: 0, grant: true } })).toThrow();
    expect(() => parseFactoryIntent({ ...valid(), delivery: { mode: "merge" } })).toThrow();
  });

  it("rejects untrusted path and repository forms", () => {
    for (const value of ["/etc", "../secrets", "src/../secrets", "src//test", ".git/hooks", "src/.GIT", "C:/Windows", "src\\foo", "src/**", "."]) {
      expect(() => parseFactoryIntent({ ...valid(), permittedPaths: [value] }), value).toThrow();
    }
    expect(() => parseFactoryIntent({ ...valid(), repository: "https://github.com/o/r" })).toThrow();
    expect(() => parseFactoryIntent({ ...valid(), baseSha: "main" })).toThrow();
  });

  it("rejects empty allowlist and duplicate criteria or paths", () => {
    expect(() => parseFactoryIntent({ ...valid(), permittedPaths: [] })).toThrow();
    expect(() => parseFactoryIntent({ ...valid(), permittedPaths: ["src", "src"] })).toThrow();
    expect(() => parseFactoryIntent({ ...valid(), acceptanceCriteria: ["repeat criteria", "repeat criteria"] })).toThrow();
  });

  it("rejects negative, fractional, NaN, infinite and over-cap budgets", () => {
    const b = valid().budget as Record<string, number>;
    for (const [field, invalid] of [
      ["maxLanes", [0, 9, 1.5, NaN, Infinity]],
      ["maxWallClockMs", [0, -1, 1.5, 86_400_001]],
      ["maxSpendMicrousd", [-1, 1.5, Infinity, 1_000_000_001]]
    ] as const) {
      for (const n of invalid) {
        expect(() => parseFactoryIntent({ ...valid(), budget: { ...b, [field]: n } })).toThrow();
      }
    }
  });

  it("rejects null, arrays, control characters and input getters", () => {
    expect(() => parseFactoryIntent(null)).toThrow();
    expect(() => parseFactoryIntent([])).toThrow();
    expect(() => parseFactoryIntent({ ...valid(), objective: "bad\ninput" })).toThrow();
    const x = valid();
    Object.defineProperty(x, "objective", { enumerable: true, get: () => { throw new Error("must not run"); } });
    expect(() => parseFactoryIntent(x)).toThrow(FactoryIntentError);
  });

  it("rejects prototype pollution and inherited fields", () => {
    const polluted = JSON.parse(JSON.stringify(valid()).replace(/}$/, ',"__proto__":{"approved":true}}')) as unknown;
    expect(() => parseFactoryIntent(polluted)).toThrow();
    const inherited = Object.create({ actor: "operator" }) as Record<string, unknown>;
    Object.assign(inherited, valid());
    expect(() => parseFactoryIntent(inherited)).toThrow();
  });

  it("rejects sparse input lists and symbol injection", () => {
    const sparse = new Array(1) as string[];
    expect(() => parseFactoryIntent({ ...valid(), acceptanceCriteria: sparse })).toThrow();
    const injected = valid();
    Object.defineProperty(injected, Symbol("approved"), { value: true });
    expect(() => parseFactoryIntent(injected)).toThrow();
  });
});
