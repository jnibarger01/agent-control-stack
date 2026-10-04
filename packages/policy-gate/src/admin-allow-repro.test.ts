/**
 * Narrowest reproduction of the live ChatGPT/Jace Commander denial:
 * "ACS denied this tool call: all actions allowed".
 *
 * Root cause: the admin-mode auto-authorization block in the JC/DC capability
 * issuance handlers treats "policy returned NO require_approval evaluations"
 * as a failure. But a require_approval-free evaluation is exactly the
 * success case: policy already allowed the action. So:
 *   adminEvaluations = [allow]  -> adminRequired = []  -> adminActionHash = undefined
 *   -> `!adminActionHash` is TRUE -> 403 deny with reason
 *      policy.summarize(adminEvaluations).reason === "all actions allowed".
 *
 * That is literally the contradictory message: the reason string is produced
 * only by summarizePolicy's ALLOW branch (policy.ts), yet it is returned on a
 * deny path.
 */
import { describe, expect, it } from "vitest";
import { ACS_ADMIN_APPROVER } from "./execution-mode.js";
import { evaluatePolicy, summarizePolicy } from "./policy.js";
import { actionFingerprint } from "./fingerprint.js";
import type { PolicyContext, PolicyEvaluation } from "./policy.js";

function evaluationSet(): PolicyEvaluation[] {
  const context = jcContext("jc.integration.read");
  return [
    {
      action: context.action,
      actionHash: actionFingerprint(context),
      context,
      decision: evaluatePolicy(context)
    }
  ];
}

function jcContext(kind: string, overrides: Partial<PolicyContext> = {}): PolicyContext {
  return {
    workItemId: "wrk_repro",
    actor: ACS_ADMIN_APPROVER,
    operation: "approve",
    requester: "agent",
    requesterSubject: "chatgpt:repro",
    risk: "low",
    action: { kind, description: `Jace Commander tool ${kind}`, params: {} },
    cwd: "/home/jacen/projects/agent-control-stack",
    ...overrides
  } as PolicyContext;
}

describe("REPRO: admin mode must not deny with reason 'all actions allowed'", () => {
  it("a read-only JC tool evaluates to allow under the admin approver", () => {
    const decision = evaluatePolicy(jcContext("jc.integration.read"));
    expect(decision.decision).toBe("allow");
  });

  it("summarize() over an all-allow set yields the string 'all actions allowed'", () => {
    const evaluations = evaluationSet();
    const summary = summarizePolicy(evaluations);
    expect(summary.decision).toBe("allow");
    expect(summary.reason).toBe("all actions allowed");
  });

  it("an allow-everything result yields no require_approval evaluation at all", () => {
    // This is the input shape the bug hinged on: a policy "allow" means there is no
    // approval record to create. The handler must classify this as success, not infer
    // failure from the missing actionHash.
    const adminEvaluations = evaluationSet();
    const adminRequired = adminEvaluations.filter(
      (evaluation) => evaluation.decision.decision === "require_approval"
    );

    expect(adminRequired).toHaveLength(0);
    expect(adminRequired[0]?.actionHash).toBeUndefined();
    expect(summarizePolicy(adminEvaluations).decision).toBe("allow");
  });

  it("still produces require_approval for privileged.exec under the admin approver", () => {
    // Guards the other side: admin mode still goes through the approval-record path
    // where policy demands one, so the allow case is not a blanket bypass.
    const decision = evaluatePolicy(jcContext("privileged.exec", { risk: "low" }));
    expect(decision.decision).toBe("require_approval");
    expect(decision.matchedRules).toEqual(["approval:privileged-exec"]);
  });

  it("still denies a policy denial under the admin approver", () => {
    // sudo stays denied even in admin mode: admin authorization is not a policy bypass.
    const decision = evaluatePolicy(jcContext("cmd.run", { command: ["sudo", "apt-get", "update"] }));
    expect(decision.decision).toBe("deny");
    expect(decision.matchedRules).toEqual(["deny:sudo"]);
  });
});