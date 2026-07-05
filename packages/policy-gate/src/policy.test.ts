import { describe, expect, it } from "vitest";
import { evaluatePolicy } from "./policy.js";

const base = {
  workItemId: "wrk_test",
  actor: "agent",
  action: { kind: "command", description: "run", params: {} },
  cwd: "/repo"
};

describe("policy gate", () => {
  it("allows read-only repo inspection and local tests", () => {
    expect(
      evaluatePolicy({
        ...base,
        action: { kind: "read", description: "read source", params: {} },
        paths: ["src/index.ts"]
      }).decision
    ).toBe("allow");
    expect(evaluatePolicy({ ...base, command: ["git", "status"] }).decision).toBe("allow");
    expect(evaluatePolicy({ ...base, command: ["git", "diff"] }).decision).toBe("allow");
    expect(evaluatePolicy({ ...base, command: ["npm", "test"] }).decision).toBe("allow");
  });

  it("denies path escapes, sudo, secrets, destructive commands, and network", () => {
    expect(evaluatePolicy({ ...base, write: true, paths: ["../outside.txt"] }).matchedRules).toContain(
      "deny:path-escape"
    );
    expect(evaluatePolicy({ ...base, command: ["sudo", "systemctl", "restart", "x"] }).matchedRules).toContain(
      "deny:sudo"
    );
    expect(evaluatePolicy({ ...base, action: { kind: "read", description: "env", params: {} }, paths: [".env"] }).matchedRules).toContain(
      "deny:credential-path"
    );
    expect(evaluatePolicy({ ...base, command: ["rm", "-rf", "/"] }).matchedRules).toContain("deny:destructive");
    expect(evaluatePolicy({ ...base, network: true }).matchedRules).toContain("deny:network");
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
        action: { kind: "command", description: "watch", params: { longRunning: true } }
      }).matchedRules
    ).toContain("approval:long-running");
  });

  it("fails closed when no allow rule matches", () => {
    expect(evaluatePolicy(base).matchedRules).toContain("deny:fail-closed");
  });
});
