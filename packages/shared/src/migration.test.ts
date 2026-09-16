import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { applyControlPlaneMigrations, controlPlaneMigrations } from "./migration.js";

const temporaryDirectories: string[] = [];
const legacyRows = [
  {
    version: 17,
    name: "desktop_commander_execution_mode",
    filename: "017_desktop_commander_execution_mode.sql",
    checksum: "aedd1140975cd1a9197df06f1dbd9906b8b3ab143b4025bcc2e4ba0e758f5d43"
  },
  {
    version: 18,
    name: "advisory_evidence_and_verification",
    filename: "018_advisory_evidence_and_verification.sql",
    checksum: "456755abba99bae8a282b1f0544b4f0e798f57a27d4e717ec4b28ba79d4a9f7d"
  }
] as const;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});
function database(): DatabaseSync {
  const directory = mkdtempSync(join(tmpdir(), "acs-migration-repair-"));
  temporaryDirectories.push(directory);
  return new DatabaseSync(join(directory, "control.db"));
}

function createMigrationHistoryTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      filename TEXT NOT NULL,
      checksum TEXT NOT NULL DEFAULT '',
      applied_at TEXT NOT NULL
    );
  `);
}

function recordMigration(
  db: DatabaseSync,
  row: { version: number; name: string; filename: string; checksum: string }
): void {
  db.prepare(
    `INSERT INTO schema_migrations (version, name, filename, checksum, applied_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(row.version, row.name, row.filename, row.checksum, "2026-09-03T11:10:40.000Z");
}
function applyCanonicalThroughSixteen(db: DatabaseSync): void {
  createMigrationHistoryTable(db);
  for (const migration of controlPlaneMigrations().filter(({ version }) => version <= 16)) {
    db.exec(migration.sql);
    recordMigration(db, migration);
  }
}

function createLegacySeventeenEighteenDatabase(db: DatabaseSync): void {
  applyCanonicalThroughSixteen(db);
  const migrations = controlPlaneMigrations();
  const legacyDesktopCommander = migrations.find(({ version }) => version === 20);
  const legacyAdvisory = migrations.find(({ version }) => version === 21);
  if (!legacyDesktopCommander || !legacyAdvisory) throw new Error("legacy source migrations unavailable");

  db.exec(legacyDesktopCommander.sql);
  recordMigration(db, legacyRows[0]);
  db.exec(legacyAdvisory.sql);
  recordMigration(db, legacyRows[1]);
}

function migrationRows(db: DatabaseSync) {
  return db.prepare("SELECT version, name, filename, checksum FROM schema_migrations ORDER BY version").all() as Array<{
    version: number;
    name: string;
    filename: string;
    checksum: string;
  }>;
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}
function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(
    ({ name }) => name === column
  );
}

function canonicalRowsFromSeventeen() {
  return controlPlaneMigrations()
    .filter(({ version }) => version >= 17)
    .map(({ version, name, filename, checksum }) => ({ version, name, filename, checksum }));
}

describe("control-plane migration lineage reconciliation", () => {
  it("migrates a fresh database through canonical version 23", () => {
    const db = database();
    applyControlPlaneMigrations(db);

    expect(migrationRows(db)).toHaveLength(23);
    expect(migrationRows(db).at(-1)).toMatchObject({
      version: 23,
      name: "desktop_commander_runtime_capabilities"
    });
    db.close();
  });

  it("reconciles the exact legacy 17/18 lineage and remains idempotent", () => {
    const db = database();
    createLegacySeventeenEighteenDatabase(db);

    expect(hasTable(db, "attempt_lease_approvals")).toBe(false);
    expect(hasColumn(db, "work_items", "metadata_json")).toBe(false);
    applyControlPlaneMigrations(db);

    expect(migrationRows(db).filter(({ version }) => version >= 17)).toEqual(canonicalRowsFromSeventeen());
    expect(hasTable(db, "attempt_lease_approvals")).toBe(true);
    expect(hasColumn(db, "work_items", "metadata_json")).toBe(true);
    expect(hasTable(db, "plan_proposals")).toBe(true);
    expect(hasTable(db, "evidence_manifests")).toBe(true);

    const afterFirstRepair = migrationRows(db);
    applyControlPlaneMigrations(db);
    expect(migrationRows(db)).toEqual(afterFirstRepair);
    db.close();
  });

  it("fails closed on a legacy checksum mismatch without applying canonical migrations", () => {
    const db = database();
    createLegacySeventeenEighteenDatabase(db);
    db.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 18").run("0".repeat(64));
    const before = migrationRows(db);

    expect(() => applyControlPlaneMigrations(db)).toThrow("legacy migration lineage mismatch");
    expect(migrationRows(db)).toEqual(before);
    expect(hasTable(db, "attempt_lease_approvals")).toBe(false);
    expect(hasColumn(db, "work_items", "metadata_json")).toBe(false);
    db.close();
  });
  it("fails closed when the exact legacy metadata lacks required legacy schema", () => {
    const db = database();
    createLegacySeventeenEighteenDatabase(db);
    db.exec("DROP TABLE review_findings");
    const before = migrationRows(db);

    expect(() => applyControlPlaneMigrations(db)).toThrow("legacy migration lineage schema validation failed");
    expect(migrationRows(db)).toEqual(before);
    expect(hasTable(db, "attempt_lease_approvals")).toBe(false);
    expect(hasColumn(db, "work_items", "metadata_json")).toBe(false);
    db.close();
  });

  it("does not repair a partial legacy history", () => {
    const db = database();
    createLegacySeventeenEighteenDatabase(db);
    db.prepare("DELETE FROM schema_migrations WHERE version = 18").run();
    const before = migrationRows(db);

    expect(() => applyControlPlaneMigrations(db)).toThrow("legacy migration lineage mismatch");
    expect(migrationRows(db)).toEqual(before);
    expect(hasTable(db, "attempt_lease_approvals")).toBe(false);
    db.close();
  });
});
