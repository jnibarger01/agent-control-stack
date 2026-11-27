import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { inspectControlPlaneDatabaseFile } from "./database-health.js";
import {
  applyControlPlaneMigrations,
  controlPlaneMigrations,
  forwardCompatibleMigrationSql,
  forwardCompatibleMigrations
} from "./migration.js";

/**
 * Bridge release (step B0 of docs/migrations/production-cutover-plan.md). Acceptance: a database that a later
 * release migrated with a reviewed additive migration stays healthy under this release, so rolling the later release
 * back means redeploying this one, without restoring the database. Every other unknown migration row still fails.
 */

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixtureSql(filename: string): string {
  return forwardCompatibleMigrationSql(filename);
}

function migratedDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), "acs-forward-compatible-"));
  directories.push(directory);
  const path = join(directory, "control.db");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON;");
  applyControlPlaneMigrations(db);
  db.close();
  return path;
}

/** What the later release does: run the migration SQL and record it. */
function applyLater(
  path: string,
  row: { version: number; name: string; filename: string; checksum: string },
  sql: string
) {
  const db = new DatabaseSync(path);
  db.exec(sql);
  db.prepare(
    "INSERT INTO schema_migrations (version, name, filename, checksum, applied_at) VALUES (?, ?, ?, ?, ?)"
  ).run(row.version, row.name, row.filename, row.checksum, new Date().toISOString());
  db.close();
}

describe("forward-compatible migrations (bridge release B0)", () => {
  it("lists only versions above every shipped migration, with checksums of the reviewed SQL", () => {
    const shipped = controlPlaneMigrations().map((migration) => migration.version);
    for (const entry of forwardCompatibleMigrations()) {
      expect(shipped).not.toContain(entry.version);
      expect(entry.version).toBeGreaterThan(Math.max(...shipped));
      expect(entry.filename).toBe(`${String(entry.version).padStart(3, "0")}_${entry.name}.sql`);
      expect(createHash("sha256").update(fixtureSql(entry.filename)).digest("hex")).toBe(entry.checksum);
    }
  });

  it("lists only additive SQL: new tables, and indexes and triggers on those new tables", () => {
    for (const entry of forwardCompatibleMigrations()) {
      const sql = fixtureSql(entry.filename).replace(/--[^\n]*/gu, "");
      const statements = sql
        .split(/;\s*(?=CREATE\b|$)/iu)
        .map((statement) => statement.trim())
        .filter(Boolean);
      const created = new Set(
        [...sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)/giu)].map((match) => match[1]!.toLowerCase())
      );
      expect(created.size).toBeGreaterThan(0);
      for (const statement of statements) {
        expect(statement, entry.filename).toMatch(/^CREATE (TABLE|INDEX|TRIGGER) IF NOT EXISTS\b/iu);
        const target = /\bON\s+(\w+)/iu.exec(statement)?.[1]?.toLowerCase();
        if (/^CREATE (INDEX|TRIGGER)/iu.test(statement)) {
          expect(created.has(target ?? ""), `${entry.filename}: ${statement.slice(0, 60)}`).toBe(true);
        }
      }
    }
  });

  it("keeps a database with a listed migration healthy", () => {
    const path = migratedDatabase();
    for (const entry of forwardCompatibleMigrations()) applyLater(path, entry, fixtureSql(entry.filename));
    const health = inspectControlPlaneDatabaseFile(path);
    expect(health.checks.migrations).toEqual({ ok: true });
    expect(health.ok).toBe(true);
  });

  it("reopens and re-applies this release's migrations over a database with a listed migration", () => {
    const path = migratedDatabase();
    for (const entry of forwardCompatibleMigrations()) applyLater(path, entry, fixtureSql(entry.filename));
    const db = new DatabaseSync(path);
    applyControlPlaneMigrations(db);
    db.close();
    expect(inspectControlPlaneDatabaseFile(path).ok).toBe(true);
  });

  it.each([
    ["a different checksum", { checksum: "0".repeat(64) }],
    ["a different name", { name: "retry_fence_renamed" }],
    ["a different filename", { filename: "083_other.sql" }],
    ["an unlisted version", { version: 84, filename: "084_retry_fence_cleanup_evidence.sql" }]
  ])("fails on a later migration row with %s", (_label, change) => {
    const path = migratedDatabase();
    const entry = forwardCompatibleMigrations()[0]!;
    applyLater(path, { ...entry, ...change }, fixtureSql(entry.filename));
    expect(inspectControlPlaneDatabaseFile(path).checks.migrations).toEqual({ ok: false, code: "migration_mismatch" });
  });

  it("fails on an unknown row that fills a gap below the highest shipped version", () => {
    const path = migratedDatabase();
    const shipped = new Set(controlPlaneMigrations().map((migration) => migration.version));
    const gap = [...Array(Math.max(...shipped)).keys()]
      .map((index) => index + 1)
      .find((version) => !shipped.has(version));
    expect(gap).toBeDefined();
    applyLater(
      path,
      {
        version: gap!,
        name: "foreign_lineage",
        filename: `${String(gap).padStart(3, "0")}_foreign_lineage.sql`,
        checksum: "1".repeat(64)
      },
      "SELECT 1;"
    );
    expect(inspectControlPlaneDatabaseFile(path).checks.migrations).toEqual({ ok: false, code: "migration_mismatch" });
  });

  it("still reports a missing shipped migration as missing", () => {
    const path = migratedDatabase();
    const db = new DatabaseSync(path);
    db.prepare("DELETE FROM schema_migrations WHERE version = (SELECT MAX(version) FROM schema_migrations)").run();
    db.close();
    expect(inspectControlPlaneDatabaseFile(path).checks.migrations).toEqual({ ok: false, code: "migration_missing" });
  });
});
