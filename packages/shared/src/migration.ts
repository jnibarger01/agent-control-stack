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

/**
 * Non-canonical fixture-only migrations.
 *
 * `storage/migrations/` also contains files whose numeric prefix duplicates a
 * canonical migration:
 *
 *   - 037_execution_results_idempotency_unique.sql
 *   - 038_admission_permits.sql
 *
 * These are deliberately NOT registered in `migrationFiles` and must not be added
 * to the canonical migration order merely because of their filename prefix. They
 * exist only so migration recovery tests can reconstruct an earlier lineage in
 * which this SQL shipped under versions 37 and 38 instead of the canonical
 * 038_execution_results_idempotency_unique.sql and 039_admission_permits.sql.
 *
 * Do not renumber or edit them: a deployed database records their checksum, so
 * changing their bytes would invalidate the recovery identity of every database
 * already running that lineage. Document them here rather than in the files.
 */
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
  { version: 16, name: "publication_records", filename: "016_publication_records.sql" },
  {
    version: 17,
    name: "scheduler_firing_callback_pending",
    filename: "017_scheduler_firing_callback_pending.sql"
  },
  { version: 18, name: "attempt_lease_approvals", filename: "018_attempt_lease_approvals.sql" },
  { version: 19, name: "work_item_metadata", filename: "019_work_item_metadata.sql" },
  { version: 20, name: "lease_renewal", filename: "020_lease_renewal.sql" },
  {
    version: 21,
    name: "desktop_commander_execution_mode",
    filename: "021_desktop_commander_execution_mode.sql"
  },
  {
    version: 22,
    name: "advisory_evidence_and_verification",
    filename: "022_advisory_evidence_and_verification.sql"
  },
  { version: 23, name: "device_auth", filename: "023_device_auth.sql" },
  {
    version: 24,
    name: "desktop_commander_runtime_capabilities",
    filename: "024_desktop_commander_runtime_capabilities.sql"
  },
  { version: 25, name: "device_auth_hardening", filename: "025_device_auth_hardening.sql" },
  {
    version: 26,
    name: "desktop_commander_capability_uniqueness",
    filename: "026_desktop_commander_capability_uniqueness.sql"
  },
  { version: 27, name: "execution_mode", filename: "027_execution_mode.sql" },
  { version: 28, name: "jace_commander_capabilities", filename: "028_jace_commander_capabilities.sql" },
  { version: 29, name: "jace_commander_tool_allowlist", filename: "029_jace_commander_tool_allowlist.sql" },
  { version: 30, name: "jace_commander_search_tools", filename: "030_jace_commander_search_tools.sql" },
  { version: 31, name: "jace_commander_operations", filename: "031_jace_commander_operations.sql" },
  { version: 32, name: "trace_outbox", filename: "032_trace_outbox.sql" },
  { version: 33, name: "jace_commander_execution_results", filename: "033_jace_commander_execution_results.sql" },
  { version: 34, name: "jev_observation_outbox", filename: "034_jev_observation_outbox.sql" },
  { version: 35, name: "work_item_queue_index", filename: "035_work_item_queue_index.sql" },
  { version: 36, name: "muse_agent", filename: "036_muse_agent.sql" },
  { version: 37, name: "jc_reusable_work_item_index", filename: "037_jc_reusable_work_item_index.sql" },
  {
    version: 38,
    name: "execution_results_idempotency_unique",
    filename: "038_execution_results_idempotency_unique.sql"
  },
  {
    version: 39,
    name: "jace_commander_admin_approvals",
    filename: "039_jace_commander_admin_approvals.sql"
  },
  {
    version: 40,
    name: "admission_permits",
    filename: "040_admission_permits.sql"
  },
  {
    version: 41,
    name: "admission_permit_execution_class",
    filename: "041_admission_permit_execution_class.sql"
  },
  { version: 42, name: "change_sets", filename: "042_change_sets.sql" },
  { version: 43, name: "work_item_assignments", filename: "043_work_item_assignments.sql" },
  {
    version: 44,
    name: "migration_lineage_reconciliation",
    filename: "044_migration_lineage_reconciliation.sql"
  },
  { version: 45, name: "change_set_approvals", filename: "045_change_set_approvals.sql" },
  { version: 46, name: "change_set_operation_permits", filename: "046_change_set_operation_permits.sql" },
  { version: 47, name: "autonomous_authority", filename: "047_autonomous_authority.sql" },
  { version: 48, name: "operation_permit_grant_authority", filename: "048_operation_permit_grant_authority.sql" },
  { version: 49, name: "coding_missions", filename: "049_coding_missions.sql" },
  { version: 50, name: "authoritative_routing", filename: "050_authoritative_routing.sql" },
  { version: 51, name: "jace_commander_universal_admin", filename: "051_jace_commander_universal_admin.sql" },
  { version: 52, name: "admin_mode_sticky_marker", filename: "052_admin_mode_sticky_marker.sql" },
  { version: 53, name: "routing_shadow_observations", filename: "053_routing_shadow_observations.sql" },
  { version: 54, name: "mission_runtime_generalization", filename: "054_mission_runtime_generalization.sql" },
  { version: 55, name: "work_unit_execution_contract", filename: "055_work_unit_execution_contract.sql" },
  { version: 56, name: "route_decision_enrichment", filename: "056_route_decision_enrichment.sql" },
  { version: 57, name: "work_unit_verification_authority", filename: "057_work_unit_verification_authority.sql" },
  { version: 58, name: "work_unit_verification_run_fencing", filename: "058_work_unit_verification_run_fencing.sql" },
  {
    version: 59,
    name: "work_unit_verification_terminal_restore",
    filename: "059_work_unit_verification_terminal_restore.sql"
  }
] as const;

