import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { describe, expect, it } from "vitest";
import { executeSandboxed } from "./index.js";

describe("sandbox execution boundary", () => {
  it("returns an explicitly simulated result for a running-shaped unit fixture", async () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-sandbox-"));
    const store = new SqliteWorkItemStore(join(directory, "control.db"));
    try {
      const item = store.create({
        title: "Sandbox boundary",
        requester: "agent",
        intent: "prove dry-run boundary",
        target: { cwd: "/repo" },
        requestedActions: [{ kind: "manual", description: "simulate" }],
        risk: "low"
      });
      const running = { ...item, status: "running" as const };

      await expect(executeSandboxed(running)).resolves.toEqual({
        ok: true,
        executionMode: "dry_run",
        output: `dry-run simulated ${running.id}`
      });
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses to run a non-running item", async () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-sandbox-reject-"));
    const store = new SqliteWorkItemStore(join(directory, "control.db"));
    try {
      const item = store.create({
        title: "Sandbox refusal",
        requester: "agent",
        intent: "reject unleased work",
        target: { cwd: "/repo" },
        requestedActions: [{ kind: "manual", description: "simulate" }],
        risk: "low"
      });

      await expect(executeSandboxed(item)).rejects.toThrow("is pending_policy");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
