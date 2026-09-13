import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPolicyEngine, createWorkItemTools } from "@agent-control-stack/policy-gate";
import {
  getHostBootId,
  getProcessStartTicks,
  type AuthorizedExecutionRequest,
  type MachineExecutionResult,
  type MachineExecutor
} from "@agent-control-stack/desktop-commander-adapter";
import { SqliteWorkItemStore, type WorkItem } from "@agent-control-stack/work-items";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runWorkerOnce } from "./index.js";

/**
 * ADR 0016 Slice 5 - wiring the Slice 4 process-session ownership primitive
 * into the actual worker execution path for read_process_output and
 * start_process. Mirrors the fixture pattern already established in
 * desktop-commander-execution.test.ts.
 */

let dir: string;
let root: string;
let dbPath: string;
const via = { via: "domain_service" as const };
const FAKE_ACTION_HASH = "a".repeat(64);

class FakeExecutor implements MachineExecutor {
  calls: AuthorizedExecutionRequest[] = [];
  isError = false;
  output = "trusted output";
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

function readProcessOutputAction(pid: number): SeedAction {
  return {
    kind: "fs.write",
    description: "read desktop commander process output",
    params: { tool: "read_process_output", arguments: { pid } }
  };
}

function startProcessAction(): SeedAction {
  return {
    kind: "fs.write",
    description: "start a desktop commander process",
    params: { tool: "start_process", arguments: { command: "git status", cwd: root, timeout_ms: 5000 } }
  };
}

function seed(action: SeedAction): { id: string } {
  const store = new SqliteWorkItemStore(dbPath);
  const tools = createWorkItemTools(store, createPolicyEngine());
  try {
    const workItem = tools.create_work_item({
      title: "process-session wiring",
      requester: "user",
      intent: "exercise process-session ownership wiring",
      target: { cwd: "/repo" },
      requestedActions: [action],
      risk: "low"
    });
    if (workItem.status === "needs_approval") {
      const actionHash = approvalActionHash(workItem, "user");
      tools.approve_work_item({ id: workItem.id, approvedBy: "user", reason: "ok", actionHash });
    }
    return { id: workItem.id };
  } finally {
    store.close();
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "acs-dc-process-session-"));
  root = realpathSync(dir);
  mkdirSync(join(root, "pkg"));
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

describe("ADR-0016 Slice 5: read_process_output is gated on process-session ownership", () => {
  it("allows the call when the work item owns the exact live process identity", async () => {
    const { id } = seed(readProcessOutputAction(process.pid));
    const store = new SqliteWorkItemStore(dbPath);
    store.createProcessSession(
      {
        workItemId: id,
        actionHash: FAKE_ACTION_HASH,
        workerId: "dc-worker",
        pid: process.pid,
        bootId: getHostBootId(),
        procStartTicks: getProcessStartTicks(process.pid)
      },
      via
    );
    store.close();

    const executor = new FakeExecutor();
    const result = await runWorkerOnce({ dbPath, workerId: "dc-worker", machineExecutor: executor });

    expect(result).toMatchObject({ executed: true, workItemId: id });
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0].authorization.toolName).toBe("read_process_output");
  });

  it("denies the call when a different work item owns the session for that pid", async () => {
    // A foreign work item, created directly through the store (never
    // approved, never claimable) so it can never be the item runWorkerOnce
    // picks up - only used to legitimately own the session for this pid.
    const foreignStore = new SqliteWorkItemStore(dbPath);
    const foreign = foreignStore.create({
      title: "foreign owner",
      requester: "user",
      intent: "unrelated process owner",
      target: { cwd: "/repo" },
      requestedActions: [{ kind: "manual", description: "unrelated" }],
      risk: "low"
    });
    foreignStore.createProcessSession(
      {
        workItemId: foreign.id,
        actionHash: FAKE_ACTION_HASH,
        workerId: "dc-worker",
        pid: process.pid,
        bootId: getHostBootId(),
        procStartTicks: getProcessStartTicks(process.pid)
      },
      via
    );
    foreignStore.close();

    const { id } = seed(readProcessOutputAction(process.pid));

    const executor = new FakeExecutor();
    const result = await runWorkerOnce({ dbPath, workerId: "dc-worker", machineExecutor: executor });

    expect(executor.calls).toHaveLength(0);
    expect(result.executed).toBe(false);
    const verify = new SqliteWorkItemStore(dbPath);
    try {
      const denied = verify.readEvents({ limit: 500 }).find((e) => e.name === "execution.authorization_denied");
      expect(denied?.body?.code).toBe("process_ownership_denied");
      expect(verify.get(id)?.status).not.toBe("succeeded");
    } finally {
      verify.close();
    }
  });

  it("denies the call when there is no process session at all for that pid", async () => {
    const { id } = seed(readProcessOutputAction(process.pid));

    const executor = new FakeExecutor();
    const result = await runWorkerOnce({ dbPath, workerId: "dc-worker", machineExecutor: executor });

    expect(executor.calls).toHaveLength(0);
    expect(result.executed).toBe(false);
    const store = new SqliteWorkItemStore(dbPath);
    try {
      const denied = store.readEvents({ limit: 500 }).find((e) => e.name === "execution.authorization_denied");
      expect(denied?.body?.code).toBe("process_ownership_denied");
      expect(store.get(id)?.status).not.toBe("succeeded");
    } finally {
      store.close();
    }
  });