export function controlPlaneMigrations(): ControlPlaneMigration[] {
  return migrationFiles.map((migration) => {
    const sql = readFileSync(new URL(migration.filename, migrationsDir), "utf8");
    return { ...migration, sql, checksum: createHash("sha256").update(sql).digest("hex") };
  });
}

/**
 * Hash a migration SQL file using the same function as `controlPlaneMigrations`.
 *
 * Recovery metadata must have exactly one source of truth. Pinning literal
 * checksums in recovery code created a second table that had to be edited every
 * time a canonical migration file changed, which could brick recovery. Callers
 * pass a filename and always receive the checksum of the SQL that ships in the
 * repository, so drift detection still compares a recorded checksum against the
 * authoritative file.
 */
/**
 * Checksums of migration SQL that a previous release deployed but which the
 * repository no longer ships verbatim: the files were either deleted outright or
 * later edited under the same version number. Recovery compares recorded rows
 * against these values because the content they describe cannot be recomputed from
 * any file in `storage/migrations/`.
 *
 * This block is the only place a historical checksum may be pinned. Checksums for
 * SQL that still ships are always derived from the file itself, so editing a
 * migration never requires updating a second table.
 */
const LEGACY_MIGRATION_CHECKSUM_V7_WORKSPACE_ALLOCATIONS =
  "c7b213f900a6f8b06c4155665f60ee7d3127fd60f75a2583ed6088c86f3f7cf4";

const LEGACY_SUPERSEDED_MIGRATION_CHECKSUMS = {
  "017_desktop_commander_execution_mode.sql": "aedd1140975cd1a9197df06f1dbd9906b8b3ab143b4025bcc2e4ba0e758f5d43",
  "018_advisory_evidence_and_verification.sql": "456755abba99bae8a282b1f0544b4f0e798f57a27d4e717ec4b28ba79d4a9f7d",
  "019_scheduler_firing_callback_pending.sql": "51bc791cc466b83d6e80dccd10ab077dd37118899d860e2e53cf6d187fec9124",
  "020_attempt_lease_approvals.sql": "dc9481337e06d8c6a118883d6e8f656be6e8c0321b44a952936d81e18a552f7c",
  "021_work_item_metadata.sql": "65b2abe0bd8b6bd15723b656fa0ddd62359adf02d65d0239742a950f1c37da9e",
  "022_device_auth.sql": "a6527d63c1a6c3549c6c2a69b6b255be0dea751b70c3a4227f67e1deab1883e3",
  "023_desktop_commander_runtime_capabilities.sql": "5aae973d05b6bca6e0f6157eaa739a570c8e6dd19116f89a8e7fbfc82470059a",
  "020_desktop_commander_execution_mode.sql": "23c5d1ce662f032aa88df3ccf6a810fe0c08ef4ead22787365401befd39109fe",
  "021_advisory_evidence_and_verification.sql": "0a530ca728bda97f7aedfa1ff89e2ae9a70cc0313d5208a5e7ca1089d7fc80a2",
  /**
   * The 37/38 recovery lineage shipped from these fixture files. Their recorded
   * checksums are part of the identity of databases that were actually deployed, so
   * recovery accepts them in addition to the checksum derived from the file. Without
   * this, any later edit to either fixture file would change the derived value and
   * brick every database already recorded against it.
   */
  "037_execution_results_idempotency_unique.sql": "956ee37aed0a4466fb5a128123398e3ecb8cad3a202224205cbaa83ef7ed8545",
  "038_admission_permits.sql": "11dbde427fe5d3b3fad1fc1fb1d735bc29b18eb59a3b04cb9c1ee82b6e3e2de5",
  /**
   * Release 464d54b recorded the lineage marker at version 43. Its SQL differs from the shipped
   * 044 file only in the version number inside the first comment line, so the effect is identical.
   */
  "043_migration_lineage_reconciliation.sql": "17d881e7033b4cbd33e1f2b55aefe4e1ae91a0314e8b4b8724a7d46a1fce3c2c"
} as const;

