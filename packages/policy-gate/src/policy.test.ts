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

  describe("Slice 1: credential and canonical-path hardening", () => {
    it("denies fs.write to a literal credential path, not just reads", () => {
      const result = evaluatePolicy({
        ...base,
        action: { kind: "fs.write", description: "overwrite env", params: {} },
        write: true,
        paths: [".env"]
      });
      expect(result.decision).toBe("deny");
      expect(result.matchedRules).toContain("deny:credential-path");
    });

    it("denies fs.write to an ssh private key", () => {
      const result = evaluatePolicy({
        ...base,
        action: { kind: "fs.write", description: "overwrite key", params: {} },
        write: true,
        paths: ["home/.ssh/id_rsa"]
      });
      expect(result.matchedRules).toContain("deny:credential-path");
    });

    it("denies nested credential paths such as config/.aws/credentials", () => {
      const result = evaluatePolicy({
        ...base,
        action: { kind: "fs.read", description: "read aws creds", params: {} },
        paths: ["config/.aws/credentials"]
      });
      expect(result.matchedRules).toContain("deny:credential-path");
    });

    it("still allows fs.write to a non-credential path", () => {
      const result = evaluatePolicy({
        ...base,
        action: { kind: "fs.write", description: "write source", params: {} },
        write: true,
        paths: ["src/index.ts"]
      });
      expect(result.matchedRules).toContain("approval:write");
      expect(result.matchedRules).not.toContain("deny:credential-path");
    });

    it("still allows fs.read of a non-credential path", () => {
      const result = evaluatePolicy({
        ...base,
        action: { kind: "fs.read", description: "read source", params: {} },
        paths: ["src/index.ts"]
      });
      expect(result.decision).toBe("allow");
    });

    it("denies a symlinked read that canonically resolves onto a credential file", () => {
      const dir = mkdtempSync(join(tmpdir(), "acs-policy-cred-symlink-"));
      const root = join(dir, "root");
      const secrets = join(dir, "secrets");
      mkdirSync(root);
      mkdirSync(secrets);
      writeFileSync(join(secrets, "id_rsa"), "not-a-real-key");
      symlinkSync(join(secrets, "id_rsa"), join(root, "innocuous-name.txt"));

      try {
        const result = evaluatePolicy({
          ...base,
          action: { kind: "fs.read", description: "read via symlink", params: {} },
          cwd: root,
          paths: ["innocuous-name.txt"]
        });
        expect(result.matchedRules).toContain("deny:credential-path");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("denies a symlinked write that canonically resolves onto a credential file", () => {
      const dir = mkdtempSync(join(tmpdir(), "acs-policy-cred-symlink-write-"));
      const root = join(dir, "root");
      const secrets = join(dir, "secrets");
      mkdirSync(root);
      mkdirSync(secrets);
      writeFileSync(join(secrets, ".env"), "SECRET=1");
      symlinkSync(join(secrets, ".env"), join(root, "config.txt"));

      try {
        const result = evaluatePolicy({
          ...base,
          action: { kind: "fs.write", description: "write via symlink", params: {} },
          write: true,
          cwd: root,
          paths: ["config.txt"]
        });
        expect(result.matchedRules).toContain("deny:credential-path");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("denies a write to a not-yet-existing credential path inside an existing directory", () => {
      const dir = mkdtempSync(join(tmpdir(), "acs-policy-cred-new-"));
      const root = join(dir, "root");
      mkdirSync(root);

      try {
        const result = evaluatePolicy({
          ...base,
          action: { kind: "fs.write", description: "create env file", params: {} },
          write: true,
          cwd: root,
          paths: [".env"]
        });
        expect(result.matchedRules).toContain("deny:credential-path");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("unions a move-shaped action's sourcePath into the checked paths and denies a credential source", () => {
      const workItem = createWorkItem({
        title: "Move file",
        requester: "user",
        intent: "relocate a file",
        target: { cwd: "/repo" },
        requestedActions: [
          {
            kind: "fs.move",
            description: "move credential file",
            params: { sourcePath: ".env", destinationPath: "backup/env.bak" }
          }
        ],
        risk: "low"
      });
      const evaluation = evaluateWorkItemPolicy(workItem, "user", "create")[0];
      expect(evaluation?.decision.matchedRules).toContain("deny:credential-path");
    });

    it("unions a move-shaped action's destinationPath into the checked paths and denies a credential destination", () => {
      const workItem = createWorkItem({
        title: "Move file",
        requester: "user",
        intent: "relocate a file",
        target: { cwd: "/repo" },
        requestedActions: [
          {
            kind: "fs.move",
            description: "move file over ssh key",
            params: { sourcePath: "src/index.ts", destinationPath: "home/.ssh/id_ed25519" }
          }
        ],
        risk: "low"
      });
      const evaluation = evaluateWorkItemPolicy(workItem, "user", "create")[0];
      expect(evaluation?.decision.matchedRules).toContain("deny:credential-path");
    });

    it("merges an explicit paths array with named resource paths rather than dropping either", () => {
      const workItem = createWorkItem({
        title: "Multi-path action",
        requester: "user",
        intent: "touch two resources",
        target: { cwd: "/repo" },
        requestedActions: [
          {
            kind: "fs.write",
            description: "write two files",
            params: { write: true, paths: ["src/a.ts"], outputPath: "../outside.txt" }
          }
        ],
        risk: "low"
      });
      const evaluation = evaluateWorkItemPolicy(workItem, "user", "create")[0];
      // The outside path escape must still be caught even though it arrived via a
      // named key rather than the `paths` array, proving both were unioned in.
      expect(evaluation?.decision.matchedRules).toContain("deny:path-escape");
    });

    it("denies a symlink escape reached through a named resource path key", () => {
      const dir = mkdtempSync(join(tmpdir(), "acs-policy-named-symlink-"));
      const root = join(dir, "root");
      const outside = join(dir, "outside");
      mkdirSync(root);
      mkdirSync(outside);
      writeFileSync(join(outside, "secret.txt"), "secret");
      symlinkSync(outside, join(root, "link"), "dir");

      try {
        const workItem = createWorkItem({
          title: "Named path escape",
          requester: "user",
          intent: "touch a resource via a named key",
          target: { cwd: root },
          requestedActions: [
            {
              kind: "fs.write",
              description: "write via named destination",
              params: { write: true, destinationPath: "link/secret.txt" }
            }
          ],
          risk: "low"
        });
        const evaluation = evaluateWorkItemPolicy(workItem, "user", "create")[0];
        expect(evaluation?.decision.matchedRules).toContain("deny:path-escape");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
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
