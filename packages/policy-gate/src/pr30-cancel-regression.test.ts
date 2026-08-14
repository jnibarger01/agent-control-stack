import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { describe, expect, it } from "vitest";
import { createPolicyEngine, createWorkItemTools } from "./index.js";

describe("PR30 cancellation authority regression", () => {
  it("revokes the authoritative attempt lease and terminalizes the attempt", () => {
    const directory = mkdtempSync(join(tmpdir(), "acs-pr30-cancel-"));
    const dbPath = join(directory, "control.db");
    const store = new SqliteWorkItemStore(dbPath);
    const tools = createWorkItemTools(store, createPolicyEngine());
    try {
      const item = tools.create_work_item({
        title: "cancel me",
        requester: "user",
        intent: "cancel authoritative work",
        target: { cwd: "/repo" },
        requestedActions: [{ kind: "fs.read", description: "inspect", params: { paths: ["README.md"] } }],
        risk: "low"
      });
      const running = tools.claim_next_approved_work_item({ workerId: "worker-cancel" });
      expect(running?.id).toBe(item.id);
      store.cancelWorkItem(item.id, { actor: "operator", reason: "operator cancel" }, { via: "domain_service" });
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        expect(db.prepare("SELECT status FROM attempt_leases WHERE work_item_id = ?").get(item.id)).toEqual({
          status: "revoked"
        });
        expect(db.prepare("SELECT status FROM execution_attempts WHERE work_item_id = ?").get(item.id)).toEqual({
          status: "cancelled"
        });
      } finally {
        db.close();
      }
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