/** Historical checksum for an already-released migration that the repository no longer ships verbatim. */
function legacyMigrationChecksum(key: keyof typeof LEGACY_SUPERSEDED_MIGRATION_CHECKSUMS): string {
  return LEGACY_SUPERSEDED_MIGRATION_CHECKSUMS[key];
}

function migrationFileChecksum(filename: string): string {
  const sql = readFileSync(new URL(filename, migrationsDir), "utf8");
  return createHash("sha256").update(sql).digest("hex");
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
  if (initializePristineDatabase(db)) return;
  repairExactAlternateSeventeenToTwentyOneLayout(db);
  repairExactPreLeaseRenewalTwentyToTwentyThreeLayout(db);
  repairExactRecoveryThirtySevenThirtyEightLayout(db);
  repairExactDeployedThirtyNineFortySevenLayout(db);
  // Migration 057 quarantines terminal units and 059 restores them. Treat
  // 057–059 as ONE write transaction: another connection must never be able
  // to retry a quarantined unit after 057 but before 059 restores its state.
  // Existing 057 installations remain ambiguous and require the guard below.
  const appliedDuringThisUpgrade = new Set<number>();
  let verificationUpgradeLockHeld = false;
  for (const migration of controlPlaneMigrations()) {
    // All existing-row checks happen while holding BEGIN IMMEDIATE. Other
    // migration versions keep their usual per-migration transaction, but
    // 057–059 share one lock through the final 059 restoration and commit.
    const verificationWindow = migration.version >= 57 && migration.version <= 59;
    if (!verificationUpgradeLockHeld) {
      db.exec("BEGIN IMMEDIATE");
      if (verificationWindow) verificationUpgradeLockHeld = true;
    }
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
          migration.version === 7 && existing.checksum === LEGACY_MIGRATION_CHECKSUM_V7_WORKSPACE_ALLOCATIONS;
        if (existing.checksum && existing.checksum !== migration.checksum && !legacyWorkspaceMigration) {
          throw new Error(`migration checksum mismatch for version ${migration.version}`);
        }
        if (!existing.checksum) {
          db.prepare(`UPDATE schema_migrations SET checksum = ? WHERE version = ?`).run(
            migration.checksum,
            migration.version
          );
        }
        if (!verificationWindow || migration.version === 59) {
          db.exec("COMMIT");
          verificationUpgradeLockHeld = false;
        }
        continue;
      }

      if (migration.version === 59 && !appliedDuringThisUpgrade.has(57)) {
        const ambiguous = queryRows(
          db,
          `SELECT q.mission_id || ':' || q.unit_id AS id
           FROM work_unit_verification_quarantine q
           JOIN coding_operations o
             ON o.mission_id = q.mission_id AND o.operation_id = q.unit_id
           WHERE q.reason = 'migration_057_missing_verification_authority'
             AND q.previous_status IN ('succeeded', 'cancelled')
             AND o.status = 'failed' AND o.failure_category = 'verification_failure'
           ORDER BY q.mission_id, q.unit_id LIMIT 50`
        );
        if (ambiguous.length > 0) {
          throw new Error(
            `migration 059 refused ambiguous terminal restoration after a prior 057 upgrade; ` +
              `review work-unit attempts and events before manual reconciliation: ${ambiguous.join(", ")}`
          );
        }
      }
      db.exec(migrationSqlForCurrentSchema(db, migration));
      db.prepare(
        `INSERT INTO schema_migrations (version, name, filename, checksum, applied_at)
           VALUES (?, ?, ?, ?, ?)`
      ).run(migration.version, migration.name, migration.filename, migration.checksum, new Date().toISOString());
      if (!verificationWindow || migration.version === 59) {
        db.exec("COMMIT");
        verificationUpgradeLockHeld = false;
      }
      appliedDuringThisUpgrade.add(migration.version);
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // best effort; SQLite may have already closed the transaction.
      }
      throw error;
    }
  }
  if (verificationUpgradeLockHeld) {
    db.exec("ROLLBACK");
    throw new Error("migration 057–059 writer lock was not released after migration 059");
  }
}

/**
 * Release 464d54b recorded admission permits at version 39 through operation-permit grant authority at 47.
 * Main later reserved 39 for JC admin approvals and moved those migrations to 40-48. A database written by
 * that release is recognised only by this exact layout (a contiguous prefix of it, each row matching the
 * shipped SQL under its new number) and renumbered in one transaction; applied_at is preserved, and the
 * missing 39 and later migrations then run through the ordinary loop. Anything else fails closed.
 */
const DEPLOYED_THIRTY_NINE_LAYOUT = [
  [39, 40, "admission_permits"],
  [40, 41, "admission_permit_execution_class"],
  [41, 42, "change_sets"],
  [42, 43, "work_item_assignments"],
  [43, 44, "migration_lineage_reconciliation"],
  [44, 45, "change_set_approvals"],
  [45, 46, "change_set_operation_permits"],
  [46, 47, "autonomous_authority"],
  [47, 48, "operation_permit_grant_authority"]
] as const;

