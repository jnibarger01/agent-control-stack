import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertGoalEvidence, type GoalEvidence } from "./goal-evidence.js";

const evidencePath = new URL("../runs/2026-07-09-goal-policy-action-classification.json", import.meta.url);

function load(): unknown {
  return JSON.parse(readFileSync(evidencePath, "utf8"));
}

describe("real /goal evidence", () => {
  it("validates raw same-session receipts and their evaluator-clear projection", () => {
    const value = load();
    assertGoalEvidence(value);
    const evidence: GoalEvidence = value;

    expect(evidence.result.output).toBe("action: read\nrisk: low");
    expect(evidence.rawReceipts.initial.envelope.session_id).toBe(evidence.sessionId);
    expect(evidence.rawReceipts.status.envelope.session_id).toBe(evidence.sessionId);
    expect(evidence.proof.manualClearIssued).toBe(false);
    expect(evidence.statusQuery.output).toBe("No goal set. Usage: `/goal <condition>`");
  });

  it("rejects matching fabricated normalized session IDs that are not in the raw envelopes", () => {
    const value = load() as GoalEvidence;
    value.sessionId = "00000000-0000-4000-8000-000000000000";
    value.statusQuery.sessionId = value.sessionId;
    expect(() => assertGoalEvidence(value)).toThrow("session");
  });

  it("rejects raw-envelope tampering through the receipt hash", () => {
    const value = load() as GoalEvidence;
    value.rawReceipts.status.envelope.result = "Goal active";
    expect(() => assertGoalEvidence(value)).toThrow("envelopeSha256");
  });
});
