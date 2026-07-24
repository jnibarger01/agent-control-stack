import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteWorkItemStore } from "./store.js";
import { executionActionHash } from "./work-item.js";
import { describe, expect, it } from "vitest";

function createTerminalReadItem(store: SqliteWorkItemStore) {
  const item = store.create({
    title: "Immutable source",
    requester: "user",
    intent: "inspect source",
    target: { cwd: "/repo" },
    requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: ["src/index.ts"] } }],
    risk: "low"
  });
  store.cancelWorkItem(item.id, { actor: "operator", reason: "terminal lineage fixture" }, { via: "domain_service" });
  return {
    item,
    sourceSnapshot: store.get(item.id)!,
    sourceActionHash: executionActionHash(item)
  };
}

describe("immutable retry and clone lineage", () => {
  it("creates a fresh retry and leaves the terminal source unchanged", () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-retry-"));
    const store = new SqliteWorkItemStore(join(directory, "control.db"));
    try {
      const { item, sourceSnapshot } = createTerminalReadItem(store);
      const retried = store.retryWorkItem(item.id, { actor: "user", reason: "verify again" });

      expect(retried.id).not.toBe(item.id);
      expect(retried.sourceWorkItemId).toBe(item.id);
      expect(retried.lineageType).toBe("retry");
      expect(retried.retryReason).toBe("verify again");
      expect(retried.retrySequence).toBe(1);
      expect(retried.rootWorkItemId).toBe(item.id);
      expect(retried.result).toBeUndefined();
      expect(store.get(item.id)).toEqual(sourceSnapshot);

      store.cancelWorkItem(
        retried.id,
        { actor: "operator", reason: "terminal second lineage fixture" },
        { via: "domain_service" }
      );
      const retryAgain = store.retryWorkItem(retried.id, { actor: "user", reason: "one more time" });
      expect(retryAgain.sourceWorkItemId).toBe(retried.id);
      expect(retryAgain.rootWorkItemId).toBe(item.id);
      expect(retryAgain.retrySequence).toBe(2);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("clones safe request fields with a new identity and fresh action hash", () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-clone-"));
    const dbPath = join(directory, "control.db");
    const store = new SqliteWorkItemStore(dbPath);
    try {
      const { item, sourceSnapshot, sourceActionHash } = createTerminalReadItem(store);
      const cloned = store.cloneWorkItem(item.id, {
        actor: "user",
        title: "Cloned inspection",
        intent: "inspect a second path",
        target: { cwd: "/repo" },
        requestedActions: [{ kind: "fs.read", description: "inspect other", params: { paths: ["src/other.ts"] } }]
      });
      expect(cloned.id).not.toBe(item.id);
      expect(cloned.sourceWorkItemId).toBe(item.id);
      expect(cloned.lineageType).toBe("clone");
      expect(cloned.title).toBe("Cloned inspection");
      expect(cloned.intent).toBe("inspect a second path");
      expect(store.get(item.id)).toEqual(sourceSnapshot);

      const cloneActionHash = executionActionHash(cloned);
      expect(cloneActionHash).toMatch(/^[a-f0-9]{64}$/);
      expect(cloneActionHash).not.toBe(sourceActionHash);

      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const approvals = db
          .prepare(`SELECT COUNT(*) AS count FROM approval_records WHERE work_item_id = ?`)
          .get(cloned.id) as { count: number };
        expect(approvals.count).toBe(0);
      } finally {
        db.close();
      }
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects retry and clone of a nonterminal source", () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-lineage-state-"));
    const store = new SqliteWorkItemStore(join(directory, "control.db"));
    try {
      const item = store.create({
        title: "Running source",
        requester: "agent",
        intent: "remain active",
        target: { cwd: "/repo" },
        requestedActions: [{ kind: "fs.read", description: "inspect" }],
        risk: "low"
      });
      store.approveWorkItem(item.id, { via: "domain_service" });

      expect(() => store.retryWorkItem(item.id, { actor: "user", reason: "not safe yet" })).toThrow("terminal source");
      expect(() => store.cloneWorkItem(item.id, { actor: "user" })).toThrow("terminal source");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
