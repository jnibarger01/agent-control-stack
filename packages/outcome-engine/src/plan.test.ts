import { describe, expect, it } from "vitest";
import { outcomeHash } from "./canonical.js";
import { PlanError, assignExecutor, compilePlan, validatePlan } from "./plan.js";
import { parseCriteria, templatePrProductionReady } from "./criteria.js";
import { READ_ONLY_ACTIONS } from "./domain.js";

describe("compilePlan", () => {
  const criteria = parseCriteria(templatePrProductionReady());
  it("is deterministic and every action is in the closed read-only set", () => {
    const a = compilePlan(criteria);
    const b = compilePlan([...criteria]);
    expect(a).toEqual(b);
    expect(a.steps.every((step) => (READ_ONLY_ACTIONS as readonly string[]).includes(step.action))).toBe(true);
    expect(a.steps.map((s) => s.id)).toEqual([
      "read_pr",
      "verify_chain",
      "probe.pr_open",
      "probe.merge_gate",
      "probe.verification_surface",
      "record"
    ]);
  });
  it("orders probes after the read and the record after every probe", () => {
    const plan = compilePlan(criteria);
    expect(plan.steps.find((s) => s.id === "probe.merge_gate")?.dependsOn).toEqual(["read_pr"]);
    expect(plan.steps.at(-1)?.dependsOn).toContain("probe.pr_open");
  });
  it("has no eligible executor for an unknown kind", () => {
    expect(() => assignExecutor("shell_exec")).toThrow(expect.objectContaining({ code: "no_eligible_executor" }));
  });
});

describe("validatePlan", () => {
  const plan = compilePlan(parseCriteria(templatePrProductionReady()));
  const rehash = (steps: typeof plan.steps) => ({ steps, planHash: outcomeHash("plan", steps) });
  it("rejects a non-read-only action, even with a correct hash", () => {
    const steps = structuredClone(plan.steps);
    (steps[0] as { action: string }).action = "merge_pull_request";
    expect(() => validatePlan(rehash(steps))).toThrow(expect.objectContaining({ code: "plan_action_not_read_only" }));
  });
  it("rejects an unknown probe kind and a tampered executor", () => {
    const steps = structuredClone(plan.steps);
    (steps[2] as { kind: string }).kind = "mystery";
    expect(() => validatePlan(rehash(steps))).toThrow(PlanError);
    const steps2 = structuredClone(plan.steps);
    (steps2[0] as { executor: string }).executor = "shell";
    expect(() => validatePlan(rehash(steps2))).toThrow(expect.objectContaining({ code: "plan_executor_mismatch" }));
  });
  it("rejects cycles, unknown dependencies, duplicates and a stale hash", () => {
    const cyc = structuredClone(plan.steps);
    (cyc[0] as { dependsOn: string[] }).dependsOn = ["record"];
    expect(() => validatePlan(rehash(cyc))).toThrow(expect.objectContaining({ code: "plan_cycle" }));
    const unk = structuredClone(plan.steps);
    (unk[0] as { dependsOn: string[] }).dependsOn = ["ghost"];
    expect(() => validatePlan(rehash(unk))).toThrow(expect.objectContaining({ code: "plan_unknown_dependency" }));
    expect(() => validatePlan(rehash([...plan.steps, plan.steps[0] as never]))).toThrow(
      expect.objectContaining({ code: "plan_duplicate_step" })
    );
    expect(() => validatePlan({ steps: plan.steps, planHash: "0".repeat(64) })).toThrow(
      expect.objectContaining({ code: "plan_hash_mismatch" })
    );
  });
});
