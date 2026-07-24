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
  { version: 3, name: "event_indexes", filename: "003_event_indexes.sql" },
  { version: 4, name: "state_constraints", filename: "004_state_constraints.sql" },
  { version: 5, name: "execution_results_and_lineage", filename: "005_execution_results_and_lineage.sql" },
  { version: 6, name: "execution_plans_and_attempts", filename: "006_execution_plans_and_attempts.sql" },
  { version: 7, name: "workspace_allocations", filename: "007_workspace_allocations.sql" }
] as const;

export function controlPlaneMigrations(): ControlPlaneMigration[] {
  return migrationFiles.map((migration) => {
    const sql = readFileSync(new URL(migration.filename, migrationsDir), "utf8");
    return { ...migration, sql, checksum: createHash("sha256").update(sql).digest("hex") };
  });
}

export function controlPlaneMigrationSql(): string {
  return controlPlaneMigrations()
    .map((migration) => migration.sql)
    .join("\n");
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
    (
      db.prepare(`SELECT version, name, filename, checksum FROM schema_migrations`).all() as Array<{
        version: number;
        name: string;
        filename: string;
        checksum: string;
      }>
    ).map((row) => [row.version, row])
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
        db.prepare(`UPDATE schema_migrations SET checksum = ? WHERE version = ?`).run(
          migration.checksum,
          migration.version
        );
      }
      continue;
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migrationSqlForCurrentSchema(db, migration));
      db.prepare(
        `INSERT INTO schema_migrations (version, name, filename, checksum, applied_at)
           VALUES (?, ?, ?, ?, ?)`
      ).run(migration.version, migration.name, migration.filename, migration.checksum, new Date().toISOString());
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
  if (migration.version === 4) {
    validateStateConstraintPreflight(db);
  }
  if (migration.version === 5) {
    validateExecutionResultPreflight(db);
  }
  if (migration.version === 6) {
    validateExecutionPlanPreflight(db);
  }
  return migration.sql;
}

function validateExecutionPlanPreflight(db: SqliteLike): void {
  const invalid = queryRows(
    db,
    `SELECT id FROM work_items
     WHERE status IS NULL OR status NOT IN (
       'draft', 'pending_policy', 'needs_approval', 'approved', 'running',
       'succeeded', 'failed', 'blocked', 'cancelled', 'rejected'
     )`
  );
  if (invalid.length > 0) {
    throw new Error(`execution plan migration refused invalid work item state: ${invalid.slice(0, 50).join(", ")}`);
  }
}

function validateExecutionResultPreflight(db: SqliteLike): void {
  const running = queryRows(
    db,
    `SELECT id FROM work_items
     WHERE status = 'running'
        OR lease_token_hash IS NOT NULL
        OR lease_expires_at IS NOT NULL`
  );
  if (running.length > 0) {
    throw new Error(
      `execution result migration refused legacy active lease state; reconcile explicitly: ${running
        .slice(0, 50)
        .join(", ")}`
    );
  }
}

function validateStateConstraintPreflight(db: SqliteLike): void {
  const invalidQueries = [
    {
      label: "work_items",
      sql: `SELECT id FROM work_items
            WHERE status IS NULL OR status NOT IN ('draft', 'pending_policy', 'needs_approval', 'approved', 'running', 'succeeded', 'failed', 'blocked', 'cancelled', 'rejected')
               OR risk IS NULL OR risk NOT IN ('low', 'medium', 'high', 'critical')
               OR target_json IS NULL OR json_valid(target_json) = 0
               OR requested_actions_json IS NULL OR json_valid(requested_actions_json) = 0
               OR (result_json IS NOT NULL AND json_valid(result_json) = 0)`
    },
    {
      label: "approval_records",
      sql: `SELECT work_item_id || ':' || action_hash AS id FROM approval_records
            WHERE status IS NULL OR status NOT IN ('granted', 'consumed')`
    },
    {
      label: "connector_records",
      sql: `SELECT id FROM connector_records
            WHERE status IS NULL OR status NOT IN ('active', 'revoked')
               OR allowed_scopes_json IS NULL OR json_valid(allowed_scopes_json) = 0`
    },
    {
      label: "tunnel_sessions",
      sql: `SELECT session_id AS id FROM tunnel_sessions
            WHERE status IS NULL OR status NOT IN ('active', 'revoked')`
    },
    {
      label: "actors",
      sql: `SELECT id FROM actors
            WHERE actor_type IS NULL OR actor_type NOT IN ('HUMAN', 'SYSTEM', 'AGENT', 'SERVICE')`
    },
    {
      label: "agents",
      sql: `SELECT id FROM agents
            WHERE status IS NULL OR status NOT IN ('UNKNOWN', 'AVAILABLE', 'BUSY', 'DEGRADED', 'OFFLINE', 'ERROR')`
    },
    {
      label: "heartbeats",
      sql: `SELECT id FROM heartbeats
            WHERE status IS NULL OR status NOT IN ('UNKNOWN', 'AVAILABLE', 'BUSY', 'DEGRADED', 'OFFLINE', 'ERROR')`
    },
    {
      label: "capabilities",
      sql: `SELECT id FROM capabilities
            WHERE input_schema IS NOT NULL AND json_valid(input_schema) = 0`
    },
    {
      label: "audit_events",
      sql: `SELECT id FROM audit_events
            WHERE attributes IS NULL OR json_valid(attributes) = 0
               OR body IS NULL OR json_valid(body) = 0`
    }
  ];

  for (const query of invalidQueries) {
    const rows = queryRows(db, query.sql);
    if (rows.length > 0) {
      throw new Error(
        `state constraints migration refused invalid ${query.label} rows: ${rows.slice(0, 50).join(", ")}`
      );
    }
  }
}

function queryRows(db: SqliteLike, sql: string): string[] {
  return (db.prepare(sql).all() as Array<Record<string, unknown>>).map((row) => String(Object.values(row)[0]));
}

function hasColumn(db: SqliteLike, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}
