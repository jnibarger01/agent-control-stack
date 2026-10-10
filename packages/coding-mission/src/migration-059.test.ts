import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyControlPlaneMigrations, controlPlaneMigrations } from "@agent-control-stack/shared";
import { describe, expect, it } from "vitest";

/**
 * Builds a database exactly as a deployed 056 database looks to the production
 * runner: schema through 056 plus canonical schema_migrations rows, so
 * applyControlPlaneMigrations upgrades it through 057+ the way a real deploy would.
 */
function databaseAt056(filename = ":memory:"): DatabaseSync {
  const db = new DatabaseSync(filename);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`CREATE TABLE schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    filename TEXT NOT NULL,
    checksum TEXT NOT NULL DEFAULT '',
    applied_at TEXT NOT NULL
  )`);
  const insert = db.prepare(
    "INSERT INTO schema_migrations (version, name, filename, checksum, applied_at) VALUES (?, ?, ?, ?, ?)"
  );
  for (const migration of controlPlaneMigrations().filter((entry) => entry.version <= 56)) {
    db.exec(migration.sql);
    insert.run(migration.version, migration.name, migration.filename, migration.checksum, "2026-10-01T00:00:00Z");
  }
  return db;
}

function seedMission(db: DatabaseSync, missionId: string, state: string): void {
  db.prepare(
    `INSERT INTO coding_missions (
       mission_id, repository, base_ref, base_sha, summary, state, version, branch,
       deployment_required, deployment_action, deployment_impact, created_at, updated_at, mission_kind
     ) VALUES (?, 'org/repo', 'main', ?, 'verify', ?, 1, ?, 0, 'none', 'none',
       '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z', 'general')`
  ).run(missionId, "a".repeat(40), state, `acs/${missionId}`);
}

function seedUnit(
  db: DatabaseSync,
  missionId: string,
  unitId: string,
  status: string,
  failureCategory: string | null
): void {
  db.prepare(
    `INSERT INTO coding_operations (
       mission_id, operation_id, depends_on, title, status, result_hash, files_json, unit_kind,
       attempt, depth, verification_policy, failure_category
     ) VALUES (?, ?, '[]', 'unit', ?, 'result-1', '["a.ts"]', 'coding', 1, 0, 'independent', ?)`
  ).run(missionId, unitId, status, failureCategory);
}

function unit(db: DatabaseSync, missionId: string, unitId: string) {
  return db
    .prepare("SELECT status, failure_category FROM coding_operations WHERE mission_id = ? AND operation_id = ?")
    .get(missionId, unitId);
}

function quarantined(db: DatabaseSync): unknown[] {
  return db
    .prepare(
      "SELECT mission_id, unit_id, previous_status FROM work_unit_verification_quarantine ORDER BY mission_id, unit_id"
    )
    .all()
    .map((row) => ({ ...row }));
}

