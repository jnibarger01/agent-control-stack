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
  { version: 7, name: "workspace_allocations", filename: "007_workspace_allocations.sql" },
  { version: 8, name: "scheduler_firings", filename: "008_scheduler_firings.sql" },
  { version: 9, name: "temporal_memory", filename: "009_temporal_memory.sql" },
  { version: 10, name: "grok_pi_registry", filename: "010_grok_pi_registry.sql" },
  { version: 11, name: "scheduler_firing_legacy_markers", filename: "011_scheduler_firing_legacy_markers.sql" },
  { version: 12, name: "attempt_workspace_ownership", filename: "012_attempt_workspace_ownership.sql" },
  { version: 13, name: "actor_routing", filename: "013_actor_routing.sql" },
  { version: 14, name: "validation_runs", filename: "014_validation_runs.sql" },
  { version: 15, name: "recovery_records", filename: "015_recovery_records.sql" },
  { version: 16, name: "publication_records", filename: "016_publication_records.sql" }
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
  for (const migration of controlPlaneMigrations()) {
    // The "already applied?" question is answered fresh inside this
    // migration's own transaction, after BEGIN IMMEDIATE's write lock is
    // actually held - not from a snapshot taken before the loop started.
    // Two processes racing a fresh database both reach this point believing
    // a migration is unapplied; only one gets the lock first, and the
    // other must re-check rather than blindly re-INSERT once it wakes up,
    // or it hits a UNIQUE violation on schema_migrations.version and the
    // whole startup crashes instead of just no-op'ing past what its rival
    // already committed.
    db.exec("BEGIN IMMEDIATE");
    try {
      const existing = queryMigrationRow(db, migration.version);
      if (existing) {
        if (existing.name !== migration.name || existing.filename !== migration.filename) {
          throw new Error(`migration metadata mismatch for version ${migration.version}`);
        }
        // Deployed databases may carry an older checksum for the workspace_allocations
        // migration (version 7) from before its schema was extended; accept that one
        // known legacy checksum instead of treating it as drift.
        const legacyWorkspaceMigration =
          migration.version === 7 &&
          existing.checksum === "c7b213f900a6f8b06c4155665f60ee7d3127fd60f75a2583ed6088c86f3f7cf4";
        if (existing.checksum && existing.checksum !== migration.checksum && !legacyWorkspaceMigration) {
          throw new Error(`migration checksum mismatch for version ${migration.version}`);
        }
        if (!existing.checksum) {
          db.prepare(`UPDATE schema_migrations SET checksum = ? WHERE version = ?`).run(
            migration.checksum,
            migration.version
          );
        }
        db.exec("COMMIT");
        continue;
      }

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
  if (migration.version === 12 && hasColumn(db, "workspace_allocations", "attempt_id")) {
    return "SELECT 1;";
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

function queryMigrationRow(
  db: SqliteLike,
  version: number
): { version: number; name: string; filename: string; checksum: string } | undefined {
  return db
    .prepare(`SELECT version, name, filename, checksum FROM schema_migrations WHERE version = ?`)
    .get(version) as { version: number; name: string; filename: string; checksum: string } | undefined;
}