function repairExactDeployedThirtyNineFortySevenLayout(db: SqliteLike): void {
  const isDeployedLayout = () => queryMigrationRow(db, 39)?.filename === "039_admission_permits.sql";
  if (!isDeployedLayout()) return;
  const canonical = new Map(controlPlaneMigrations().map((migration) => [migration.version, migration]));
  const fail: (detail: string) => never = (detail) => {
    throw new Error(`deployed migration layout ${detail}`);
  };
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!isDeployedLayout()) {
      db.exec("COMMIT");
      return;
    }
    const matched: Array<{ from: number; to: ControlPlaneMigration }> = [];
    for (const [from, toVersion, name] of DEPLOYED_THIRTY_NINE_LAYOUT) {
      const row = queryMigrationRow(db, from);
      const target = canonical.get(toVersion);
      if (!row) break;
      const filename = `${String(from).padStart(3, "0")}_${name}.sql`;
      const released = (LEGACY_SUPERSEDED_MIGRATION_CHECKSUMS as Record<string, string>)[filename];
      if (
        !target ||
        target.name !== name ||
        row.name !== name ||
        row.filename !== filename ||
        (row.checksum !== target.checksum && row.checksum !== released)
      ) {
        fail("metadata mismatch");
      }
      matched.push({ from, to: target });
    }
    const last = matched[matched.length - 1]?.from ?? 38;
    if (db.prepare("SELECT version FROM schema_migrations WHERE version > ?").all(last).length > 0) {
      fail("has a gap or unexpected later metadata");
    }
    // Metadata is only a claim about the schema. Before any row is renumbered, prove structurally that every
    // object each recorded migration creates is present, and that no object of an unrecorded one already exists
    // (a partial layout would make the ordinary loop collide on its CREATE statements after the rewrite).
    const schemaProblem = deployedLayoutSchemaProblem(db, last);
    if (schemaProblem) fail(`schema validation failed: ${schemaProblem}`);
    // Highest first so each UPDATE lands on a free primary key.
    for (const { from, to } of [...matched].reverse()) {
      db.prepare(`UPDATE schema_migrations SET version = ?, filename = ?, checksum = ? WHERE version = ?`).run(
        to.version,
        to.filename,
        to.checksum,
        from
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* SQLite may already have rolled back. */
    }
    throw error;
  }
}

interface DeployedSchemaExpectation {
  columns?: Record<string, readonly string[]>;
  triggers?: readonly string[];
  indexes?: readonly string[];
}

const APPEND_ONLY = (table: string) => [`${table}_no_update`, `${table}_no_delete`];

/** What each deployed migration (keyed by its deployed version) must have created. */
const DEPLOYED_SCHEMA: Record<number, DeployedSchemaExpectation> = {
  39: {
    columns: {
      admission_permits: [
        "attempt_id",
        "work_item_id",
        "lease_id",
        "worker_id",
        "fencing_epoch",
        "action_hash",
        "plan_hash",
        "input_hash",
        "lane",
        "created_at"
      ]
    },
    indexes: ["idx_admission_permits_lease", "idx_admission_permits_work_item"]
  },
  40: { columns: { admission_permits: ["execution_class"] } },
  41: {
    columns: {
      change_set_revisions: [
        "mission_id",
        "revision",
        "submission_id",
        "manifest_hash",
        "audit_event_id",
        "parent_manifest_hash",
        "snapshot_json",
        "created_by_actor_id",
        "created_at"
      ],
      change_set_heads: ["mission_id", "revision", "manifest_hash"]
    },
    triggers: APPEND_ONLY("change_set_revisions")
  },
  42: {
    columns: {
      work_item_assignments: [
        "work_item_id",
        "selected_worker_id",
        "selected_agent_id",
        "routing_decision_id",
        "assigned_by_actor_id",
        "assigned_at"
      ]
    },
    indexes: ["work_item_assignments_worker_idx"]
  },
  43: {},
  44: {
    columns: {
      change_set_approvals: [
        "approval_id",
        "mission_id",
        "revision",
        "manifest_hash",
        "request_id",
        "record_json",
        "approval_hash",
        "audit_event_id"
      ],
      change_set_approval_revocations: ["approval_id", "revoked_by_actor_id", "reason", "audit_event_id"]
    },
    triggers: [...APPEND_ONLY("change_set_approvals"), ...APPEND_ONLY("change_set_approval_revocations")]
  },
  45: {
    columns: {
      change_set_operation_permits: [
        "permit_id",
        "mission_id",
        "revision",
        "manifest_hash",
        "operation_id",
        "approval_id",
        "execution_work_item_id",
        "record_json",
        "permit_hash",
        "audit_event_id"
      ]
    },
    triggers: APPEND_ONLY("change_set_operation_permits")
  },
  46: {
    columns: {
      autonomous_authority_grants: [
        "grant_id",
        "mission_id",
        "request_id",
        "record_json",
        "grant_hash",
        "audit_event_id"
      ],
      autonomous_authority_revocations: ["grant_id", "actor_id", "reason", "audit_event_id"],
      change_set_grant_authorizations: [
        "authorization_id",
        "grant_id",
        "mission_id",
        "revision",
        "manifest_hash",
        "record_json",
        "authorization_hash",
        "audit_event_id"
      ]
    },
    triggers: [
      ...APPEND_ONLY("autonomous_authority_grants"),
      ...APPEND_ONLY("autonomous_authority_revocations"),
      ...APPEND_ONLY("change_set_grant_authorizations")
    ]
  },
  47: {
    columns: { change_set_operation_permits: ["authorization_id"] },
    indexes: ["change_set_operation_permits_authorization"]
  }
};

