import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { applyControlPlaneMigrations, controlPlaneMigrations } from "./migration.js";
import { describe, expect, it } from "vitest";

function freshDb(): { db: DatabaseSync; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "acs-migration-"));
  const dbPath = join(dir, "control.db");
  return { db: new DatabaseSync(dbPath), dbPath };
}

describe("ADR-0016 Slice 4: dc_process_sessions migration (version 19)", () => {
  it("registers migration 019 with the expected metadata", () => {
    const migrations = controlPlaneMigrations();
    const v19 = migrations.find((m) => m.version === 19);
    expect(v19).toBeDefined();
    expect(v19?.name).toBe("dc_process_sessions");
    expect(v19?.filename).toBe("019_dc_process_sessions.sql");
    expect(v19?.sql).toContain("CREATE TABLE IF NOT EXISTS dc_process_sessions");
  });

  it("applies cleanly against a fresh database and creates dc_process_sessions", () => {
    const { db } = freshDb();
    try {
      expect(() => applyControlPlaneMigrations(db)).not.toThrow();

      const table = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='dc_process_sessions'")
        .get() as { name: string } | undefined;
      expect(table?.name).toBe("dc_process_sessions");

      const cols = (db.prepare("PRAGMA table_info(dc_process_sessions)").all() as Array<{ name: string }>).map(
        (c) => c.name
      );
      expect(cols).toEqual(
        expect.arrayContaining([
          "id",
          "work_item_id",
          "action_hash",
          "worker_id",
          "pid",
          "boot_id",
          "proc_start_ticks",
          "dc_session_id",
          "status",
          "created_at",
          "updated_at",
          "last_seen_at",
          "closed_at"
        ])
      );

      const indexes = (
        db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='dc_process_sessions'").all() as
          Array<{ name: string }>
      ).map((r) => r.name);
      expect(indexes).toContain("idx_dc_process_sessions_active_identity");
      expect(indexes).toContain("idx_dc_process_sessions_work_item");
      expect(indexes).toContain("idx_dc_process_sessions_status");
    } finally {
      db.close();
    }
  });

  it("is idempotent: applying migrations twice does not error or duplicate rows", () => {
    const { db } = freshDb();
    try {
      applyControlPlaneMigrations(db);
      expect(() => applyControlPlaneMigrations(db)).not.toThrow();

      const row = db
        .prepare("SELECT version FROM schema_migrations WHERE version = 19")
        .get() as { version: number } | undefined;
      expect(row?.version).toBe(19);
    } finally {
      db.close();
    }
  });

  it("enforces the partial unique index: two active sessions cannot share (pid, boot_id, proc_start_ticks)", () => {
    const { db } = freshDb();
    try {
      applyControlPlaneMigrations(db);
      // dc_process_sessions.work_item_id has a FK to work_items(id), and this
      // connection enforces it, so seed the two work_items rows the test's
      // sessions reference before exercising the partial unique index.
      const now0 = new Date().toISOString();
      const insertWorkItem = db.prepare(
        `INSERT INTO work_items
           (id, title, requester, status, intent, target_json, requested_actions_json, risk, created_at, updated_at)
         VALUES (?, ?, ?, 'running', 'test', '{}', '[]', 'low', ?, ?)`
      );
      for (const workItemId of ["wi-1", "wi-2", "wi-3"]) {
        insertWorkItem.run(workItemId, workItemId, "tester", now0, now0);
      }

      const insert = db.prepare(
        `INSERT INTO dc_process_sessions
           (id, work_item_id, action_hash, worker_id, pid, boot_id, proc_start_ticks, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`
      );
      const now = new Date().toISOString();
      insert.run("sess-1", "wi-1", "hash-1", "worker-1", 4242, "boot-a", 100, now, now);

      expect(() =>
        insert.run("sess-2", "wi-2", "hash-2", "worker-2", 4242, "boot-a", 100, now, now)
      ).toThrow();

      // A closed row for the same identity does not collide (reuse is
      // allowed once the prior session is no longer active).
      db.prepare(
        `UPDATE dc_process_sessions SET status = 'closed', closed_at = ? WHERE id = 'sess-1'`
      ).run(now);
      expect(() =>
        insert.run("sess-3", "wi-3", "hash-3", "worker-3", 4242, "boot-a", 100, now, now)
      ).not.toThrow();
    } finally {
      db.close();
    }
  });
});
