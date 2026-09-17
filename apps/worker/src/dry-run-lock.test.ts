import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPolicyEngine, createWorkItemTools } from "@agent-control-stack/policy-gate";
import { executeSandboxed } from "@agent-control-stack/sandbox";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveExecutionBackend } from "@agent-control-stack/work-items";
import { assertDryRunExecutionMode, assertExecutionModeForBackend, runWorkerOnce } from "./index.js";

vi.mock("@agent-control-stack/sandbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@agent-control-stack/sandbox")>();
  return {
    ...actual,
    executeSandboxed: vi.fn(actual.executeSandboxed)
  };
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("worker dry-run lock", () => {
  it("rejects a non-dry-run execution mode in production", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-worker-dry-run-lock-"));
    const dbPath = join(dir, "control.db");
    const workItemId = createReadyReadWork(dbPath);

    try {
      vi.stubEnv("NODE_ENV", "production");
      vi.mocked(executeSandboxed).mockResolvedValueOnce({
        ok: true,
        executionMode: "live" as never,
        output: "live execution must not be accepted"
      });

      await expect(runWorkerOnce({ dbPath, workerId: "production-worker" })).rejects.toThrow(
        "production worker requires dry_run execution mode"
      );

      const check = new SqliteWorkItemStore(dbPath);
      try {
        expect(check.get(workItemId)?.status).toBe("running");
      } finally {
        check.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed on an unknown execution mode", () => {
    expect(() => assertDryRunExecutionMode("future_mode", "test")).toThrow("worker requires dry_run execution mode");
  });

  it("resolveExecutionBackend defaults to dry_run and fails closed on garbage", () => {
    expect(resolveExecutionBackend({})).toBe("dry_run");
    expect(resolveExecutionBackend({ ACS_EXECUTION_BACKEND: "" })).toBe("dry_run");
    expect(resolveExecutionBackend({ ACS_EXECUTION_BACKEND: "dry_run" })).toBe("dry_run");
    expect(resolveExecutionBackend({ ACS_EXECUTION_BACKEND: "desktop_commander" })).toBe("desktop_commander");
    expect(() => resolveExecutionBackend({ ACS_EXECUTION_BACKEND: "live" })).toThrow(/unknown ACS_EXECUTION_BACKEND/);
    expect(() => resolveExecutionBackend({ ACS_EXECUTION_BACKEND: "bubblewrap" })).toThrow(/unknown/);
  });

  it("assertExecutionModeForBackend pins the mode to the backend", () => {
    expect(() => assertExecutionModeForBackend("dry_run", "dry_run", "test")).not.toThrow();
    expect(() => assertExecutionModeForBackend("desktop_commander", "desktop_commander", "test")).not.toThrow();
    expect(() => assertExecutionModeForBackend("desktop_commander", "dry_run", "production")).toThrow(
      "production worker requires dry_run execution mode"
    );
    expect(() => assertExecutionModeForBackend("dry_run", "desktop_commander", "test")).toThrow(
      "desktop_commander backend requires desktop_commander execution mode"
    );
    expect(() => assertExecutionModeForBackend("live", "desktop_commander", "test")).toThrow(
      "desktop_commander backend requires desktop_commander execution mode"
    );
  });

  it("desktop_commander backend fails closed when the adapter is not configured", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-worker-dc-unconfigured-"));
    const dbPath = join(dir, "control.db");
    createReadyReadWork(dbPath);
    try {
      vi.stubEnv("ACS_DESKTOP_COMMANDER_COMMAND", "");
      vi.stubEnv("ACS_DESKTOP_COMMANDER_ARGS_JSON", "");
      vi.stubEnv("ACS_DESKTOP_COMMANDER_ALLOWED_ROOTS", "");
      vi.stubEnv("ACS_EXECUTION_BACKEND", "");
      await expect(
        runWorkerOnce({ dbPath, workerId: "dc-worker", executionBackend: "desktop_commander" })
      ).rejects.toThrow(/Desktop Commander adapter is not configured/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not report a live production result", async () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-worker-dry-run-report-"));
    const dbPath = join(dir, "control.db");
    const workItemId = createReadyReadWork(dbPath);

    try {
      vi.stubEnv("NODE_ENV", "production");
      vi.mocked(executeSandboxed).mockResolvedValueOnce({
        ok: true,
        executionMode: "live" as never,
        output: "must not be persisted"
      });

      await expect(runWorkerOnce({ dbPath, workerId: "production-worker" })).rejects.toThrow();

      const check = new SqliteWorkItemStore(dbPath);
      try {
        const events = check.readEvents();
        expect(events.map((event) => event.name)).not.toContain("work_item.succeeded");
        expect(events.map((event) => event.name)).not.toContain("work_item.failed");
        expect(events.some((event) => event.attributes?.["execution.mode"] === "live")).toBe(false);
        expect(check.get(workItemId)?.status).toBe("running");
      } finally {
        check.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function createReadyReadWork(dbPath: string): string {
  const store = new SqliteWorkItemStore(dbPath);
  const tools = createWorkItemTools(store, createPolicyEngine());

  try {
    return tools.create_work_item({
      title: "Read work",
      requester: "user",
      intent: "verify worker execution mode boundary",
      target: { cwd: "/repo" },
      requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: ["src/index.ts"] } }],
      risk: "low"
    }).id;
  } finally {
    store.close();
  }
}
