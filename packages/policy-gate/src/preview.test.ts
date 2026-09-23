import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { ControlStackError } from "@agent-control-stack/shared";
import { createPolicyEngine, createWorkItemTools, previewWorkItemPolicy, SUPPORTED_ACTION_KINDS } from "./index.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function openStore(): SqliteWorkItemStore {
  const dir = mkdtempSync(join(tmpdir(), "acs-policy-preview-"));
  dirs.push(dir);
  return new SqliteWorkItemStore(join(dir, "control.db"));
}

const drafts: Array<{ name: string; input: Record<string, unknown> }> = [
  {
    name: "low-risk read",
    input: {
      title: "Read",
      requester: "user",
      intent: "read a file",
      target: { cwd: "/repo" },
      requestedActions: [{ kind: "fs.read", description: "read", params: { paths: ["README.md"] } }],
      risk: "low"
    }
  },
  {
    name: "write",
    input: {
      title: "Write",
      requester: "user",
      intent: "write a file",
      target: { cwd: "/repo" },
      requestedActions: [{ kind: "fs.write", description: "write", params: { paths: ["notes.md"] } }],
      risk: "medium"
    }
  },
  {
    name: "unknown kind",
    input: {
      title: "Unknown",
      requester: "user",
      intent: "do something odd",
      target: {},
      requestedActions: [{ kind: "teleport", description: "nope", params: {} }],
      risk: "low"
    }
  },
  {
    name: "destructive without rollback checkpoint",
    input: {
      title: "Delete",
      requester: "user",
      intent: "delete a file",
      target: { cwd: "/repo" },
      requestedActions: [{ kind: "fs.delete", description: "delete", params: { paths: ["x"] } }],
      risk: "high"
    }
  },
  {
    name: "prompt dispatch",
    input: {
      title: "Prompt",
      requester: "user",
      intent: "ask an agent",
      target: { services: ["codex-agent"] },
      requestedActions: [{ kind: "agent.prompt", description: "Dispatch prompt", params: {} }],
      risk: "medium"
    }
  }
];

const statusForOutcome = {
  auto_admitted: "approved",
  needs_approval: "needs_approval",
  blocked: "blocked"
} as const;

describe("previewWorkItemPolicy", () => {
  it("covers every outcome across the fixture drafts", () => {
    const outcomes = new Set(drafts.map(({ input }) => previewWorkItemPolicy(createPolicyEngine(), input).outcome));
    expect([...outcomes].sort()).toEqual(["auto_admitted", "blocked", "needs_approval", "rejected"]);
  });

  it.each(drafts)("predicts exactly what create_work_item does: $name", ({ input }) => {
    const store = openStore();
    const policy = createPolicyEngine();
    try {
      const eventsBefore = store.readEvents({ limit: 500 }).length;
      const preview = previewWorkItemPolicy(policy, input);
      expect(store.readEvents({ limit: 500 }).length).toBe(eventsBefore);
      expect(store.list()).toEqual([]);

      const tools = createWorkItemTools(store, policy);
      let created;
      try {
        created = tools.create_work_item(input);
      } catch (error) {
        expect(error).toBeInstanceOf(ControlStackError);
        expect(preview.outcome).toBe("rejected");
        return;
      }
      expect(preview.outcome).not.toBe("rejected");
      expect(created.status).toBe(statusForOutcome[preview.outcome as keyof typeof statusForOutcome]);
      expect(preview.actions.map((action) => action.kind)).toEqual(
        (input.requestedActions as Array<{ kind: string }>).map((action) => action.kind)
      );
    } finally {
      store.close();
    }
  });

  it("denies kinds outside SUPPORTED_ACTION_KINDS and never echoes params", () => {
    const preview = previewWorkItemPolicy(createPolicyEngine(), {
      ...drafts[2]!.input,
      requestedActions: [{ kind: "teleport", description: "nope", params: { secret: "hunter2" } }]
    });
    expect(SUPPORTED_ACTION_KINDS).not.toContain("teleport");
    expect(["blocked", "rejected"]).toContain(preview.outcome);
    expect(JSON.stringify(preview)).not.toContain("hunter2");
  });

  it("rejects malformed drafts with a validation error", () => {
    expect(() => previewWorkItemPolicy(createPolicyEngine(), { title: "" })).toThrow();
  });
});
