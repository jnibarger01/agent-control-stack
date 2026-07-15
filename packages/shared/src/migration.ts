import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const migrationsDir = new URL("../../../storage/migrations/", import.meta.url);

export interface ControlPlaneMigration {
  version: number;
  name: string;
  filename: string;
  sql: string;
  checksum: string;
}

interface SqliteLike {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
  };
}

const migrationFiles = [
  { version: 1, name: "audit_log", filename: "001_audit_log.sql" },
  { version: 2, name: "agent_registry", filename: "002_agent_registry.sql" },
  { version: 3, name: "event_indexes", filename: "003_event_indexes.sql" }
] as const;

export function controlPlaneMigrations(): ControlPlaneMigration[] {
  return migrationFiles.map((migration) => {
    const sql = readFileSync(new URL(migration.filename, migrationsDir), "utf8");
    return { ...migration, sql, checksum: createHash("sha256").update(sql).digest("hex") };
  });
}

export function controlPlaneMigrationSql(): string {
  return controlPlaneMigrations().map((migration) => migration.sql).join("\n");
}

export function applyControlPlaneMigrations(db: SqliteLike): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      filename TEXT NOT NULL,
      checksum TEXT NOT NULL DEFAULT '',
      applied_at TEXT NOT NULL
    );
  `);
  if (!hasColumn(db, "schema_migrations", "checksum")) {
    db.exec(`ALTER TABLE schema_migrations ADD COLUMN checksum TEXT NOT NULL DEFAULT ''`);
  }
  const applied = new Map(
    (db.prepare(`SELECT version, name, filename, checksum FROM schema_migrations`).all() as Array<{
      version: number;
      name: string;
      filename: string;
      checksum: string;
    }>).map((row) => [row.version, row])
  );

  for (const migration of controlPlaneMigrations()) {
    const existing = applied.get(migration.version);
    if (existing) {
      if (existing.name !== migration.name || existing.filename !== migration.filename) {
        throw new Error(`migration metadata mismatch for version ${migration.version}`);
      }
      if (existing.checksum && existing.checksum !== migration.checksum) {
        throw new Error(`migration checksum mismatch for version ${migration.version}`);
      }
      if (!existing.checksum) {
        db.prepare(`UPDATE schema_migrations SET checksum = ? WHERE version = ?`).run(migration.checksum, migration.version);
      }
      continue;
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migrationSqlForCurrentSchema(db, migration));
      db
        .prepare(
          `INSERT INTO schema_migrations (version, name, filename, checksum, applied_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(migration.version, migration.name, migration.filename, migration.checksum, new Date().toISOString());
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // best effort; SQLite may have already closed the transaction.
      }
      throw error;
    }
  }
}

function migrationSqlForCurrentSchema(db: SqliteLike, migration: ControlPlaneMigration): string {
  if (migration.version === 3 && hasColumn(db, "work_items", "requester_subject")) {
    return migration.sql.replace(/^\s*ALTER TABLE work_items ADD COLUMN requester_subject TEXT;\s*/u, "");
  }
  return migration.sql;
}

function hasColumn(db: SqliteLike, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}
