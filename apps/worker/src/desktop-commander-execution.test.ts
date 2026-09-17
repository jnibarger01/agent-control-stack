import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPolicyEngine, createWorkItemTools } from "@agent-control-stack/policy-gate";
import { SqliteWorkItemStore, type WorkItem } from "@agent-control-stack/work-items";
import type {
  AuthorizedExecutionRequest,
  MachineExecutor,
  MachineExecutionResult
} from "@agent-control-stack/desktop-commander-adapter";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWorkerOnce } from "./index.js";

let dir: string;
let root: string;
let dbPath: string;

class FakeExecutor implements MachineExecutor {
  calls: AuthorizedExecutionRequest[] = [];
  isError = false;
  output = "trusted file contents";
  async listTools() {
    return [];
  }
  async execute(request: AuthorizedExecutionRequest): Promise<MachineExecutionResult> {
    this.calls.push(request);
    const auth = request.authorization;
    const now = new Date();
    return {
      toolName: auth.toolName,
      invocationFingerprint: auth.invocationFingerprint,
      startedAt: now.toISOString(),
      completedAt: new Date(now.getTime() + 5).toISOString(),
      durationMs: 5,
      isError: this.isError,
      output: this.output,
      ...(this.isError ? { error: "tool failed" } : {}),
      truncated: false,
      resultHash: "f".repeat(64),
      omittedBlocks: 0
    };
  }
  async close() {}
}

function approvalActionHash(workItem: WorkItem, actor: string): string {
  const decision = createPolicyEngine().evaluateWorkItem(workItem, actor, "approve")[0];
  if (!decision?.actionHash) throw new Error("no approval action hash");
  return decision.actionHash;
}

interface SeedAction {
  kind: string;
  description: string;
  params: Record<string, unknown>;
}

function readAction(absPath: string): SeedAction {
  return {
    kind: "fs.read",
    description: "inspect a file with desktop commander",
    params: { paths: ["src/index.ts"], tool: "read_file", arguments: { path: absPath } }
  };
}

function writeAction(absPath: string): SeedAction {
  return {
    kind: "fs.write",
    description: "write a file with desktop commander",
    params: { paths: ["src/index.ts"], tool: "write_file", arguments: { path: absPath, content: "new contents" } }
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "acs-dc-exec-"));
  root = realpathSync(dir);
  mkdirSync(join(root, "pkg"));
  writeFileSync(join(root, "pkg", "a.txt"), "on disk");
  dbPath = join(dir, "control.db");
  vi.stubEnv("ACS_EXECUTION_BACKEND", "desktop_commander");
  vi.stubEnv("ACS_DESKTOP_COMMANDER_COMMAND", "node");
  vi.stubEnv("ACS_DESKTOP_COMMANDER_ARGS_JSON", JSON.stringify(["/nonexistent/dc.js"]));
  vi.stubEnv("ACS_DESKTOP_COMMANDER_ALLOWED_ROOTS", root);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function seed(action: SeedAction): { id: string; approvedHash?: string } {
  const store = new SqliteWorkItemStore(dbPath);
  const tools = createWorkItemTools(store, createPolicyEngine());
  try {
    const workItem = tools.create_work_item({
      title: "desktop commander action",
      requester: "user",
      intent: "run one desktop commander tool",
      target: { cwd: "/repo" },
      requestedActions: [action],
      risk: "low"
    });
    if (workItem.status === "needs_approval") {
      const actionHash = approvalActionHash(workItem, "user");
      tools.approve_work_item({ id: workItem.id, approvedBy: "user", reason: "ok", actionHash });
      return { id: workItem.id, approvedHash: actionHash };
    }
    return { id: workItem.id };
  } finally {
    store.close();
  }
}

describe("desktop_commander worker execution - success path", () => {
  it("runs the full authorized lifecycle and persists a non-simulated result + audit chain", async () => {
    const { id } = seed(readAction(join(root, "pkg", "a.txt")));
    const executor = new FakeExecutor();

    const result = await runWorkerOnce({ dbPath, workerId: "dc-worker", machineExecutor: executor });

    expect(result).toMatchObject({ executed: true, executionMode: "desktop_commander", workItemId: id });
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0].authorization.toolName).toBe("read_file");
    expect(executor.calls[0].authorization.normalizedArguments).toEqual({ path: join(root, "pkg", "a.txt") });

    const store = new SqliteWorkItemStore(dbPath);
    try {
      expect(store.get(id)?.status).toBe("succeeded");
      const events = store.readEvents({ limit: 500 }).map((e) => e.name);
      for (const name of [
        "execution.authorization_requested",
        "execution.authorization_granted",
        "execution.started",
        "desktop_commander.tool_called",
        "desktop_commander.tool_succeeded",
        "execution.result_persisted",
        "execution.completed",
        "work_item.succeeded"
      ]) {
        expect(events, name).toContain(name);
      }
      expect(store.verifyAuditChain().ok).toBe(true);

      const resultRef = store.get(id)?.result as { resultId?: string } | undefined;
      const stored = resultRef?.resultId ? store.getExecutionResult(resultRef.resultId) : undefined;
      expect(stored?.simulationMetadata).toMatchObject({
        executionMode: "desktop_commander",
        simulated: false,
        backend: "desktop-commander-mcp",
        toolName: "read_file"
      });
    } finally {
      store.close();
    }
  });

  it("requires approval for a write tool and then executes it", async () => {
    const abs = join(root, "pkg", "a.txt");
    // Seed WITHOUT approving.
    const store0 = new SqliteWorkItemStore(dbPath);
    const tools0 = createWorkItemTools(store0, createPolicyEngine());
    const wi = tools0.create_work_item({
      title: "dc write",
      requester: "user",
      intent: "write via dc",
      target: { cwd: "/repo" },
      requestedActions: [writeAction(abs)],
      risk: "low"
    });
    expect(wi.status).toBe("needs_approval");
    store0.close();

    const executor = new FakeExecutor();
    const notApproved = await runWorkerOnce({ dbPath, workerId: "dc-worker", machineExecutor: executor });
    expect(notApproved).toEqual({ executed: false, reason: "no approved work item" });
    expect(executor.calls).toHaveLength(0);

    // Approve the exact action, then it runs.
    const store1 = new SqliteWorkItemStore(dbPath);
    const tools1 = createWorkItemTools(store1, createPolicyEngine());
    tools1.approve_work_item({
      id: wi.id,
      approvedBy: "user",
      reason: "approved",
      actionHash: approvalActionHash(wi, "user")
    });
    store1.close();

    const approvedRun = await runWorkerOnce({ dbPath, workerId: "dc-worker", machineExecutor: executor });
    expect(approvedRun).toMatchObject({ executed: true, executionMode: "desktop_commander" });
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0].authorization.toolName).toBe("write_file");
    expect(executor.calls[0].authorization.requiresApproval).toBe(true);
    expect(executor.calls[0].authorization.approvalId).toBeDefined();
  });
});