/** Tables and columns that only exist once the named deployed migration has run. */
const DEPLOYED_INTRODUCES: Record<number, { tables?: readonly string[]; columns?: Record<string, string> }> = {
  40: { columns: { admission_permits: "execution_class" } },
  41: { tables: ["change_set_revisions", "change_set_heads"] },
  42: { tables: ["work_item_assignments"] },
  44: { tables: ["change_set_approvals", "change_set_approval_revocations"] },
  45: { tables: ["change_set_operation_permits"] },
  46: {
    tables: ["autonomous_authority_grants", "autonomous_authority_revocations", "change_set_grant_authorizations"]
  },
  47: { columns: { change_set_operation_permits: "authorization_id" } }
};

function hasSchemaObject(db: SqliteLike, type: "trigger" | "index", name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?").get(type, name));
}

/**
 * Returns why the schema does not match a deployed layout whose last recorded version is `last`, or undefined when
 * every recorded migration's objects are present and no unrecorded migration's objects exist yet.
 */
function deployedLayoutSchemaProblem(db: SqliteLike, last: number): string | undefined {
  for (let version = 39; version <= last; version += 1) {
    const expected = DEPLOYED_SCHEMA[version];
    if (!expected) return `no schema expectation for deployed migration ${version}`;
    for (const [table, columns] of Object.entries(expected.columns ?? {})) {
      if (!hasTable(db, table)) return `missing table ${table} (deployed migration ${version})`;
      for (const column of columns) {
        if (!hasColumn(db, table, column)) return `missing column ${table}.${column} (deployed migration ${version})`;
      }
    }
    for (const trigger of expected.triggers ?? []) {
      if (!hasSchemaObject(db, "trigger", trigger)) return `missing trigger ${trigger} (deployed migration ${version})`;
    }
    for (const index of expected.indexes ?? []) {
      if (!hasSchemaObject(db, "index", index)) return `missing index ${index} (deployed migration ${version})`;
    }
  }
  for (let version = last + 1; version <= 47; version += 1) {
    const introduced = DEPLOYED_INTRODUCES[version];
    for (const table of introduced?.tables ?? []) {
      if (hasTable(db, table)) return `table ${table} exists but deployed migration ${version} is not recorded`;
    }
    for (const [table, column] of Object.entries(introduced?.columns ?? {})) {
      if (hasTable(db, table) && hasColumn(db, table, column)) {
        return `column ${table}.${column} exists but deployed migration ${version} is not recorded`;
      }
    }
  }
  if (hasTable(db, "change_set_operation_permits_previous")) {
    return "leftover change_set_operation_permits_previous table from an interrupted rebuild";
  }
  return undefined;
}

/** Initialize only an empty database atomically; upgrades retain per-migration recovery. */
function initializePristineDatabase(db: SqliteLike): boolean {
  // Recheck under the writer lock: another startup may have initialized the same file.
  db.exec("BEGIN IMMEDIATE");
  try {
    const metadata = db.prepare("SELECT version FROM schema_migrations LIMIT 1").all();
    const objects = db
      .prepare("SELECT name FROM sqlite_master WHERE name <> 'schema_migrations' AND name NOT GLOB 'sqlite_*' LIMIT 1")
      .all();
    if (metadata.length > 0 || objects.length > 0) {
      db.exec("ROLLBACK");
      return false;
    }
    for (const migration of controlPlaneMigrations()) {
      db.exec(migrationSqlForCurrentSchema(db, migration));
      db.prepare(
        `INSERT INTO schema_migrations (version, name, filename, checksum, applied_at)
           VALUES (?, ?, ?, ?, ?)`
      ).run(migration.version, migration.name, migration.filename, migration.checksum, new Date().toISOString());
    }
    db.exec("COMMIT");
    return true;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* SQLite may already have rolled back. */
    }
    throw error;
  }
}

