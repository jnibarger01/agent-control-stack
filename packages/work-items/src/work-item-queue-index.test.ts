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

function openStore(): { store: SqliteWorkItemStore; db: IndexedDb } {
  const dir = mkdtempSync(join(tmpdir(), "acs-work-item-queue-index-"));
  dirs.push(dir);
  const store = new SqliteWorkItemStore(join(dir, "control.db"));
  return { store, db: (store as unknown as { db: IndexedDb }).db };
}

/** The queue statements the store issues verbatim (see claimNextApprovedWorkItem / list). */
const CLAIM_SQL = "SELECT * FROM work_items WHERE status = 'approved' ORDER BY created_at ASC LIMIT 1";
const STATUS_LIST_SQL = "SELECT * FROM work_items WHERE status = ? ORDER BY created_at DESC LIMIT ?";

function queryPlan(db: IndexedDb, sql: string, params: unknown[] = []): string {
  return db
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...params)
    .map((row) => String((row as { detail?: unknown }).detail ?? ""))
    .join(" | ");
}

function seedMixedHistory(db: IndexedDb, history: number): void {
  const insert = db.prepare(
    `INSERT INTO work_items
     (id, title, requester, status, intent, target_json, requested_actions_json, risk, created_at, updated_at)
     VALUES (?, ?, 'user', ?, 'seed', '{}', '[]', 'low', ?, ?)`
  );
  const terminal = ["succeeded", "failed", "cancelled", "rejected"];
  db.exec("BEGIN");
  for (let index = 0; index < history; index += 1) {
    const ts = new Date(Date.UTC(2026, 0, 1) + index * 1000).toISOString();
    insert.run(
      `wi_hist_${String(index).padStart(6, "0")}`,
      `history ${index}`,
      terminal[index % terminal.length],
      ts,
      ts
    );
  }
  // Oldest approved item sits at the front of the queue; newer ones follow.
  insert.run(
    "wi_approved_oldest",
    "oldest approved",
    "approved",
    "2025-12-01T00:00:00.000Z",
    "2025-12-01T00:00:00.000Z"
  );
  insert.run("wi_approved_newer", "newer approved", "approved", "2025-12-02T00:00:00.000Z", "2025-12-02T00:00:00.000Z");
  insert.run("wi_pending_one", "pending one", "pending_policy", "2025-12-03T00:00:00.000Z", "2025-12-03T00:00:00.000Z");
  db.exec("COMMIT");
}

describe("work-item queue index (migration 035)", () => {
  it("migrates a fresh control plane with the work-item queue index in place", () => {
    const { store, db } = openStore();
    try {
      const index = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_work_items_status_created'")
        .all();
      expect(index).toHaveLength(1);

      const columns = db
        .prepare("SELECT name FROM pragma_index_info('idx_work_items_status_created') ORDER BY seqno")
        .all()
        .map((row) => String((row as { name: unknown }).name));
      expect(columns).toEqual(["status", "created_at"]);
    } finally {
      store.close();
    }
  });

  it("serves the worker claim without scanning work_items or sorting a temp b-tree", () => {
    const { store, db } = openStore();
    try {
      seedMixedHistory(db, 500);
      const plan = queryPlan(db, CLAIM_SQL);
      expect(plan).toContain("USING INDEX idx_work_items_status_created");
      expect(plan).not.toContain("SCAN work_items");
      expect(plan).not.toContain("TEMP B-TREE");
    } finally {
      store.close();
    }
  });

  it("serves status-filtered listings without scanning work_items", () => {
    const { store, db } = openStore();
    try {
      seedMixedHistory(db, 500);
      const plan = queryPlan(db, STATUS_LIST_SQL, ["pending_policy", 25]);
      expect(plan).toContain("USING INDEX idx_work_items_status_created");
      expect(plan).not.toContain("SCAN work_items");
      expect(plan).not.toContain("TEMP B-TREE");
    } finally {
      store.close();
    }
  });

  it("keeps claim and listing semantics identical with a large history behind the queue", () => {
    const { store, db } = openStore();
    try {
      seedMixedHistory(db, 2_000);
      // The claim is unchanged by the index: still the oldest approved item.
      expect(db.prepare(CLAIM_SQL).all()).toMatchObject([{ id: "wi_approved_oldest" }]);
      // The status-filtered listing is unchanged: still newest-first.
      expect(store.list({ status: "approved", limit: 5 }).map((item) => item.id)).toEqual([
        "wi_approved_newer",
        "wi_approved_oldest"
      ]);
      expect(store.list({ status: "pending_policy", limit: 5 }).map((item) => item.id)).toEqual(["wi_pending_one"]);
    } finally {
      store.close();
    }
  });

  it("recreates the queue index on a control plane that predates migration 035", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-work-item-queue-index-upgrade-"));
    dirs.push(dir);
    const dbPath = join(dir, "control.db");
    const before = new SqliteWorkItemStore(dbPath);
    const beforeDb = (before as unknown as { db: IndexedDb }).db;
    // Roll the schema back to what a pre-035 deployment looks like.
    beforeDb.exec("DROP INDEX idx_work_items_status_created");
    beforeDb.prepare("DELETE FROM schema_migrations WHERE version = 35").run();
    before.close();

    const reopened = new SqliteWorkItemStore(dbPath);
    try {
      const db = (reopened as unknown as { db: IndexedDb }).db;
      expect(
        db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_work_items_status_created'")
          .all()
      ).toHaveLength(1);
      expect(queryPlan(db, CLAIM_SQL)).toContain("USING INDEX idx_work_items_status_created");
    } finally {
      reopened.close();
    }
  });
});
