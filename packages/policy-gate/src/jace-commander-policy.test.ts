import { describe, expect, it } from "vitest";
import { ACS_ADMIN_APPROVER } from "./execution-mode.js";
import { evaluatePolicy } from "./policy.js";
import { JACE_COMMANDER_POLICY_ACTION_KINDS, SUPPORTED_ACTION_KINDS } from "./rules.js";

const privileged = {
  workItemId: "wrk_jc",
  actor: "acs-jc-bridge",
  operation: "approve" as const,
  requester: "agent",
  risk: "critical" as const,
  action: {
    kind: "jc.privileged_exec",
    description: "Jace Commander tool privileged_exec",
    params: { tool: "privileged_exec", requesterSubject: "chatgpt:jacen" }
  }
};

describe("Jace Commander policy", () => {
  it("always requires approval for privileged_exec, at every operation and risk", () => {
    for (const operation of ["create", "approve", "claim", "unblock"] as const) {
      for (const risk of ["low", "medium", "high", "critical"] as const) {
        const decision = evaluatePolicy({ ...privileged, operation, risk, actor: "user" });
        expect(decision.decision, `${operation}/${risk}`).toBe("require_approval");
        expect(decision.matchedRules).toEqual(["approval:jc-privileged-exec"]);
      }
    }
  });

  it("denies self-approval by the requester subject and admin auto-approval", () => {
    expect(evaluatePolicy({ ...privileged, actor: "chatgpt:jacen" }).matchedRules).toEqual([
      "deny:jc-privileged-self-approval"
    ]);
    expect(evaluatePolicy({ ...privileged, actor: "agent" }).decision).toBe("deny");
    expect(evaluatePolicy({ ...privileged, actor: ACS_ADMIN_APPROVER }).matchedRules).toEqual([
      "deny:jc-privileged-auto-approval"
    ]);
    expect(evaluatePolicy({ ...privileged, actor: "user" }).decision).toBe("require_approval");
  });

  it("keeps sudo forbidden for ordinary Desktop Commander commands", () => {
    for (const kind of ["cmd.run", "shell"]) {
      const decision = evaluatePolicy({
        ...privileged,
        operation: "create",
        risk: "low",
        action: { kind, description: "run", params: {} },
        command: ["sudo", "apt-get", "update"],
        cwd: "/repo"
      });
      expect(decision.decision).toBe("deny");
      expect(decision.matchedRules).toContain("deny:sudo");
    }
  });

  it("allows low-risk integration reads/writes and denies them at high risk", () => {
    const read = { ...privileged, operation: "create" as const, risk: "low" as const };
    expect(evaluatePolicy({ ...read, action: { kind: "jc.read", description: "r", params: {} } }).decision).toBe(
      "allow"
    );
    expect(
      evaluatePolicy({ ...read, risk: "medium", action: { kind: "jc.write", description: "w", params: {} } }).decision
    ).toBe("allow");
    expect(
      evaluatePolicy({ ...read, risk: "high", action: { kind: "jc.read", description: "r", params: {} } }).decision
    ).toBe("deny");
  });

  it("does not offer Jace Commander kinds to the Mission Control composer", () => {
    for (const kind of JACE_COMMANDER_POLICY_ACTION_KINDS) {
      expect(SUPPORTED_ACTION_KINDS).not.toContain(kind);
    }
  });
});