/** Reconcile the known recovery and isolated 37-39 layouts without losing schema history. */
function repairExactRecoveryThirtySevenThirtyEightLayout(db: SqliteLike): void {
  if (queryMigrationRow(db, 37)?.filename !== "037_execution_results_idempotency_unique.sql") return;
  const migrations = controlPlaneMigrations();
  const canonical = new Map(migrations.map((migration) => [migration.version, migration]));
  db.exec("BEGIN IMMEDIATE");
  try {
    if (queryMigrationRow(db, 37)?.filename !== "037_execution_results_idempotency_unique.sql") {
      db.exec("COMMIT");
      return;
    }
    // Expected metadata is derived from the migration files themselves. These two
    // filenames are the historical lineage entries recorded by an earlier release;
    // their checksums are computed from those same SQL files so editing a migration
    // never requires editing a second hardcoded checksum table here.
    const historical = (
      [
        [37, "execution_results_idempotency_unique", "037_execution_results_idempotency_unique.sql"],
        [38, "admission_permits", "038_admission_permits.sql"]
      ] as const
    ).map(([version, name, filename]) => ({ version, name, filename, checksum: migrationFileChecksum(filename) }));
    for (const { version, name, filename, checksum } of historical) {
      const row = queryMigrationRow(db, version);
      // Accept the checksum derived from the shipped file, or the released checksum
      // this lineage actually deployed. Both name the same immutable SQL, so neither
      // acceptance weakens drift detection: any other value still fails closed.
      const released = legacyMigrationChecksum(`${filename}`);
      const accepted = row && (row.checksum === checksum || row.checksum === released);
      if (!row || row.name !== name || row.filename !== filename || !accepted) {
        throw new Error("recovery migration layout metadata mismatch");
      }
    }
    const isolatedDuplicate = queryMigrationRow(db, 39);
    // Historical v39 records a second admission-permit base migration. It maps
    // to the canonical v44 lineage marker; canonical v39 admin approvals still
    // run through the normal migration loop.
    const canonicalDuplicate = canonical.get(40);
    if (
      isolatedDuplicate &&
      (isolatedDuplicate.name !== "admission_permits_reconciled" ||
        isolatedDuplicate.filename !== "039_admission_permits.sql" ||
        !canonicalDuplicate ||
        isolatedDuplicate.checksum !== canonicalDuplicate.checksum)
    ) {
      throw new Error("recovery migration layout metadata mismatch");
    }
    const historicalLater = [
      [40, 41, "admission_permit_execution_class", "040_admission_permit_execution_class.sql"],
      [41, 42, "change_sets", "041_change_sets.sql"],
      [42, 43, "work_item_assignments", "042_work_item_assignments.sql"]
    ] as const;
    for (const [historicalVersion, canonicalVersion, name, filename] of historicalLater) {
      const row = queryMigrationRow(db, historicalVersion);
      if (row) {
        const expected = canonical.get(canonicalVersion);
        if (!expected || row.name !== name || row.filename !== filename || row.checksum !== expected.checksum) {
          throw new Error("recovery migration layout metadata mismatch");
        }
        const schemaPresent =
          historicalVersion === 40
            ? hasColumn(db, "admission_permits", "execution_class")
            : historicalVersion === 41
              ? hasTable(db, "change_set_revisions") && hasTable(db, "change_set_heads")
              : [
                  "work_item_id",
                  "selected_worker_id",
                  "selected_agent_id",
                  "routing_decision_id",
                  "assigned_by_actor_id",
                  "assigned_at"
                ].every((column) => hasColumn(db, "work_item_assignments", column));
        if (!schemaPresent) throw new Error("recovery migration layout schema validation failed");
      } else if (
        db.prepare("SELECT version FROM schema_migrations WHERE version > ?").all(historicalVersion).length > 0
      ) {
        throw new Error("recovery migration layout has a gap in later metadata");
      }
    }
    if (db.prepare("SELECT version FROM schema_migrations WHERE version > 42").all().length > 0) {
      throw new Error("recovery migration layout has unexpected later metadata");
    }
    const index = db.prepare("PRAGMA index_list(execution_results)").all() as Array<{
      name: string;
      unique: number;
      partial: number;
    }>;
    const columns = db.prepare("PRAGMA index_info(idx_execution_results_idempotency_key)").all() as Array<{
      name: string;
    }>;
    if (
      !index.some(
        (entry) => entry.name === "idx_execution_results_idempotency_key" && entry.unique === 1 && entry.partial === 0
      ) ||
      columns.length !== 1 ||
      columns[0]?.name !== "idempotency_key" ||
      ![
        "attempt_id",
        "work_item_id",
        "lease_id",
        "worker_id",
        "fencing_epoch",
        "action_hash",
        "plan_hash",
        "input_hash",
        "lane",
        "created_at"
      ].every((column) => hasColumn(db, "admission_permits", column))
    ) {
      throw new Error("recovery migration layout schema validation failed");
    }
    for (let version = 1; version <= 36; version += 1) {
      const row = queryMigrationRow(db, version);
      const migration = canonical.get(version);
      const knownLegacyWorkspace =
        version === 7 && row?.checksum === LEGACY_MIGRATION_CHECKSUM_V7_WORKSPACE_ALLOCATIONS;
      if (
        !row ||
        !migration ||
        row.name !== migration.name ||
        row.filename !== migration.filename ||
        (row.checksum !== migration.checksum && !knownLegacyWorkspace)
      ) {
        throw new Error("recovery migration layout predecessor metadata mismatch");
      }
    }
    db.prepare("UPDATE schema_migrations SET version = version + 100 WHERE version IN (37, 38, 39, 40, 41, 42)").run();
    for (const [oldVersion, newVersion] of [
      [37, 38],
      [38, 40],
      [40, 41],
      [41, 42],
      [42, 43]
    ] as const) {
      const migration = canonical.get(newVersion);
      if (!migration) throw new Error("recovery migration canonical target missing");
      db.prepare(
        "UPDATE schema_migrations SET version = ?, name = ?, filename = ?, checksum = ? WHERE version = ?"
      ).run(newVersion, migration.name, migration.filename, migration.checksum, oldVersion + 100);
    }
    if (isolatedDuplicate) {
      const reconciliation = canonical.get(44);
      if (!reconciliation) throw new Error("canonical lineage reconciliation migration missing");
      db.prepare(
        "UPDATE schema_migrations SET version = ?, name = ?, filename = ?, checksum = ? WHERE version = ?"
      ).run(44, reconciliation.name, reconciliation.filename, reconciliation.checksum, 139);
    }
    applyMigrationInsideRepair(db, canonical, 37);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* no active transaction */
    }
    throw error;
  }
}

