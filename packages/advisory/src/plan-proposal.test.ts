import { describe, expect, it } from "vitest";
import {
  createPlanProposal,
  planProposalHash,
  planProposalSchema,
  verifyPlanProposalHash
} from "./plan-proposal.js";

const baseInput = {
  workItemId: "wrk_1",
  principalId: "chatgpt-planner",
  principalRole: "ADVISORY_REASONER" as const,
  goal: "add a null check to the parser",
  actions: [{ kind: "fs.write", description: "edit src/parse.ts", params: { path: "src/parse.ts" } }],
  now: new Date("2026-08-30T00:00:00.000Z")
};

describe("PlanProposal", () => {
  it("is content-addressed and tamper-evident", () => {
    const proposal = createPlanProposal(baseInput);
    expect(proposal.schemaVersion).toBe("acs.plan-proposal.v1");
    expect(proposal.proposalHash).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyPlanProposalHash(proposal)).toBe(true);

    const tampered = { ...proposal, goal: "delete the parser" };
    expect(verifyPlanProposalHash(tampered)).toBe(false);
  });

  it("changing any material field changes the hash", () => {
    const a = createPlanProposal(baseInput);
    const b = createPlanProposal({ ...baseInput, goal: "add two null checks" });
    const c = createPlanProposal({
      ...baseInput,
      actions: [{ kind: "fs.write", description: "edit src/parse.ts", params: { path: "src/other.ts" } }]
    });
    expect(new Set([a.proposalHash, b.proposalHash, c.proposalHash]).size).toBe(3);
  });

  it("only an ADVISORY_REASONER may author a proposal", () => {
    expect(() => createPlanProposal({ ...baseInput, principalRole: "CONTROL_AUTHORITY" })).toThrow(
      /ADVISORY_REASONER/
    );
    expect(() => createPlanProposal({ ...baseInput, principalRole: "EXECUTION_PRINCIPAL" })).toThrow();
  });

  it("is a pure data contract with no authority methods", () => {
    const proposal = createPlanProposal(baseInput);
    // The artifact cannot admit, approve, execute, or transition anything.
    for (const forbidden of ["admit", "approve", "execute", "transition", "succeed", "authorize"]) {
      expect(forbidden in proposal).toBe(false);
    }
  });

  it("rejects unknown keys (strict schema)", () => {
    const proposal = createPlanProposal(baseInput);
    expect(planProposalSchema.safeParse({ ...proposal, surprise: 1 }).success).toBe(false);
  });

  it("recomputed hash matches the documented domain", () => {
    const proposal = createPlanProposal(baseInput);
    const { proposalHash: _h, ...rest } = proposal;
    expect(planProposalHash(rest)).toBe(proposal.proposalHash);
  });
});
