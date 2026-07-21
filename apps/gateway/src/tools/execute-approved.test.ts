import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { describe, expect, it } from "vitest";
import { executeApprovedWorkItem } from "./execute-approved.js";

const transition = { via: "domain_service" as const };

function createApproved(dbPath: string): { store: SqliteWorkItemStore; id: string } {
  const store = new SqliteWorkItemStore(dbPath);
  const item = store.create({
    title: "Approved dispatcher item",
    requester: "agent",
    intent: "exercise the dry-run dispatcher",
    target: { cwd: "/repo" },
    requestedActions: [{ kind: "fs.read", description: "simulate", params: { paths: ["src/index.ts"] } }],
    risk: "low"
  });
  store.approveWorkItem(item.id, transition);
  return { store, id: item.id };
}

describe("approved execution dispatcher", () => {
  it("submits a canonical simulated result through the lease boundary", async () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-approved-dispatch-"));
    const { store, id } = createApproved(join(directory, "control.db"));
    try {
      const result = await executeApprovedWorkItem({
        store,
        workerId: "dispatcher-worker",
        execute: async () => ({ ok: true, executionMode: "dry_run", output: "no real command ran" })
      });

      expect(result).toMatchObject({ executed: true, workItemId: id });
      expect(store.get(id)).toMatchObject({ status: "succeeded", result: { executionMode: "dry_run" } });
      expect(store.verifyAuditChain()).toMatchObject({ ok: true });
      expect(store.readEvents().map((event) => event.name)).toContain("execution_result.accepted");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("records simulated worker infrastructure failures without reopening the item", async () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-approved-dispatch-failure-"));
    const { store, id } = createApproved(join(directory, "control.db"));
    try {
      await executeApprovedWorkItem({
        store,
        workerId: "dispatcher-worker",
        execute: async () => {
          throw new Error("simulated callback failure");
        }
      });

      expect(store.get(id)).toMatchObject({ status: "failed", result: { outcome: "worker_infrastructure_failure" } });
      expect(store.verifyAuditChain()).toMatchObject({ ok: true });
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not claim work when no approved item exists", async () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-approved-dispatch-empty-"));
    const store = new SqliteWorkItemStore(join(directory, "control.db"));
    try {
      const result = await executeApprovedWorkItem({
        store,
        workerId: "dispatcher-worker",
        execute: async () => ({ ok: true, executionMode: "dry_run", output: "unused" })
      });
      expect(result).toEqual({ executed: false, reason: "no approved work item" });
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
