import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteWorkItemStore } from "./index.js";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

interface IndexedDb {
  prepare: (sql: string) => {
    all: (...params: unknown[]) => unknown[];
    run: (...params: unknown[]) => unknown;
  };
  exec: (sql: string) => void;
}

function openStore(): { store: SqliteWorkItemStore; db: IndexedDb; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "acs-jc-reuse-index-"));
  dirs.push(dir);
  const dbPath = join(dir, "control.db");
  const store = new SqliteWorkItemStore(dbPath);
  return { store, db: (store as unknown as { db: IndexedDb }).db, dbPath };
}

function insertBoundItem(
  db: IndexedDb,
  id: string,
  createdAt: string,
  bindingHash: string,
  status = "approved",
  requesterSubject = "chatgpt:jacen"
): void {
  const actions = JSON.stringify([
    {
      kind: "jc.integration.read",
      description: "Jace Commander tool acs_read",
      params: { tool: "acs_read", bindingHash }
    }
  ]);
  db.prepare(
    `INSERT INTO work_items
     (id, title, requester, requester_subject, status, intent, target_json, requested_actions_json, risk, created_at, updated_at)
     VALUES (?, ?, 'agent', ?, ?, 'test', '{}', ?, 'low', ?, ?)`
  ).run(id, id, requesterSubject, status, actions, createdAt, createdAt);
}

describe("JC reusable work-item lookup (migration 037)", () => {
  it("uses requester/status index and returns the newest matching reusable item", () => {
    const { store, db } = openStore();
    try {
      insertBoundItem(db, "old", "2026-01-01T00:00:00.000Z", "match", "needs_approval");
      insertBoundItem(db, "newer", "2026-01-02T00:00:00.000Z", "match");
      insertBoundItem(db, "wrong-hash", "2026-01-03T00:00:00.000Z", "other");
      insertBoundItem(db, "admin-approved", "2026-01-04T00:00:00.000Z", "match");
      db.prepare(
        `INSERT INTO approval_records
         (work_item_id, action_hash, request_hash, approval_token_hash, approved_by, reason, status, created_at, expires_at)
         VALUES (?, 'hash', '', '', 'acs:admin', 'test', 'granted', ?, '9999-12-31T23:59:59.999Z')`
      ).run("admin-approved", "2026-01-04T00:00:00.000Z");

      expect(
        store.findReusableBoundWorkItem({
          requesterSubject: "chatgpt:jacen",
          tool: "acs_read",
          bindingHash: "match",
          excludedApprover: "acs:admin"
        })?.id
      ).toBe("newer");

      const plan = db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT * FROM work_items
           WHERE requester_subject = ? AND status IN ('needs_approval','approved')
           ORDER BY created_at DESC LIMIT 1`
        )
        .all("chatgpt:jacen")
        .map((row) => String((row as { detail?: unknown }).detail ?? ""))
        .join(" | ");
      expect(plan).toContain("USING INDEX idx_work_items_requester_status_created");
      expect(plan).not.toContain("SCAN work_items");
    } finally {
      store.close();
    }
  });

  it("recreates the requester/status index when upgrading from pre-037", () => {
    const { store, db, dbPath } = openStore();
    db.exec("DROP INDEX idx_work_items_requester_status_created");
    db.prepare("DELETE FROM schema_migrations WHERE version = 37").run();
    store.close();

    const reopened = new SqliteWorkItemStore(dbPath);
    try {
      const reopenedDb = (reopened as unknown as { db: IndexedDb }).db;
      expect(
        reopenedDb
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_work_items_requester_status_created'"
          )
          .all()
      ).toHaveLength(1);
    } finally {
      reopened.close();
    }
  });
});
