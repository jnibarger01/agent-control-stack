import { describe, expect, it } from "vitest";
import type { CriterionRef, Gate, ProbeResult, VerdictInput } from "./domain.js";
import { STALE_AFTER_MS, computeVerdict, isStale, nextActions, normalizeResult } from "./verdict.js";

const trusted = [{ grade: "forge_attested" as const, source: "s", digest: "d" }];
const criteria: CriterionRef[] = [
  { id: "pr_open", kind: "pr_open", required: true },
  { id: "gate", kind: "merge_gate_eligible", required: true },
  { id: "opt", kind: "files_within_scope", required: false }
];
const res = (id: string, state: ProbeResult["state"], extra: Partial<ProbeResult> = {}): ProbeResult => ({
  criterionId: id,
  kind: (criteria.find((c) => c.id === id) as CriterionRef).kind,
  state,
  reasonCodes: [],
  findings: [],
  evidence: trusted,
  ...extra
});
const input = (over: Partial<VerdictInput> = {}): VerdictInput => ({
  criteria,
  gates: [],
  results: [res("pr_open", "satisfied"), res("gate", "satisfied"), res("opt", "satisfied")],
  provenance: "live_github",
  integrityOk: true,
  snapshotStable: true,
  headBound: true,
  prState: "OPEN",
  ...over
});
const gateOf = (gate: Gate["gate"], blockKind: Gate["blockKind"], reasonCode = "x"): Gate => ({
  gate,
  blockKind,
  reasonCode,
  detail: "d"
});

describe("computeVerdict aggregation", () => {
  it("PASS needs every required criterion satisfied by trusted evidence", () => {
    expect(computeVerdict(input())).toMatchObject({ verdict: "PASS", passPreconditions: true });
  });
  it("FAIL when something required is unsatisfied and nothing is satisfied; PARTIAL when mixed", () => {
    expect(
      computeVerdict(input({ results: [res("pr_open", "unsatisfied"), res("gate", "unsatisfied")] })).verdict
    ).toBe("FAIL");
    expect(computeVerdict(input({ results: [res("pr_open", "satisfied"), res("gate", "unsatisfied")] })).verdict).toBe(
      "PARTIAL"
    );
  });
  it("a trusted contradiction is never hidden by an undecided item", () => {
    const v = computeVerdict(
      input({
        results: [res("pr_open", "undecided", { reasonCodes: ["pending_external"] }), res("gate", "unsatisfied")]
      })
    );
    expect(v.verdict).toBe("FAIL");
    expect(v.reasonCodes).toContain("pending_external");
  });
  it("BLOCK with the most severe undecided kind", () => {
    const v = computeVerdict(
      input({
        results: [
          res("pr_open", "undecided", { reasonCodes: ["pending_external"] }),
          res("gate", "undecided", { reasonCodes: ["needs_human"] })
        ]
      })
    );
    expect(v).toMatchObject({ verdict: "BLOCK", blockKind: "needs_human" });
  });
  it("optional criteria never change the verdict but are reported", () => {
    const v = computeVerdict(
      input({ results: [res("pr_open", "satisfied"), res("gate", "satisfied"), res("opt", "unsatisfied")] })
    );
    expect(v.verdict).toBe("PASS");
    expect(v.criteriaSummary.optionalUnsatisfied).toEqual(["opt"]);
  });
  it("a missing result is undecided evidence_unavailable, never satisfied", () => {
    const v = computeVerdict(input({ results: [res("pr_open", "satisfied")] }));
    expect(v).toMatchObject({ verdict: "BLOCK", blockKind: "evidence_unavailable" });
    expect(v.reasonCodes).toContain("probe_missing");
  });
});

describe("gates", () => {
  it("any gate yields BLOCK, never FAIL or PARTIAL, with the most severe kind", () => {
    const v = computeVerdict(
      input({
        results: [res("pr_open", "unsatisfied"), res("gate", "unsatisfied")],
        gates: [
          gateOf("G2", "evidence_unavailable", "pr_read_failed"),
          gateOf("G1", "integrity", "audit_chain_invalid")
        ]
      })
    );
    expect(v).toMatchObject({ verdict: "BLOCK", blockKind: "integrity", passPreconditions: false });
    expect(v.reasonCodes).toEqual(expect.arrayContaining(["pr_read_failed", "audit_chain_invalid"]));
  });
});

describe("untrusted evidence", () => {
  it.each(["simulated", "fixture", "asserted"] as const)("%s evidence can neither satisfy nor contradict", (grade) => {
    const sat = normalizeResult(res("gate", "satisfied", { evidence: [{ grade, source: "s", digest: "d" }] }));
    const uns = normalizeResult(res("gate", "unsatisfied", { evidence: [{ grade, source: "s", digest: "d" }] }));
    expect(sat.state).toBe("undecided");
    expect(uns.state).toBe("undecided");
    expect(sat.findings).toContain("verdict_downgraded_untrusted_evidence");
  });
  it("empty evidence cannot satisfy", () => {
    expect(normalizeResult(res("gate", "satisfied", { evidence: [] })).state).toBe("undecided");
  });
  it("fixture provenance caps the verdict at BLOCK simulated_only", () => {
    const fixture = (state: ProbeResult["state"]) =>
      res("gate", state, { evidence: [{ grade: "fixture", source: "s", digest: "d" }] });
    const v = computeVerdict(
      input({
        provenance: "fixture",
        results: [{ ...fixture("satisfied"), criterionId: "pr_open", kind: "pr_open" }, fixture("satisfied")]
      })
    );
    expect(v).toMatchObject({ verdict: "BLOCK", blockKind: "simulated_only" });
  });
});

