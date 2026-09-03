import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPolicyEngine, createWorkItemTools } from "@agent-control-stack/policy-gate";
import { executeSandboxed } from "@agent-control-stack/sandbox";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertDryRunExecutionMode, runWorkerOnce } from "./index.js";

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
    expect(() => assertDryRunExecutionMode("future_mode", "test")).toThrow(
      "worker requires dry_run execution mode"
    );
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
