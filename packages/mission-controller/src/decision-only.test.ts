import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { DecisionReceipt, NimbleDecisionModel } from "@agent-control-stack/decision-engine";
import { reconcileStoredDecision, runDecisionOnlyStep, type IssuedPermit } from "./decision-only.js";

const state = {
  missionId: "mis_123",
  goal: "Deploy gateway release and verify health",
  operations: [
    { id: "op_build", status: "completed", kind: "fs.read", exitCode: 0 },
    { id: "op_deploy", status: "pending", kind: "git.push", dependsOn: ["op_build"] }
  ],
  constraints: { requireHealthCheck: true },
  evidence: ["build:sha256:abc"]
};

const policy = {
  capabilities: ["git:write"],
  actionsThisMission: 1,
  requiresApproval: false,
  approved: true,
  permitId: "permit_921"
};

const model: NimbleDecisionModel = {
  id: "nimble",
  version: "2026-10-02",
  answer: () => ({ answers: [{ id: "next_operation", choice: "op_deploy", confidence: 0.96 }] })
};

const permit: IssuedPermit = {
  permitId: "permit_921",
  operationId: "op_deploy",
  issuer: "execution-admission"
};

describe("decision-only mission step", () => {
  it("persists the receipt and withholds a permit the admission layer has not issued", async () => {
    const receipts: unknown[] = [];
    const result = await runDecisionOnlyStep({
      state,
      model,
      policy,
      createdAt: "2026-10-02T00:00:00.000Z",
      receipts: { append: (receipt) => receipts.push(receipt) },
      permits: { readIssuedPermit: () => null },
      shadow: { jevChoice: "op_build" }
    });
    expect(result.executable).toBe(false);
    expect(result.blockReason).toBe("permit_not_issued");
    expect(result.permit).toBeNull();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      authoritativeModel: "nimble",
      shadowModel: "jev",
      shadowDisagreement: true,
      selectedId: "op_deploy"
    });
  });

  it("returns an already-issued permit without executing", async () => {
    const result = await runDecisionOnlyStep({
      state,
      model,
      policy,
      createdAt: "2026-10-02T00:00:00.000Z",
      receipts: { append: () => undefined },
      permits: {
        readIssuedPermit: (permitId) => (permitId === permit.permitId ? permit : null)
      }
    });
    expect(result).toMatchObject({ executable: false, blockReason: null, permit });
    expect(result.step.status).toBe("ready");
  });

  it("does not turn a stored Nimble receipt into authorization after restart", async () => {
    const receipts: DecisionReceipt[] = [];
    const first = await runDecisionOnlyStep({
      state,
      model,
      policy,
      createdAt: "2026-10-02T00:00:00.000Z",
      receipts: { append: (receipt) => receipts.push(receipt) },
      permits: { readIssuedPermit: () => permit }
    });
    const stored = receipts[0];
    expect(stored).toBeDefined();
    const restarted = reconcileStoredDecision({ receipt: stored!, permit: null });
    expect(restarted).toEqual({ executable: false, handoff: null, reason: "receipt_is_not_authorization" });
    expect(first.executable).toBe(false);
    const rebound = reconcileStoredDecision({ receipt: stored!, permit });
    expect(rebound.executable).toBe(false);
    expect(rebound.handoff).toEqual(permit);
    expect(rebound.reason).toBe("issued_permit_still_required");
  });

  it("does not call admission restore or acquire", () => {
    const source = readFileSync(new URL("./decision-only.ts", import.meta.url), "utf8");
    expect(source).not.toContain("restoreActivePermit");
    expect(source).not.toContain(".acquire(");
    expect(source).not.toContain("execute(");
  });
});
