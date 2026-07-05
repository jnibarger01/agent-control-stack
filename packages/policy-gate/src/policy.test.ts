import { describe, expect, it } from "vitest";
import { createWorkItem } from "@agent-control-stack/work-items";
import { evaluatePolicy, evaluateWorkItemPolicy } from "./policy.js";
import { classifyPolicyRisk } from "./rules.js";

const base = {
  workItemId: "wrk_test",
  actor: "agent",
  operation: "create" as const,
  requester: "user",
  risk: "low" as const,
  action: { kind: "shell", description: "run", params: {} },
  cwd: "/repo"
};

describe("policy gate", () => {
  it("allows read-only repo inspection and local tests", () => {
    expect(
      evaluatePolicy({
        ...base,
        action: { kind: "fs.read", description: "read source", params: {} },
        paths: ["src/index.ts"]
      }).decision
    ).toBe("allow");
    expect(evaluatePolicy({ ...base, command: ["git", "status"] }).decision).toBe("allow");
    expect(evaluatePolicy({ ...base, command: ["git", "diff"] }).decision).toBe("allow");
    expect(evaluatePolicy({ ...base, command: ["npm", "test"] }).decision).toBe("allow");
  });

  it("classifies policy contexts into the connector risk model", () => {
    expect(
      classifyPolicyRisk({
        ...base,
        action: { kind: "fs.read", description: "read source", params: {} },
        paths: ["src/index.ts"]
      }).risk
    ).toBe("read_only");
    expect(classifyPolicyRisk({ ...base, write: true, paths: ["src/index.ts"] }).risk).toBe("requires_approval");
    expect(classifyPolicyRisk({ ...base, command: ["rm", "-rf", "/"] }).risk).toBe("destructive");
    expect(
      classifyPolicyRisk({ ...base, action: { kind: "legacy", description: "unknown", params: {} } }).risk
    ).toBe("forbidden");
  });

  it("denies path escapes, sudo, secrets, destructive commands, and network", () => {
    expect(evaluatePolicy({ ...base, write: true, paths: ["../outside.txt"] }).matchedRules).toContain(
      "deny:path-escape"
    );
    expect(evaluatePolicy({ ...base, command: ["sudo", "systemctl", "restart", "x"] }).matchedRules).toContain(
      "deny:sudo"
    );
    expect(evaluatePolicy({ ...base, action: { kind: "fs.read", description: "env", params: {} }, paths: [".env"] }).matchedRules).toContain(
      "deny:credential-path"
    );
    expect(evaluatePolicy({ ...base, command: ["rm", "-rf", "/"] }).matchedRules).toContain("deny:destructive");
    expect(evaluatePolicy({ ...base, network: true }).matchedRules).toContain("deny:network");
    expect(evaluatePolicy({ ...base, action: { kind: "legacy", description: "unknown", params: {} } }).matchedRules).toContain(
      "deny:unknown-action"
    );
  });

  it("requires approval for writes, package installs, service restarts, git commits, and long commands", () => {
    expect(evaluatePolicy({ ...base, write: true, paths: ["src/index.ts"] }).matchedRules).toContain(
      "approval:write"
    );
    expect(evaluatePolicy({ ...base, command: ["npm", "install", "left-pad"], network: true }).matchedRules).toContain(
      "approval:package-install"
    );
    expect(evaluatePolicy({ ...base, command: ["systemctl", "restart", "app"] }).matchedRules).toContain(
      "approval:service-restart"
    );
    expect(evaluatePolicy({ ...base, command: ["git", "commit", "-m", "x"] }).matchedRules).toContain(
      "approval:git-commit"
    );
    expect(
      evaluatePolicy({
        ...base,
        action: { kind: "shell", description: "watch", params: { longRunning: true } }
      }).matchedRules
    ).toContain("approval:long-running");
  });

  it("requires risk approval and denies high-risk self-approval", () => {
    expect(evaluatePolicy({ ...base, risk: "critical" }).matchedRules).toContain("approval:risk");
    expect(
      evaluatePolicy({ ...base, operation: "approve", requester: "agent", risk: "critical" }).matchedRules
    ).toContain("deny:self-approval");
  });

  it("fails closed when no allow rule matches", () => {
    expect(evaluatePolicy(base).matchedRules).toContain("deny:fail-closed");
  });

  it("denies read requests without explicit paths", () => {
    expect(
      evaluatePolicy({
        ...base,
        action: { kind: "fs.read", description: "read unspecified", params: {} }
      }).matchedRules
    ).toContain("deny:fail-closed");
  });

  it("normalizes legacy action kinds before evaluating policy", () => {
    const workItem = createWorkItem({
      title: "Legacy read",
      requester: "user",
      intent: "support durable pre-rename actions",
      target: { cwd: "/repo" },
      requestedActions: [{ kind: "read", description: "read source", params: { paths: ["src/index.ts"] } }],
      risk: "low"
    });
    const evaluation = evaluateWorkItemPolicy(workItem, "user", "create")[0];

    expect(evaluation?.decision.decision).toBe("allow");
    expect(evaluation?.context.action.kind).toBe("fs.read");
  });

  it("keeps action hashes stable across lifecycle actors", () => {
    const workItem = createWorkItem({
      title: "Write source",
      requester: "user",
      intent: "update source file",
      target: { cwd: "/repo" },
      requestedActions: [{ kind: "fs.write", description: "write", params: { paths: ["src/index.ts"] } }],
      risk: "low"
    });

    const hashes = [
      evaluateWorkItemPolicy(workItem, "user", "create")[0]?.actionHash,
      evaluateWorkItemPolicy(workItem, "approver", "approve")[0]?.actionHash,
      evaluateWorkItemPolicy(workItem, "worker-a", "claim")[0]?.actionHash
    ];
    const renamed = createWorkItem({
      title: "Write source",
      requester: "user",
      intent: "update source file",
      target: { cwd: "/repo" },
      requestedActions: [{ kind: "fs.write", description: "different wording", params: { paths: ["src/index.ts"] } }],
      risk: "low"
    });
    const higherRisk = createWorkItem({
      title: "Write source",
      requester: "user",
      intent: "update source file",
      target: { cwd: "/repo" },
      requestedActions: [{ kind: "fs.write", description: "write", params: { paths: ["src/index.ts"] } }],
      risk: "high"
    });

    expect(new Set(hashes).size).toBe(1);
    expect(evaluateWorkItemPolicy(renamed, "user", "create")[0]?.actionHash).not.toBe(hashes[0]);
    expect(evaluateWorkItemPolicy(higherRisk, "user", "create")[0]?.actionHash).not.toBe(hashes[0]);
  });
});
