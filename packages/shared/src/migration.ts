import { readFileSync } from "node:fs";

const migrationsDir = new URL("../../../storage/migrations/", import.meta.url);

export interface ControlPlaneMigration {
  version: number;
  name: string;
  filename: string;
  sql: string;
}

interface SqliteLike {
  exec(sql: string): void;
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    run(...params: unknown[]): unknown;
  };
}

const migrationFiles = [
  { version: 1, name: "audit_log", filename: "001_audit_log.sql" },
  { version: 2, name: "agent_registry", filename: "002_agent_registry.sql" },
  { version: 3, name: "event_indexes", filename: "003_event_indexes.sql" }
] as const;

export function controlPlaneMigrations(): ControlPlaneMigration[] {
  return migrationFiles.map((migration) => ({
    ...migration,
    sql: readFileSync(new URL(migration.filename, migrationsDir), "utf8")
  }));
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
      applied_at TEXT NOT NULL
    );
  `);
  const applied = new Set(
    (db.prepare(`SELECT version FROM schema_migrations`).all() as Array<{ version: number }>).map((row) => row.version)
  );

  for (const migration of controlPlaneMigrations()) {
    if (applied.has(migration.version)) {
      continue;
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.sql);
      db
        .prepare(
          `INSERT INTO schema_migrations (version, name, filename, applied_at)
           VALUES (?, ?, ?, ?)`
        )
        .run(migration.version, migration.name, migration.filename, new Date().toISOString());
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
