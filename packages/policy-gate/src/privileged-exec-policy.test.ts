import { describe, expect, it } from "vitest";
import { evaluatePolicy } from "./policy.js";
import { ACS_ADMIN_APPROVER } from "./execution-mode.js";

const privileged = {
  workItemId: "wrk_priv",
  actor: "acs-jc-bridge",
  operation: "approve" as const,
  requester: "agent",
  risk: "low" as const,
  action: { kind: "privileged.exec", description: "Jace Commander tool privileged_exec", params: {} }
};

describe("privileged.exec (Jace Commander acs.jc.v1)", () => {
  it("always requires human approval, whatever the declared risk or flags", () => {
    for (const risk of ["low", "medium", "high", "critical"] as const) {
      const decision = evaluatePolicy({ ...privileged, risk, write: true, network: false });
      expect(decision.decision).toBe("require_approval");
      expect(decision.matchedRules).toEqual(["approval:privileged-exec"]);
    }
    // Flags that would otherwise short-circuit to allow/deny do not change the outcome.
    expect(evaluatePolicy({ ...privileged, operation: "create", write: false }).decision).toBe("require_approval");
  });

  it("denies approval by the ACS admin auto-approver", () => {
    const decision = evaluatePolicy({ ...privileged, actor: ACS_ADMIN_APPROVER });
    expect(decision.decision).toBe("deny");
    expect(decision.matchedRules).toEqual(["deny:privileged-admin-approval"]);
  });

  it("denies self-approval regardless of risk level", () => {
    const decision = evaluatePolicy({ ...privileged, actor: "agent", risk: "low" });
    expect(decision.decision).toBe("deny");
    expect(decision.matchedRules).toEqual(["deny:self-approval"]);
  });

  it("does not open sudo for ordinary command actions", () => {
    const decision = evaluatePolicy({
      ...privileged,
      operation: "create",
      action: { kind: "cmd.run", description: "run", params: {} },
      command: ["sudo", "apt-get", "update"],
      cwd: "/repo"
    });
    expect(decision.decision).toBe("deny");
    expect(decision.matchedRules).toEqual(["deny:sudo"]);
  });

  it("allows Jace Commander read views and mission submission, but not destructive variants", () => {
    const read = { ...privileged, operation: "create" as const };
    expect(
      evaluatePolicy({ ...read, action: { kind: "jc.integration.read", description: "r", params: {} } }).decision
    ).toBe("allow");
    expect(evaluatePolicy({ ...read, action: { kind: "jc.fs.read", description: "r", params: {} } }).decision).toBe(
      "allow"
    );
    expect(
      evaluatePolicy({ ...read, action: { kind: "jc.integration.write", description: "w", params: {} } }).decision
    ).toBe("allow");
    expect(
      evaluatePolicy({
        ...read,
        destructive: true,
        action: { kind: "jc.integration.read", description: "r", params: {} }
      }).decision
    ).not.toBe("allow");
  });
});
