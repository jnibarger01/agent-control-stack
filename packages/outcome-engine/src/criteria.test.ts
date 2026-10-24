import { describe, expect, it } from "vitest";
import {
  CriteriaError,
  assertReadinessFloor,
  hasReadinessFloor,
  parseCriteria,
  templatePrProductionReady
} from "./criteria.js";
import { acceptInputSchema } from "./domain.js";

const floor = [
  { id: "open", kind: "pr_open", required: true },
  { id: "gate", kind: "merge_gate_eligible", required: true }
];

describe("parseCriteria", () => {
  it("accepts the template and applies defaults deterministically", () => {
    const parsed = parseCriteria(templatePrProductionReady());
    expect(parsed.find((c) => c.kind === "merge_gate_eligible")).toMatchObject({ policy: "assessment" });
    expect(parseCriteria(floor)).toEqual(parseCriteria(floor));
  });
  it("rejects unknown kinds, unknown fields and caller-supplied authority, verdict or grade fields", () => {
    expect(() => parseCriteria([...floor, { id: "x", kind: "nope", required: true }])).toThrow(CriteriaError);
    for (const extra of ["verdict", "status", "grade", "actor", "approved", "authority"]) {
      expect(() => parseCriteria([{ ...floor[0], [extra]: "PASS" }, floor[1]])).toThrow(/invalid criterion/u);
    }
  });
  it("rejects the reserved work-item kind with its own code", () => {
    expect(() => parseCriteria([...floor, { id: "w", kind: "acs_work_item_real_success", required: true }])).toThrow(
      expect.objectContaining({ code: "criterion_kind_reserved" })
    );
  });
  it("rejects duplicate ids and a missing or optional readiness floor", () => {
    expect(() => parseCriteria([floor[0], floor[0], floor[1]])).toThrow(
      expect.objectContaining({ code: "criterion_duplicate_id" })
    );
    expect(() => parseCriteria([floor[0]])).toThrow(expect.objectContaining({ code: "readiness_floor_missing" }));
    expect(() => parseCriteria([floor[0], { ...floor[1], required: false }])).toThrow(
      expect.objectContaining({ code: "readiness_floor_missing" })
    );
  });
  it("hasReadinessFloor / assertReadinessFloor agree", () => {
    expect(hasReadinessFloor(floor)).toBe(true);
    expect(hasReadinessFloor([])).toBe(false);
    expect(() => assertReadinessFloor([])).toThrow(CriteriaError);
  });
});

describe("acceptInputSchema", () => {
  const ok = { goal: "get it ready", repository: "o/r", pullRequest: 7 };
  it("applies the evaluation bound and refuses authority-shaped fields", () => {
    expect(acceptInputSchema.parse(ok).maxEvaluations).toBe(100);
    for (const extra of ["verdict", "actor", "requester", "approval", "authority", "status", "grade"]) {
      expect(() => acceptInputSchema.parse({ ...ok, [extra]: "x" })).toThrow();
    }
  });
  it("bounds the goal, the repository shape and the pull request number", () => {
    expect(() => acceptInputSchema.parse({ ...ok, goal: "  " })).toThrow();
    expect(() => acceptInputSchema.parse({ ...ok, goal: "x".repeat(4001) })).toThrow();
    expect(() => acceptInputSchema.parse({ ...ok, repository: "../x" })).toThrow();
    expect(() => acceptInputSchema.parse({ ...ok, pullRequest: 0 })).toThrow();
  });
});