  it("denies the call when the pid was reused (recorded proc_start_ticks no longer matches)", async () => {
    const { id } = seed(readProcessOutputAction(process.pid));
    const store = new SqliteWorkItemStore(dbPath);
    store.createProcessSession(
      {
        workItemId: id,
        actionHash: FAKE_ACTION_HASH,
        workerId: "dc-worker",
        pid: process.pid,
        bootId: getHostBootId(),
        // A different process now holds this pid.
        procStartTicks: getProcessStartTicks(process.pid) + 999_999
      },
      via
    );
    store.close();

    const executor = new FakeExecutor();
    const result = await runWorkerOnce({ dbPath, workerId: "dc-worker", machineExecutor: executor });

    expect(executor.calls).toHaveLength(0);
    expect(result.executed).toBe(false);
  });

  it("denies the call when the recorded boot id no longer matches the live host", async () => {
    const { id } = seed(readProcessOutputAction(process.pid));
    const store = new SqliteWorkItemStore(dbPath);
    store.createProcessSession(
      {
        workItemId: id,
        actionHash: FAKE_ACTION_HASH,
        workerId: "dc-worker",
        pid: process.pid,
        bootId: "a-different-boot-id",
        procStartTicks: getProcessStartTicks(process.pid)
      },
      via
    );
    store.close();

    const executor = new FakeExecutor();
    const result = await runWorkerOnce({ dbPath, workerId: "dc-worker", machineExecutor: executor });

    expect(executor.calls).toHaveLength(0);
    expect(result.executed).toBe(false);
  });

  it("denies rather than throws when the pid cannot be resolved on the live host", async () => {
    // A pid far outside any realistic live range - resolveCurrentProcessIdentity
    // must fail closed, and that failure must surface as a denial, not an
    // unhandled exception out of runWorkerOnce.
    seed(readProcessOutputAction(2_000_000_000));

    const executor = new FakeExecutor();
    const result = await runWorkerOnce({ dbPath, workerId: "dc-worker", machineExecutor: executor });

    expect(executor.calls).toHaveLength(0);
    expect(result.executed).toBe(false);
    const store = new SqliteWorkItemStore(dbPath);
    try {
      const denied = store.readEvents({ limit: 500 }).find((e) => e.name === "execution.authorization_denied");
      expect(denied?.body?.code).toBe("process_ownership_identity_unresolvable");
    } finally {
      store.close();
    }
  });
});

describe("ADR-0016 Slice 5: start_process registers the process-session on success", () => {
  it("registers the exact live process identity after a successful start_process", async () => {
    const { id } = seed(startProcessAction());
    const executor = new FakeExecutor();
    executor.output = `Process started with PID ${process.pid}`;

    const result = await runWorkerOnce({ dbPath, workerId: "dc-worker", machineExecutor: executor });

    expect(result).toMatchObject({ executed: true, workItemId: id });
    const store = new SqliteWorkItemStore(dbPath);
    try {
      expect(store.get(id)?.status).toBe("succeeded");
      const session = store.getActiveProcessSession(process.pid, getHostBootId());
      expect(session?.workItemId).toBe(id);
      expect(session?.procStartTicks).toBe(getProcessStartTicks(process.pid));
    } finally {
      store.close();
    }
  });

  it("does not create a session when start_process itself fails", async () => {
    const { id } = seed(startProcessAction());
    const executor = new FakeExecutor();
    executor.isError = true;
    executor.output = `Process started with PID ${process.pid}`;

    await runWorkerOnce({ dbPath, workerId: "dc-worker", machineExecutor: executor });

    const store = new SqliteWorkItemStore(dbPath);
    try {
      expect(store.get(id)?.status).not.toBe("succeeded");
      expect(store.getActiveProcessSession(process.pid, getHostBootId())).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("reports failure rather than false success when the pid cannot be parsed from Desktop Commander's response", async () => {
    const { id } = seed(startProcessAction());
    const executor = new FakeExecutor();
    // Desktop Commander says it succeeded but the text carries no pid we can trust.
    executor.output = "Process started successfully.";

    const result = await runWorkerOnce({ dbPath, workerId: "dc-worker", machineExecutor: executor });

    expect(result.executed).toBe(true); // Desktop Commander really was called.
    const store = new SqliteWorkItemStore(dbPath);
    try {
      // The work item must NOT be reported as succeeded - an unregistered,
      // unowned process is not a safely-usable outcome.
      expect(store.get(id)?.status).toBe("failed");
      const denied = store.readEvents({ limit: 500 }).find((e) => e.name === "execution.authorization_denied");
      expect(denied?.body?.code).toBe("process_session_pid_unresolvable");
    } finally {
      store.close();
    }
  });

  it("a retried registration against an already-active identity does not transfer ownership to a different work item", async () => {
    const first = seed(startProcessAction());
    const store = new SqliteWorkItemStore(dbPath);
    // Simulate: the first work item's start_process already registered this
    // exact live identity as active.
    store.createProcessSession(
      {
        workItemId: first.id,
        actionHash: FAKE_ACTION_HASH,
        workerId: "dc-worker",
        pid: process.pid,
        bootId: getHostBootId(),
        procStartTicks: getProcessStartTicks(process.pid)
      },
      via
    );
    store.close();

    // A second, unrelated work item's start_process happens to report the
    // exact same pid back (e.g. Desktop Commander racing a reused pid, or a
    // retried call). Registration must conflict, never silently reassign.
    const second = seed(startProcessAction());
    const executor = new FakeExecutor();
    executor.output = `Process started with PID ${process.pid}`;

    await runWorkerOnce({ dbPath, workerId: "dc-worker", machineExecutor: executor });

    const verify = new SqliteWorkItemStore(dbPath);
    try {
      expect(verify.get(second.id)?.status).not.toBe("succeeded");
      // Ownership stays with the first work item.
      expect(verify.getActiveProcessSession(process.pid, getHostBootId())?.workItemId).toBe(first.id);
    } finally {
      verify.close();
    }
  });
});
