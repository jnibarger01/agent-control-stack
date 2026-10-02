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
  { version: 39, name: "admission_permits", filename: "039_admission_permits.sql" },
  {
    version: 40,
    name: "admission_permit_execution_class",
    filename: "040_admission_permit_execution_class.sql"
  },
  { version: 41, name: "change_sets", filename: "041_change_sets.sql" },
  { version: 42, name: "work_item_assignments", filename: "042_work_item_assignments.sql" },
  { version: 43, name: "migration_lineage_reconciliation", filename: "043_migration_lineage_reconciliation.sql" },
  { version: 44, name: "change_set_approvals", filename: "044_change_set_approvals.sql" },
  { version: 45, name: "change_set_operation_permits", filename: "045_change_set_operation_permits.sql" },
  { version: 46, name: "autonomous_authority", filename: "046_autonomous_authority.sql" },
  { version: 47, name: "operation_permit_grant_authority", filename: "047_operation_permit_grant_authority.sql" }
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
  "021_advisory_evidence_and_verification.sql": "0a530ca728bda97f7aedfa1ff89e2ae9a70cc0313d5208a5e7ca1089d7fc80a2"
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
          existing.checksum === LEGACY_MIGRATION_CHECKSUM_V7_WORKSPACE_ALLOCATIONS;
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
      if (!row || row.name !== name || row.filename !== filename || row.checksum !== checksum) {
        throw new Error("recovery migration layout metadata mismatch");
      }
    }
    const isolatedDuplicate = queryMigrationRow(db, 39);
    // The reconciled duplicate carries the canonical admission_permits SQL.
    const canonicalDuplicate = canonical.get(39);
    if (
      isolatedDuplicate &&
      (isolatedDuplicate.name !== "admission_permits_reconciled" ||
        isolatedDuplicate.filename !== "039_admission_permits.sql" ||
        !canonicalDuplicate ||
        isolatedDuplicate.checksum !== canonicalDuplicate.checksum)
    ) {
      throw new Error("recovery migration layout metadata mismatch");
    }
    for (const version of [40, 41, 42] as const) {
      const row = queryMigrationRow(db, version);
      if (row) {
        const expected = canonical.get(version);
        if (
          !expected ||
          row.name !== expected.name ||
          row.filename !== expected.filename ||
          row.checksum !== expected.checksum
        ) {
          throw new Error("recovery migration layout metadata mismatch");
        }
        const schemaPresent =
          version === 40
            ? hasColumn(db, "admission_permits", "execution_class")
            : version === 41
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
      } else if (db.prepare("SELECT version FROM schema_migrations WHERE version > ?").all(version).length > 0) {
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
    db.prepare("UPDATE schema_migrations SET version = version + 100 WHERE version IN (37, 38, 39)").run();
    for (const [oldVersion, newVersion] of [
      [37, 38],
      [38, 39]
    ] as const) {
      const migration = canonical.get(newVersion);
      if (!migration) throw new Error("recovery migration canonical target missing");
      db.prepare(
        "UPDATE schema_migrations SET version = ?, name = ?, filename = ?, checksum = ? WHERE version = ?"
      ).run(newVersion, migration.name, migration.filename, migration.checksum, oldVersion + 100);
    }
    if (isolatedDuplicate) {
      const reconciliation = canonical.get(43);
      if (!reconciliation) throw new Error("canonical lineage reconciliation migration missing");
      db.prepare(
        "UPDATE schema_migrations SET version = ?, name = ?, filename = ?, checksum = ? WHERE version = ?"
      ).run(43, reconciliation.name, reconciliation.filename, reconciliation.checksum, 139);
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
  const alternate = ([
    [17, "desktop_commander_execution_mode", "017_desktop_commander_execution_mode.sql", legacyMigrationChecksum("017_desktop_commander_execution_mode.sql")],
    [18, "advisory_evidence_and_verification", "018_advisory_evidence_and_verification.sql", legacyMigrationChecksum("018_advisory_evidence_and_verification.sql")],
    [19, "scheduler_firing_callback_pending", "019_scheduler_firing_callback_pending.sql", legacyMigrationChecksum("019_scheduler_firing_callback_pending.sql")],
    [20, "attempt_lease_approvals", "020_attempt_lease_approvals.sql", legacyMigrationChecksum("020_attempt_lease_approvals.sql")],
    [21, "work_item_metadata", "021_work_item_metadata.sql", legacyMigrationChecksum("021_work_item_metadata.sql")]
  ] as const).map(([version, name, filename, checksum]) => ({ version, name, filename, checksum }));
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
  const deployed = ([
    [20, "desktop_commander_execution_mode", "020_desktop_commander_execution_mode.sql", legacyMigrationChecksum("020_desktop_commander_execution_mode.sql")],
    [21, "advisory_evidence_and_verification", "021_advisory_evidence_and_verification.sql", legacyMigrationChecksum("021_advisory_evidence_and_verification.sql")],
    [22, "device_auth", "022_device_auth.sql", legacyMigrationChecksum("022_device_auth.sql")],
    [23, "desktop_commander_runtime_capabilities", "023_desktop_commander_runtime_capabilities.sql", legacyMigrationChecksum("023_desktop_commander_runtime_capabilities.sql")]
  ] as const).map(([version, name, filename, checksum]) => ({ version, name, filename, checksum }));
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
  if (migration.version === 40 && hasColumn(db, "admission_permits", "execution_class")) {
    return "SELECT 1;";
  }
  if (migration.version === 41 && hasTable(db, "change_set_revisions") && hasTable(db, "change_set_heads")) {
    return "SELECT 1;";
  }
  if (
    migration.version === 42 &&
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