describe("PASS preconditions (defence in depth)", () => {
  it.each([
    ["non-live provenance", { provenance: "fixture" as const }],
    ["integrity failure", { integrityOk: false }],
    ["unstable snapshot", { snapshotStable: false }],
    ["head not bound", { headBound: false }],
    ["pull request not open", { prState: "MERGED" as const }]
  ])("%s refuses PASS even if every result is satisfied", (_name, over) => {
    const v = computeVerdict(input(over));
    expect(v.verdict).toBe("BLOCK");
    expect(v.passPreconditions).toBe(false);
  });
  it("a missing readiness floor or no required criteria refuses PASS", () => {
    expect(
      computeVerdict(
        input({
          criteria: [{ id: "opt", kind: "files_within_scope", required: true }],
          results: [res("opt", "satisfied")]
        })
      ).verdict
    ).toBe("BLOCK");
    expect(computeVerdict(input({ criteria: [], results: [] })).verdict).toBe("BLOCK");
  });
});

describe("bounded cross-product", () => {
  const states: ProbeResult["state"][] = ["satisfied", "unsatisfied", "undecided"];
  const grades = ["forge_attested", "acs_observed", "simulated", "fixture", "asserted"] as const;
  const gatesSets: Gate[][] = [[], [gateOf("G2", "evidence_unavailable")]];
  const flags = [true, false];
  it("PASS appears exactly when the explicit conjunction holds; FAIL and PARTIAL never appear with a gate", () => {
    let cases = 0;
    for (const s1 of states)
      for (const s2 of states)
        for (const grade of grades)
          for (const gates of gatesSets)
            for (const live of flags)
              for (const stable of flags)
                for (const bound of flags)
                  for (const floor of flags) {
                    const crit = floor
                      ? criteria
                      : criteria.map((c) => (c.kind === "merge_gate_eligible" ? { ...c, required: false } : c));
                    const ev = [{ grade, source: "s", digest: "d" }];
                    const v = computeVerdict(
                      input({
                        criteria: crit,
                        gates,
                        provenance: live ? "live_github" : "fixture",
                        snapshotStable: stable,
                        headBound: bound,
                        results: [res("pr_open", s1, { evidence: ev }), res("gate", s2, { evidence: ev })]
                      })
                    );
                    const allTrusted = grade === "forge_attested" || grade === "acs_observed";
                    const expectPass =
                      gates.length === 0 &&
                      live &&
                      stable &&
                      bound &&
                      floor &&
                      allTrusted &&
                      s1 === "satisfied" &&
                      s2 === "satisfied";
                    expect(
                      v.verdict === "PASS",
                      JSON.stringify({ s1, s2, grade, gates: gates.length, live, stable, bound, floor })
                    ).toBe(expectPass);
                    if (gates.length > 0) expect(["BLOCK"]).toContain(v.verdict);
                    cases += 1;
                  }
    expect(cases).toBe(3 * 3 * 5 * 2 * 2 * 2 * 2 * 2);
  });
  it("degrading any single input never turns a non-PASS into a PASS, and result order does not matter", () => {
    const base = input({ results: [res("pr_open", "satisfied"), res("gate", "undecided")] });
    expect(computeVerdict(base).verdict).not.toBe("PASS");
    const reversed = input({
      results: [res("gate", "satisfied"), res("pr_open", "satisfied"), res("opt", "satisfied")]
    });
    expect(computeVerdict(reversed)).toEqual(computeVerdict(input()));
  });
});

describe("freshness and next actions", () => {
  it("a PASS older than the stale window is stale", () => {
    expect(isStale(0, STALE_AFTER_MS)).toBe(false);
    expect(isStale(0, STALE_AFTER_MS + 1)).toBe(true);
  });
  it("PASS next actions require a human decision and never suggest merging", () => {
    const [action] = nextActions(computeVerdict(input()));
    expect(action).toMatchObject({ action: "decide_merge_hold", requiresHuman: true });
    expect(
      JSON.stringify(
        nextActions(computeVerdict(input({ results: [res("pr_open", "undecided", { reasonCodes: ["needs_human"] })] })))
      )
    ).not.toMatch(/bypass|weaken|disable/iu);
    expect(
      nextActions(computeVerdict(input({ results: [res("pr_open", "unsatisfied"), res("gate", "unsatisfied")] })))[0]
        ?.action
    ).toBe("review_unsatisfied_criteria");
  });
});
