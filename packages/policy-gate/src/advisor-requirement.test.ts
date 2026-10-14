import { describe, expect, it } from "vitest";
import { decideAdvisorRequirement } from "./advisor-requirement.js";

describe("decideAdvisorRequirement", () => {
  it("never returns an authorization effect", () => {
    const effects = [
      decideAdvisorRequirement("not_required", "completed"),
      decideAdvisorRequirement("required", "completed"),
      decideAdvisorRequirement("required", "timeout")
    ].map((decision) => decision.effect);
    expect(effects).toEqual(["not_applicable", "evidence_only", "fail_closed"]);
    expect(effects).not.toContain("allow");
  });
});