describe("desktop_commander worker execution - denials (Desktop Commander is never called)", () => {
  it("denies when the requested tool is not on the allowlist", async () => {
    seed({
      kind: "fs.read",
      description: "kill",
      params: { paths: ["src/index.ts"], tool: "kill_process", arguments: { pid: 1 } }
    });
    const executor = new FakeExecutor();
    const result = await runWorkerOnce({ dbPath, workerId: "dc-worker", machineExecutor: executor });
    expect(executor.calls).toHaveLength(0);
    expect(result.executed).toBe(false);
    const store = new SqliteWorkItemStore(dbPath);
    try {
      const events = store.readEvents({ limit: 500 }).map((e) => e.name);
      expect(events).toContain("execution.authorization_denied");
      expect(events).not.toContain("desktop_commander.tool_called");
      expect(store.verifyAuditChain().ok).toBe(true);
    } finally {
      store.close();
    }
  });

  it("denies when a path escapes the containment allow root", async () => {
    seed(readAction("/etc/passwd"));
    const executor = new FakeExecutor();
    const result = await runWorkerOnce({ dbPath, workerId: "dc-worker", machineExecutor: executor });
    expect(executor.calls).toHaveLength(0);
    expect(result.executed).toBe(false);
  });

  it("denies a credential path", async () => {
    writeFileSync(join(root, ".env"), "SECRET=x");
    seed(readAction(join(root, ".env")));
    const executor = new FakeExecutor();
    const result = await runWorkerOnce({ dbPath, workerId: "dc-worker", machineExecutor: executor });
    expect(executor.calls).toHaveLength(0);
    expect(result.executed).toBe(false);
  });

  it("denies a forbidden command for start_process", async () => {
    seed({
      kind: "cmd.run",
      description: "danger",
      params: {
        cwd: "/repo",
        command: ["true"],
        tool: "start_process",
        arguments: { command: "rm -rf /", timeout_ms: 1000 }
      }
    });
    const executor = new FakeExecutor();
    const result = await runWorkerOnce({ dbPath, workerId: "dc-worker", machineExecutor: executor });
    expect(executor.calls).toHaveLength(0);
    expect(result.executed).toBe(false);
  });

  it("denies when the plan execution mode is not desktop_commander (backend mismatch)", async () => {
    // A write item's plan is created + admitted at approval time. Seed + approve
    // under the dry_run backend so the plan is locked to dry_run, then run the
    // worker as desktop_commander: it must refuse the backend mismatch.
    vi.stubEnv("ACS_EXECUTION_BACKEND", "dry_run");
    const { id } = seed(writeAction(join(root, "pkg", "a.txt")));
    vi.stubEnv("ACS_EXECUTION_BACKEND", "desktop_commander");

    const executor = new FakeExecutor();
    const result = await runWorkerOnce({
      dbPath,
      workerId: "dc-worker",
      executionBackend: "desktop_commander",
      machineExecutor: executor
    });
    expect(executor.calls).toHaveLength(0);
    expect(result.executed).toBe(false);
    const store = new SqliteWorkItemStore(dbPath);
    try {
      const denied = store.readEvents({ limit: 500 }).find((e) => e.name === "execution.authorization_denied");
      expect(denied?.body?.code).toBe("plan_execution_mode_mismatch");
      expect(store.get(id)?.status).not.toBe("succeeded");
    } finally {
      store.close();
    }
  });

  it("is idempotent on a replayed attempt (no duplicate Desktop Commander call)", async () => {
    seed(readAction(join(root, "pkg", "a.txt")));
    const executor = new FakeExecutor();
    const first = await runWorkerOnce({ dbPath, workerId: "dc-worker", machineExecutor: executor });
    expect(first.executed).toBe(true);
    // A second worker pass finds nothing approved - the item is terminal.
    const second = await runWorkerOnce({ dbPath, workerId: "dc-worker", machineExecutor: executor });
    expect(second).toEqual({ executed: false, reason: "no approved work item" });
    expect(executor.calls).toHaveLength(1);
  });
});
