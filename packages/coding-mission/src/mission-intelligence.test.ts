import { describe, expect, it } from "vitest";
import { previewMissionIntelligence } from "./mission-intelligence.js";

const unit = (unitId: string, dependsOn: string[] = []) => ({
  unitId,
  title: unitId,
  kind: "planning",
  dependsOn,
  payload: { goal: unitId },
  verificationPolicy: "independent",
  requiredCapabilities: ["read"],
  requestedPermissions: [],
  successCriteria: ["result independently verified"]
});
const proposal = (units: Array<Record<string, unknown>>) => ({ objective: "Repair a failing gateway", units });

describe("mission intelligence proposal preview", () => {
  it("builds deterministic dependency stages and a stable hash without authorizing execution", () => {
    const graph = proposal([unit("verify", ["repair"]), unit("diagnose"), unit("repair", ["diagnose"])]);
    const one = previewMissionIntelligence(graph);
    const two = previewMissionIntelligence(proposal([...graph.units].reverse()));
    expect(one.stages.map((stage) => stage.unitIds)).toEqual([["diagnose"], ["repair"], ["verify"]]);
    expect(one.planHash).toEqual(two.planHash);
    expect(one.executionAuthorized).toBe(false);
    expect(one.authorization).toBe("not_evaluated");
    expect(one.units.map((item) => item.unitId)).toEqual(["diagnose", "repair", "verify"]);
  });

  it("groups parallel units deterministically", () => {
    const result = previewMissionIntelligence(proposal([unit("b"), unit("final", ["a", "b"]), unit("a")]));
    expect(result.stages.map((stage) => stage.unitIds)).toEqual([["a", "b"], ["final"]]);
  });

  it.each([
    [proposal([unit("a"), unit("a")]), /duplicate unitId/],
    [proposal([unit("a", ["missing"])]), /missing dependency/],
    [proposal([unit("a", ["a"])]), /cannot depend on itself/],
    [proposal([unit("a", ["b"]), unit("b", ["a"])]), /dependency cycle/],
    [proposal([]), /between 1 and 128/],
    [proposal([unit("a"), ...Array.from({ length: 128 }, (_, i) => unit("u" + i))]), /between 1 and 128/],
    [proposal([{ ...unit("a"), policyDecision: "allow" }]), /unrecognized field policyDecision/],
    [{ ...proposal([unit("a")]), approvalId: "fabricated" }, /unrecognized field approvalId/],
    [proposal([{ ...unit("a"), payload: { goal: "x", grantScope: "root" } }]), /unknown field grantScope/],
    [proposal([{ ...unit("a"), verificationPolicy: "trust_me" }]), /unknown verification policy/],
    [proposal([{ ...unit("a"), successCriteria: [] }]), /no success criteria/],
    [proposal([{ ...unit("a"), dependsOn: ["x", "x"] }]), /duplicate entry/]
  ])("rejects invalid or authority-smuggling proposals", (input, pattern) => {
    expect(() => previewMissionIntelligence(input)).toThrow(pattern);
  });

  it("requires a verification node to depend on its target", () => {
    const verify = { ...unit("verify"), kind: "verification", payload: { targetUnitId: "diagnose" } };
    expect(() => previewMissionIntelligence(proposal([unit("diagnose"), verify]))).toThrow(/must depend/);
    expect(
      previewMissionIntelligence(proposal([unit("diagnose"), { ...verify, dependsOn: ["diagnose"] }])).stages
    ).toHaveLength(2);
  });

  it("copies planner fields so later input mutation cannot rewrite the returned preview", () => {
    const start = proposal([unit("diagnose")]);
    const preview = previewMissionIntelligence(start);
    start.units[0]!.title = "spoofed";
    (start.units[0]!.dependsOn as string[]).push("malicious");
    expect(preview.units[0]!.title).toBe("diagnose");
    expect(preview.units[0]!.dependsOn).toEqual([]);
  });

  it("deep-copies command and workspace payload arrays before computing the plan hash", () => {
    const start = proposal([
      { ...unit("code"), kind: "coding", payload: { files: ["src/safe.ts"] } },
      { ...unit("shell"), kind: "shell", payload: { argv: ["git", "status"] } },
      { ...unit("ui"), kind: "cua", payload: { objective: "inspect", allowedApplications: ["browser"] } }
    ]);
    const result = previewMissionIntelligence(start);
    (start.units[0]!.payload as { files: string[] }).files.push("secret.txt");
    (start.units[1]!.payload as { argv: string[] }).argv.push("--output=secret.txt");
    (start.units[2]!.payload as { allowedApplications: string[] }).allowedApplications.push("terminal");
    expect(result.units.find((x) => x.unitId === "code")?.payload).toEqual({ kind: "coding", files: ["src/safe.ts"] });
    expect(result.units.find((x) => x.unitId === "shell")?.payload).toEqual({ kind: "shell", argv: ["git", "status"] });
    expect(result.units.find((x) => x.unitId === "ui")?.payload).toEqual({
      kind: "cua",
      objective: "inspect",
      allowedApplications: ["browser"]
    });
    expect(result.planHash).not.toBe(previewMissionIntelligence(start).planHash);
  });

  it("orders mixed-case unit IDs by code point rather than environment locale", () => {
    const result = previewMissionIntelligence(proposal([unit("a"), unit("Z"), unit("A"), unit("z")]));
    expect(result.units.map((item) => item.unitId)).toEqual(["A", "Z", "a", "z"]);
  });
});