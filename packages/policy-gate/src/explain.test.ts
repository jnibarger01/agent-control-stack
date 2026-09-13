import { describe, expect, it } from "vitest";
import { explainPolicy } from "./explain.js";

const base = {
  workItemId: "wrk_explain",
  actor: "agent",
  operation: "create" as const,
  requester: "user",
  risk: "low" as const,
  action: { kind: "shell", description: "run", params: {} },
  cwd: "/repo"
};

describe("policy explain", () => {
  it("explains an allow decision with matching rule ids and action hash", () => {
    const result = explainPolicy({
      ...base,
      action: { kind: "fs.read", description: "read source", params: { token: "sk-secretvalue012345678901234567890" } },
      paths: ["src/index.ts"]
    });

    expect(result.decision).toBe("allow");
    expect(result.matchedRules).toContain("allow:read-only");
    expect(result.actionHash).toMatch(/^[a-f0-9]{64}$/i);
    expect(result.reason.length).toBeGreaterThan(0);
    expect(result.context).toMatchObject({
      workItemId: "wrk_explain",
      action: { kind: "fs.read" },
      paths: ["src/index.ts"]
    });
    expect(result.context).not.toHaveProperty("action.params");
    expect(JSON.stringify(result)).not.toMatch(/sk-secretvalue|token/i);
  });

  it("explains a deny decision with matching rule ids", () => {
    const result = explainPolicy({
      ...base,
      action: { kind: "fs.read", description: "read env", params: { password: "hunter2" } },
      paths: [".env"]
    });

    expect(result.decision).toBe("deny");
    expect(result.matchedRules).toContain("deny:credential-path");
    expect(result.actionHash).toMatch(/^[a-f0-9]{64}$/i);
    expect(JSON.stringify(result)).not.toMatch(/hunter2|password/i);
  });

  it("explains a require_approval decision with matching rule ids", () => {
    const result = explainPolicy({
      ...base,
      command: ["npm", "test"],
      action: {
        kind: "shell",
        description: "run tests with secret",
        params: { apiKey: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" }
      }
    });

    expect(result.decision).toBe("require_approval");
    expect(result.matchedRules).toContain("approval:package-script");
    expect(result.requiredApprover).toBe("user");
    expect(result.actionHash).toMatch(/^[a-f0-9]{64}$/i);
    expect(result.context.commandHash).toMatch(/^[a-f0-9]{64}$/i);
    expect(result.context).not.toHaveProperty("command");
    expect(JSON.stringify(result)).not.toMatch(/ghp_|apiKey/i);
    expect(JSON.stringify(result.context)).not.toContain("npm");
  });

  it("is read-only: identical inputs produce identical explains", () => {
    const input = {
      ...base,
      write: true,
      paths: ["src/index.ts"],
      action: { kind: "fs.write", description: "write", params: {} }
    };
    const first = explainPolicy(input);
    const second = explainPolicy(input);
    expect(first).toEqual(second);
    expect(first.decision).toBe("require_approval");
    expect(first.matchedRules).toContain("approval:write");
  });
});