/** Repairs only the fully verified deployed alternate 17-21 metadata layout. */
function repairExactAlternateSeventeenToTwentyOneLayout(db: SqliteLike): void {
  // These checksums are pinned deliberately: the SQL files these versions shipped
  // with were deleted when the migrations were superseded under the same version
  // numbers, so their content cannot be derived from the repository. They describe
  // already-deployed databases only.
  const alternate = (
    [
      [
        17,
        "desktop_commander_execution_mode",
        "017_desktop_commander_execution_mode.sql",
        legacyMigrationChecksum("017_desktop_commander_execution_mode.sql")
      ],
      [
        18,
        "advisory_evidence_and_verification",
        "018_advisory_evidence_and_verification.sql",
        legacyMigrationChecksum("018_advisory_evidence_and_verification.sql")
      ],
      [
        19,
        "scheduler_firing_callback_pending",
        "019_scheduler_firing_callback_pending.sql",
        legacyMigrationChecksum("019_scheduler_firing_callback_pending.sql")
      ],
      [
        20,
        "attempt_lease_approvals",
        "020_attempt_lease_approvals.sql",
        legacyMigrationChecksum("020_attempt_lease_approvals.sql")
      ],
      [21, "work_item_metadata", "021_work_item_metadata.sql", legacyMigrationChecksum("021_work_item_metadata.sql")]
    ] as const
  ).map(([version, name, filename, checksum]) => ({ version, name, filename, checksum }));
  const rows = db
    .prepare(
      "SELECT version, name, filename, checksum FROM schema_migrations WHERE version BETWEEN 17 AND 21 ORDER BY version"
    )
    .all() as Array<{ version: number; name: string; filename: string; checksum: string }>;
  if (
    rows.length !== alternate.length ||
    !rows.every((row, index) => {
      const expected = alternate[index];
      return (
        row.version === expected.version &&
        row.name === expected.name &&
        row.filename === expected.filename &&
        row.checksum === expected.checksum
      );
    })
  )
    return;
  for (const table of [
    "execution_results",
    "attempt_results",
    "plan_proposals",
    "evidence_manifests",
    "review_findings",
    "scheduler_firings",
    "execution_plan_approvals"
  ]) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) {
      throw new Error("alternate migration layout schema validation failed");
    }
  }
  const canonical = new Map(controlPlaneMigrations().map((migration) => [migration.version, migration]));
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE schema_migrations SET version = version + 100 WHERE version BETWEEN 17 AND 21").run();
    for (const [oldVersion, newVersion] of [
      [19, 17],
      [20, 18],
      [21, 19],
      [17, 21],
      [18, 22]
    ] as const) {
      const migration = canonical.get(newVersion);
      if (!migration) throw new Error(`canonical migration ${newVersion} missing during lineage repair`);
      db.prepare(
        "UPDATE schema_migrations SET version = ?, name = ?, filename = ?, checksum = ? WHERE version = ?"
      ).run(migration.version, migration.name, migration.filename, migration.checksum, oldVersion + 100);
    }
    applyMigrationInsideRepair(db, canonical, 20);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* no active transaction */
    }
    throw error;
  }
}

