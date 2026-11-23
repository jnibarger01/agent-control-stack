import { describe, expect, it } from "vitest";
import { parseFactoryIntent, FACTORY_INTENT_VERSION } from "./plan.js";
import { FACTORY_PLAN_VERSION, FactoryPlanError, factoryPlanDigest, parseFactoryPlan, MAX_PLAN_DEPTH } from "./dag.js";

const MISSION = "factory-" + "a".repeat(48);
const intent = parseFactoryIntent({
  schemaVersion: FACTORY_INTENT_VERSION,
  orderId: "order_001",
  objective: "Implement a bounded endpoint with tests",
  repository: "jnibarger01/agent-control-stack",
  baseSha: "a".repeat(40),
  acceptanceCriteria: ["Healthy fixture returns HTTP 200"],
  permittedPaths: ["apps/gateway/src", "packages/ai-factory"],
  forbiddenPaths: ["apps/gateway/src/secrets"],
  budget: { maxLanes: 2, maxWallClockMs: 1_200_000, maxSpendMicrousd: 0 },
  delivery: { mode: "draft_pr" }
});

type Unit = { unitId: string; title: string; dependsOn: string[]; paths: string[] };
const unit = (unitId: string, dependsOn: string[] = [], paths = ["apps/gateway/src/health"]): Unit => ({
  unitId,
  title: "Work on " + unitId,
  dependsOn,
  paths
});
const plan = (units: Unit[], revision = 1, previousPlanDigest: string | null = null) => ({
  schemaVersion: FACTORY_PLAN_VERSION,
  missionId: MISSION,
  revision,
  previousPlanDigest,
  units
});
const parse = (input: unknown, maxParallel = 2) => parseFactoryPlan(input, { missionId: MISSION, intent, maxParallel });
const reason = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(FactoryPlanError);
    return (error as Error).message;
  }
  throw new Error("expected a FactoryPlanError");
};

describe("AI Factory F3 plan DAG validation", () => {
  it("layers a valid DAG, reports depth and fan-out, and digests deterministically", () => {
    const result = parse(plan([unit("a"), unit("b"), unit("c", ["a", "b"]), unit("d", ["c"])]));
    expect(result.layers).toEqual([["a", "b"], ["c"], ["d"]]);
    expect(result.depth).toBe(3);
    expect(result.maxFanOut).toBe(2);
    expect(result.planDigest).toMatch(/^[a-f0-9]{64}$/u);
    const reordered = parse(plan([unit("d", ["c"]), unit("c", ["b", "a"]), unit("b"), unit("a")]));
    expect(reordered.planDigest).toBe(result.planDigest);
  });

  it("changes the digest on any semantic change, including the lineage pointer", () => {
    const base = parse(plan([unit("a"), unit("b", ["a"])])).planDigest;
    expect(parse(plan([unit("a"), unit("b")])).planDigest).not.toBe(base);
    expect(parse(plan([unit("a"), unit("b", ["a"], ["packages/ai-factory"])])).planDigest).not.toBe(base);
    expect(parse(plan([unit("a"), unit("b", ["a"])], 2, "f".repeat(64))).planDigest).not.toBe(base);
  });

  it("rejects a cycle, a self-dependency and an unknown dependency", () => {
    expect(reason(() => parse(plan([unit("a", ["b"]), unit("b", ["a"])])))).toMatch(/cycle/u);
    expect(reason(() => parse(plan([unit("a", ["a"])])))).toMatch(/itself/u);
    expect(reason(() => parse(plan([unit("a", ["ghost"])])))).toMatch(/unknown dependency/u);
    expect(reason(() => parse(plan([unit("a"), unit("a")])))).toMatch(/duplicate unit/u);
  });

  it("enforces the depth limit exactly at the boundary", () => {
    const chain = (n: number) => Array.from({ length: n }, (_, i) => unit("u" + i, i === 0 ? [] : ["u" + (i - 1)]));
    expect(parse(plan(chain(MAX_PLAN_DEPTH))).depth).toBe(MAX_PLAN_DEPTH);
    expect(reason(() => parse(plan(chain(MAX_PLAN_DEPTH + 1))))).toMatch(/depth/u);
  });

  it("caps per-layer fan-out at mission parallelism exactly at the boundary", () => {
    const wide = (n: number) => Array.from({ length: n }, (_, i) => unit("w" + i));
    expect(parse(plan(wide(2)), 2).maxFanOut).toBe(2);
    expect(reason(() => parse(plan(wide(3)), 2))).toMatch(/parallelism/u);
    expect(reason(() => parse(plan(wide(1)), 0))).toMatch(/parallelism/u);
  });

  it("keeps every unit inside permitted paths, and forbidden paths win on overlap", () => {
    expect(reason(() => parse(plan([unit("a", [], ["apps/worker/src"])])))).toMatch(/outside/u);
    expect(reason(() => parse(plan([unit("a", [], ["apps/gateway/src/secrets/key"])])))).toMatch(/forbidden/u);
    // A parent of the forbidden subtree would reach it.
    expect(reason(() => parse(plan([unit("a", [], ["apps/gateway/src"])])))).toMatch(/forbidden/u);
    expect(reason(() => parse(plan([unit("a", [], ["apps/gateway/src/../secrets"])])))).toMatch(/units\[0\]\.paths/u);
    // A sibling whose name only shares a prefix is not inside the root.
    expect(reason(() => parse(plan([unit("a", [], ["apps/gateway/srcx"])])))).toMatch(/outside/u);
  });

  it("enforces lineage shape: revision 1 has no parent, later revisions need one", () => {
    expect(reason(() => parse(plan([unit("a")], 1, "f".repeat(64))))).toMatch(/previousPlanDigest/u);
    expect(reason(() => parse(plan([unit("a")], 2, null)))).toMatch(/previousPlanDigest/u);
    expect(parse(plan([unit("a")], 2, "f".repeat(64))).plan.revision).toBe(2);
  });

  it("rejects unknown fields, another mission, empty or oversized plans", () => {
    expect(reason(() => parse({ ...plan([unit("a")]), approved: true }))).toMatch(/unknown or missing/u);
    expect(reason(() => parse({ ...plan([unit("a")]), missionId: "factory-" + "b".repeat(48) }))).toMatch(/another mission/u);
    expect(reason(() => parse(plan([])))).toMatch(/list length/u);
    expect(reason(() => parse(plan(Array.from({ length: 65 }, (_, i) => unit("x" + i))), 64))).toMatch(/list length/u);
    expect(reason(() => parse(plan([{ ...unit("a"), kind: "shell" } as Unit])))).toMatch(/unknown or missing/u);
  });

  it("exposes a digest function that matches the parser", () => {
    const result = parse(plan([unit("a")]));
    expect(factoryPlanDigest(result.plan)).toBe(result.planDigest);
  });
});
