import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  it("allows prompt dispatch and read-only repo inspection but gates package scripts", () => {
    expect(
      evaluatePolicy({ ...base, action: { kind: "agent.prompt", description: "dispatch prompt", params: {} } }).decision
    ).toBe("allow");
    expect(
      evaluatePolicy({
        ...base,
        action: { kind: "fs.read", description: "read source", params: {} },
        paths: ["src/index.ts"]
      }).decision
    ).toBe("allow");
    expect(evaluatePolicy({ ...base, command: ["git", "status"] }).decision).toBe("allow");
    expect(evaluatePolicy({ ...base, command: ["git", "diff"] }).decision).toBe("allow");
    expect(evaluatePolicy({ ...base, command: ["npm", "test"] }).decision).toBe("require_approval");
    expect(evaluatePolicy({ ...base, command: ["npm", "test"] }).matchedRules).toContain("approval:package-script");
    expect(evaluatePolicy({ ...base, command: ["pnpm", "run", "test"] }).decision).toBe("require_approval");
  });

  it("classifies policy contexts into the connector risk model", () => {
    expect(classifyPolicyRisk({ ...base, action: { kind: "agent.prompt", description: "dispatch", params: {} } }).risk).toBe(
      "safe_mutation"
    );
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

  it("denies shell metacharacters before command allow rules", () => {
    expect(evaluatePolicy({ ...base, command: ["npm", "test", ";", "curl"] }).matchedRules).toContain(
      "deny:shell-metacharacter"
    );
    expect(evaluatePolicy({ ...base, command: ["git", "status", "&&", "whoami"] }).matchedRules).toContain(
      "deny:shell-metacharacter"
    );
  });

  it("denies symlink path escapes under the requested cwd", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-policy-path-"));
    const root = join(dir, "root");
    const outside = join(dir, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(outside, join(root, "link"), "dir");

    try {
      expect(
        evaluatePolicy({
          ...base,
          action: { kind: "fs.read", description: "read through symlink", params: {} },
          cwd: root,
          paths: ["link/secret.txt"]
        }).matchedRules
      ).toContain("deny:path-escape");
      expect(
        evaluatePolicy({
          ...base,
          action: { kind: "fs.read", description: "read source", params: {} },
          cwd: root,
          paths: ["src/index.ts"]
        }).decision
      ).toBe("allow");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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

  it("admits registered connector previews and gates registered mutations", () => {
    expect(
      evaluatePolicy({
        ...base,
        action: { kind: "cmd.preview", description: "preview registered diagnostic", params: { commandId: "os.metadata" } }
      }).decision
    ).toBe("allow");
    expect(
      evaluatePolicy({
        ...base,
        action: { kind: "agent.preview", description: "preview Codex dispatch", params: { agentId: "codex-cli" } }
      }).decision
    ).toBe("allow");
    expect(
      evaluatePolicy({
        ...base,
        action: { kind: "service.restart", description: "restart ACS worker", params: { serviceId: "acs-worker" } }
      }).matchedRules
    ).toContain("approval:service-restart");
    expect(
      evaluatePolicy({
        ...base,
        action: { kind: "config.change", description: "change ACS connector settings", params: { targetId: "acs-connector-settings" } }
      }).matchedRules
    ).toContain("approval:config-change");
  });

  it("requires risk approval and denies high-risk self-approval", () => {
    expect(
      evaluatePolicy({
        ...base,
        action: { kind: "agent.prompt", description: "dispatch high-risk prompt", params: {} },
        risk: "critical"
      }).matchedRules
    ).toContain("approval:risk");
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

  it("binds every agent execution control to the canonical action hash", () => {
    const params = {
      agent: "codex",
      provider: "codex-cli",
      model: "gpt-5-codex",
      prompt: "Inspect the repository and return a report",
      cwd: "/repo",
      permissionMode: "read-only",
      timeoutMs: 30_000,
      networkAccess: "none",
      expectedOutputs: ["report.md"]
    };
    const workItem = createWorkItem({
      title: "Bound agent execution",
      requester: "user",
      intent: "verify execution binding",
      target: { cwd: "/repo" },
      requestedActions: [{ kind: "agent.prompt", description: "run bounded agent", params }],
      risk: "low"
    });
    const baseline = evaluateWorkItemPolicy(workItem, "user", "create")[0]?.actionHash;

    for (const field of ["agent", "provider", "model", "prompt", "cwd", "permissionMode", "timeoutMs", "networkAccess", "expectedOutputs"]) {
      const changedParams = { ...params, [field]: field === "expectedOutputs" ? ["different.md"] : `changed-${field}` };
      const changed = createWorkItem({
        title: "Bound agent execution",
        requester: "user",
        intent: "verify execution binding",
        target: { cwd: "/repo" },
        requestedActions: [{ kind: "agent.prompt", description: "run bounded agent", params: changedParams }],
        risk: "low"
      });
      expect(evaluateWorkItemPolicy(changed, "user", "create")[0]?.actionHash, field).not.toBe(baseline);
    }
  });

  it("canonicalizes agent execution defaults before hashing", () => {
    const baseInput = {
      title: "Defaulted agent execution",
      requester: "user" as const,
      intent: "verify default binding",
      target: { cwd: "/repo" },
      risk: "low" as const
    };
    const implicit = createWorkItem({
      ...baseInput,
      requestedActions: [{
        kind: "agent.prompt",
        description: "run bounded agent",
        params: {
          agent: "codex",
          provider: "codex-cli",
          prompt: "Inspect the repository",
          cwd: "/repo",
          permissionMode: "read-only",
          networkAccess: "none"
        }
      }]
    });
    const explicit = createWorkItem({
      ...baseInput,
      requestedActions: [{
        kind: "agent.prompt",
        description: "run bounded agent",
        params: {
          agent: "codex",
          provider: "codex-cli",
          prompt: "Inspect the repository",
          cwd: "/repo",
          permissionMode: "read-only",
          timeoutMs: 900_000,
          networkAccess: "none",
          expectedOutputs: []
        }
      }]
    });

    expect(evaluateWorkItemPolicy(implicit, "user", "create")[0]?.actionHash).toBe(
      evaluateWorkItemPolicy(explicit, "user", "create")[0]?.actionHash
    );
  });
});