describe("migration 059: restore terminal units rewritten by migration 057", () => {
  it("leaves succeeded and cancelled verified units terminal after an upgrade from 056", () => {
    const db = databaseAt056();
    seedMission(db, "m-done", "COMPLETED");
    seedUnit(db, "m-done", "u-succeeded", "succeeded", null);
    seedMission(db, "m-cancelled", "CANCELLED");
    seedUnit(db, "m-cancelled", "u-cancelled", "cancelled", "cancelled");
    seedMission(db, "m-live", "RUNNING");
    seedUnit(db, "m-live", "u-verifying", "verifying", null);

    applyControlPlaneMigrations(db);

    expect(unit(db, "m-done", "u-succeeded")).toEqual({ status: "succeeded", failure_category: null });
    expect(unit(db, "m-cancelled", "u-cancelled")).toEqual({ status: "cancelled", failure_category: "cancelled" });
    // In-flight verified work is still quarantined exactly as 057 intended.
    expect(unit(db, "m-live", "u-verifying")).toEqual({ status: "failed", failure_category: "verification_failure" });
    expect(quarantined(db)).toEqual([{ mission_id: "m-live", unit_id: "u-verifying", previous_status: "verifying" }]);
    expect(
      db
        .prepare(
          "SELECT mission_id, json_extract(body_json, '$.restoredStatus') AS restored FROM coding_events WHERE name = ? ORDER BY mission_id"
        )
        .all("verification.migration_057_terminal_restored")
        .map((row) => ({ ...row }))
    ).toEqual([
      { mission_id: "m-cancelled", restored: "cancelled" },
      { mission_id: "m-done", restored: "succeeded" }
    ]);
    db.close();
  });

  it("keeps an exclusive writer boundary from 057 quarantine through 059 restoration", () => {
    const dir = mkdtempSync(join(tmpdir(), "acs-057-059-lock-"));
    const filename = join(dir, "upgrade.sqlite");
    const db = databaseAt056(filename);
    const competitor = new DatabaseSync(filename);
    try {
      seedMission(db, "m-done", "COMPLETED");
      seedUnit(db, "m-done", "u-succeeded", "succeeded", null);
      competitor.exec("PRAGMA busy_timeout = 0");
      let quarantinedInThisRun = false;
      let restorationReached = false;
      let competingWriteRefused = false;
      const monitored = {
        prepare: (sql: string) => db.prepare(sql),
        exec: (sql: string) => {
          if (sql === "COMMIT" && quarantinedInThisRun && !restorationReached) {
            throw new Error("writer lock released between migration 057 and 059");
          }
          db.exec(sql);
          if (sql.includes("CREATE TABLE work_unit_verification_quarantine")) {
            quarantinedInThisRun = true;
          }
          if (sql.includes("CREATE TABLE work_unit_verification_runs")) {
            // Probe at 058, after the 057 update: a live retry from another
            // SQLite connection must be refused by the still-held write lock.
            expect(() => competitor.exec(
              "UPDATE coding_operations SET title = 'concurrent retry' WHERE mission_id = 'm-done'"
            )).toThrow();
            competingWriteRefused = true;
          }
          if (sql.includes("verification.migration_057_terminal_restored")) {
            restorationReached = true;
          }
        }
      };
      applyControlPlaneMigrations(monitored);
      expect(quarantinedInThisRun).toBe(true);
      expect(competingWriteRefused).toBe(true);
      expect(restorationReached).toBe(true);
      expect(unit(db, "m-done", "u-succeeded")).toEqual({ status: "succeeded", failure_category: null });
    } finally {
      competitor.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses ambiguous restoration when 057 ran before this upgrade", () => {
    const db = databaseAt056();
    seedMission(db, "m-done", "COMPLETED");
    seedUnit(db, "m-done", "u-succeeded", "succeeded", null);
    seedUnit(db, "m-done", "u-reconciled", "succeeded", null);

    // Simulate a deployment that ran 057 and 058 before this fix existed.
    const migrations = controlPlaneMigrations();
    const insert = db.prepare(
      "INSERT INTO schema_migrations (version, name, filename, checksum, applied_at) VALUES (?, ?, ?, ?, ?)"
    );
    for (const migration of migrations.filter((entry) => entry.version === 57 || entry.version === 58)) {
      db.exec(migration.sql);
      insert.run(migration.version, migration.name, migration.filename, migration.checksum, "2026-10-08T00:00:00Z");
    }
    expect(unit(db, "m-done", "u-succeeded")).toEqual({ status: "failed", failure_category: "verification_failure" });
    // An operator already moved this unit on after 057; 059 must leave it alone.
    db.prepare(
      "UPDATE coding_operations SET failure_category = 'retry_budget_exhausted' WHERE mission_id = 'm-done' AND operation_id = 'u-reconciled'"
    ).run();

    // A 057 installation made on a prior run is no longer safe to restore
    // automatically: a later attempt can return to the same failure tuple.
    expect(() => applyControlPlaneMigrations(db)).toThrow(/migration 059 refused ambiguous terminal restoration/);
    expect(unit(db, "m-done", "u-succeeded")).toEqual({
      status: "failed",
      failure_category: "verification_failure"
    });
    expect(unit(db, "m-done", "u-reconciled")).toEqual({
      status: "failed",
      failure_category: "retry_budget_exhausted"
    });
    expect(quarantined(db)).toEqual([
      { mission_id: "m-done", unit_id: "u-reconciled", previous_status: "succeeded" },
      { mission_id: "m-done", unit_id: "u-succeeded", previous_status: "succeeded" }
    ]);
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version = 59").get()).toBeUndefined();
    db.close();
  });

  it("does not turn a post-057 genuine retry failure back into success", () => {
    const db = databaseAt056();
    seedMission(db, "m-running", "RUNNING");
    seedUnit(db, "m-running", "u-retried", "succeeded", null);
    const insert = db.prepare(
      "INSERT INTO schema_migrations (version, name, filename, checksum, applied_at) VALUES (?, ?, ?, ?, ?)"
    );
    for (const migration of controlPlaneMigrations().filter((entry) => entry.version === 57 || entry.version === 58)) {
      db.exec(migration.sql);
      insert.run(migration.version, migration.name, migration.filename, migration.checksum, "2026-10-08T00:00:00Z");
    }
    // The live mission retries after 057 and fails independent verification.
    db.prepare(
      "UPDATE coding_operations SET attempt = 2, status = 'failed', failure_category = 'verification_failure' WHERE mission_id = ? AND operation_id = ?"
    ).run("m-running", "u-retried");
    db.prepare(
      "INSERT INTO coding_events (mission_id, name, body_json, created_at) VALUES (?, ?, ?, ?)"
    ).run("m-running", "work_unit.retry_scheduled", '{"unitId":"u-retried","attempt":1}', "2026-10-08T00:01:00Z");

    expect(() => applyControlPlaneMigrations(db)).toThrow(/migration 059 refused ambiguous terminal restoration/);
    expect(unit(db, "m-running", "u-retried")).toEqual({
      status: "failed",
      failure_category: "verification_failure"
    });
    expect(quarantined(db)).toEqual([
      { mission_id: "m-running", unit_id: "u-retried", previous_status: "succeeded" }
    ]);
    expect(db.prepare("SELECT version FROM schema_migrations WHERE version = 59").get()).toBeUndefined();
    db.close();
  });
});