/** Repairs the exact pre-lease-renewal 20-23 layout deployed by this branch. */
function repairExactPreLeaseRenewalTwentyToTwentyThreeLayout(db: SqliteLike): void {
  // Pinned for the same reason as the 17-21 layout: these superseded SQL files no
  // longer exist in the repository.
  const deployed = (
    [
      [
        20,
        "desktop_commander_execution_mode",
        "020_desktop_commander_execution_mode.sql",
        legacyMigrationChecksum("020_desktop_commander_execution_mode.sql")
      ],
      [
        21,
        "advisory_evidence_and_verification",
        "021_advisory_evidence_and_verification.sql",
        legacyMigrationChecksum("021_advisory_evidence_and_verification.sql")
      ],
      [22, "device_auth", "022_device_auth.sql", legacyMigrationChecksum("022_device_auth.sql")],
      [
        23,
        "desktop_commander_runtime_capabilities",
        "023_desktop_commander_runtime_capabilities.sql",
        legacyMigrationChecksum("023_desktop_commander_runtime_capabilities.sql")
      ]
    ] as const
  ).map(([version, name, filename, checksum]) => ({ version, name, filename, checksum }));
  const rows = db
    .prepare(
      "SELECT version, name, filename, checksum FROM schema_migrations WHERE version BETWEEN 20 AND 23 ORDER BY version"
    )
    .all() as Array<{ version: number; name: string; filename: string; checksum: string }>;
  if (
    rows.length !== deployed.length ||
    !rows.every((row, index) => {
      const expected = deployed[index];
      return (
        row.version === expected.version &&
        row.name === expected.name &&
        row.filename === expected.filename &&
        row.checksum === expected.checksum
      );
    })
  )
    return;
  for (const table of ["execution_results", "plan_proposals", "devices", "desktop_commander_runtimes"]) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) {
      throw new Error("pre-lease-renewal migration layout schema validation failed");
    }
  }
  const canonical = new Map(controlPlaneMigrations().map((migration) => [migration.version, migration]));
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE schema_migrations SET version = version + 100 WHERE version BETWEEN 20 AND 23").run();
    applyMigrationInsideRepair(db, canonical, 20);
    for (const [oldVersion, newVersion] of [
      [20, 21],
      [21, 22],
      [22, 23],
      [23, 24]
    ] as const) {
      const migration = canonical.get(newVersion);
      if (!migration) throw new Error(`canonical migration ${newVersion} missing during lineage repair`);
      db.prepare(
        "UPDATE schema_migrations SET version = ?, name = ?, filename = ?, checksum = ? WHERE version = ?"
      ).run(migration.version, migration.name, migration.filename, migration.checksum, oldVersion + 100);
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* no active transaction */
    }
    throw error;
  }
}

function applyMigrationInsideRepair(
  db: SqliteLike,
  canonical: ReadonlyMap<number, ControlPlaneMigration>,
  version: number
): void {
  const migration = canonical.get(version);
  if (!migration) throw new Error(`canonical migration ${version} missing during lineage repair`);
  db.exec(migration.sql);
  db.prepare(
    `INSERT INTO schema_migrations (version, name, filename, checksum, applied_at)
       VALUES (?, ?, ?, ?, ?)`
  ).run(migration.version, migration.name, migration.filename, migration.checksum, new Date().toISOString());
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
  if (migration.version === 41 && hasColumn(db, "admission_permits", "execution_class")) {
    return "SELECT 1;";
  }
  if (migration.version === 42 && hasTable(db, "change_set_revisions") && hasTable(db, "change_set_heads")) {
    return "SELECT 1;";
  }
  if (
    migration.version === 43 &&
    [
      "work_item_id",
      "selected_worker_id",
      "selected_agent_id",
      "routing_decision_id",
      "assigned_by_actor_id",
      "assigned_at"
    ].every((column) => hasColumn(db, "work_item_assignments", column))
  ) {
    return "SELECT 1;";
  }
  if (migration.version === 25) {
    let sql = migration.sql;
    for (const column of ["access_token_hash", "access_token_expires_at", "previous_refresh_token_hash"]) {
      if (hasColumn(db, "devices", column)) {
        sql = sql.replace(new RegExp(`\\s*ALTER TABLE devices ADD COLUMN ${column} TEXT;\\s*`, "u"), "\n");
      }
    }
    return sql;
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

function hasTable(db: SqliteLike, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function queryMigrationRow(
  db: SqliteLike,
  version: number
): { version: number; name: string; filename: string; checksum: string } | undefined {
  return db
    .prepare(`SELECT version, name, filename, checksum FROM schema_migrations WHERE version = ?`)
    .get(version) as { version: number; name: string; filename: string; checksum: string } | undefined;
}
