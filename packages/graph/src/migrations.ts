import { DatabaseSync } from "node:sqlite";

export const GRAPH_LEDGER_SCHEMA_VERSION = 1;

export class GraphLedgerSchemaVersionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphLedgerSchemaVersionError";
  }
}

export interface GraphLedgerMigrationResult {
  fromVersion: number | null;
  toVersion: 1;
  applied: boolean;
}

export function configureGraphLedgerDatabase(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec("PRAGMA journal_mode = WAL");
}

export function migrateGraphLedger(databasePath: string): GraphLedgerMigrationResult {
  const database = new DatabaseSync(databasePath);
  try {
    configureGraphLedgerDatabase(database);
    return migrateGraphLedgerDatabase(database);
  } finally {
    database.close();
  }
}

export function migrateGraphLedgerDatabase(database: DatabaseSync): GraphLedgerMigrationResult {
  const currentVersion = readGraphLedgerSchemaVersion(database);
  if (currentVersion === GRAPH_LEDGER_SCHEMA_VERSION) {
    validateGraphLedgerSchemaVersion(database);
    return { fromVersion: 1, toVersion: 1, applied: false };
  }
  if (currentVersion !== null) {
    throw new GraphLedgerSchemaVersionError(
      `unsupported graph ledger schema version ${currentVersion}; expected ${GRAPH_LEDGER_SCHEMA_VERSION}`
    );
  }

  const existingTables = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as unknown as Array<{ name: string }>;
  if (existingTables.length > 0) {
    throw new GraphLedgerSchemaVersionError(
      `unversioned graph ledger contains existing tables: ${existingTables.map((row) => row.name).join(", ")}`
    );
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(GRAPH_LEDGER_SCHEMA_V1_SQL);
    database
      .prepare("INSERT INTO graph_ledger_meta (key, value) VALUES ('schema_version', ?)")
      .run(String(GRAPH_LEDGER_SCHEMA_VERSION));
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  validateGraphLedgerSchemaVersion(database);
  return { fromVersion: null, toVersion: 1, applied: true };
}

export function validateGraphLedgerSchemaVersion(database: DatabaseSync): 1 {
  const version = readGraphLedgerSchemaVersion(database);
  if (version !== GRAPH_LEDGER_SCHEMA_VERSION) {
    throw new GraphLedgerSchemaVersionError(
      version === null
        ? "graph ledger schema version is missing"
        : `unsupported graph ledger schema version ${version}; expected ${GRAPH_LEDGER_SCHEMA_VERSION}`
    );
  }
  return GRAPH_LEDGER_SCHEMA_VERSION;
}

function readGraphLedgerSchemaVersion(database: DatabaseSync): number | null {
  const metaTable = database
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'graph_ledger_meta'")
    .get() as unknown as { present: number } | undefined;
  if (!metaTable) {
    return null;
  }
  const row = database.prepare("SELECT value FROM graph_ledger_meta WHERE key = 'schema_version'").get() as unknown as
    { value: string } | undefined;
  if (!row || !/^\d+$/u.test(row.value)) {
    throw new GraphLedgerSchemaVersionError("graph ledger schema_version metadata is missing or malformed");
  }
  return Number(row.value);
}

const NODE_STATES = "'PENDING','READY','RUNNING','SUCCEEDED','FAILED','BLOCKED','SKIPPED','CANCELLED'";
const RUN_STATES = "'PENDING','RUNNING','SUCCEEDED','FAILED','BLOCKED','CANCELLED'";

const GRAPH_LEDGER_SCHEMA_V1_SQL = `
  CREATE TABLE graph_ledger_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE graph_runs (
    run_id TEXT PRIMARY KEY,
    graph_id TEXT NOT NULL,
    graph_hash TEXT NOT NULL,
    definition_json TEXT NOT NULL,
    requested_by_json TEXT NOT NULL,
    intent TEXT NOT NULL,
    risk TEXT NOT NULL CHECK (risk IN ('low','medium','high','critical')),
    idempotency_key TEXT NOT NULL UNIQUE,
    correlation_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN (${RUN_STATES})),
    verdict TEXT CHECK (verdict IS NULL OR verdict IN ('PASS','PARTIAL','BLOCK','FAIL')),
    verdict_summary_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (
      (state IN ('PENDING','RUNNING','CANCELLED') AND verdict IS NULL AND verdict_summary_json IS NULL)
      OR (state = 'SUCCEEDED' AND verdict = 'PASS' AND verdict_summary_json IS NOT NULL)
      OR (state = 'FAILED' AND verdict IN ('FAIL','PARTIAL') AND verdict_summary_json IS NOT NULL)
      OR (state = 'BLOCKED' AND verdict = 'BLOCK' AND verdict_summary_json IS NOT NULL)
    )
  );

  CREATE TABLE graph_idempotency_decisions (
    decision_id INTEGER PRIMARY KEY AUTOINCREMENT,
    idempotency_key TEXT NOT NULL,
    run_id TEXT NOT NULL REFERENCES graph_runs(run_id) ON DELETE RESTRICT,
    graph_hash TEXT NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('ADMITTED','DEDUPLICATED','REJECTED_CONFLICT')),
    decided_at TEXT NOT NULL
  );
  CREATE INDEX idx_graph_idempotency_decisions_key
    ON graph_idempotency_decisions(idempotency_key, decision_id);

  CREATE TABLE graph_nodes (
    run_id TEXT NOT NULL REFERENCES graph_runs(run_id) ON DELETE RESTRICT,
    node_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN (${NODE_STATES})),
    required INTEGER NOT NULL CHECK (required IN (0, 1)),
    side_effect TEXT NOT NULL CHECK (side_effect IN ('NONE','READ_ONLY','WRITE','EXTERNAL')),
    adapter TEXT NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    result_json TEXT,
    output_hash TEXT,
    error_json TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (run_id, node_id),
    CHECK ((result_json IS NULL AND output_hash IS NULL) OR (result_json IS NOT NULL AND output_hash IS NOT NULL)),
    CHECK (
      (state = 'SUCCEEDED' AND result_json IS NOT NULL AND output_hash IS NOT NULL AND error_json IS NULL)
      OR (state IN ('PENDING','READY','RUNNING','SKIPPED','CANCELLED') AND result_json IS NULL AND output_hash IS NULL)
      OR (
        state IN ('FAILED','BLOCKED')
        AND (
          (result_json IS NOT NULL AND output_hash IS NOT NULL)
          OR error_json IS NOT NULL
        )
      )
    )
  );

  CREATE TABLE graph_attempts (
    attempt_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
    state TEXT NOT NULL CHECK (state IN ('RUNNING','SUCCEEDED','FAILED','BLOCKED','CANCELLED')),
    input_hash TEXT NOT NULL,
    result_json TEXT,
    output_hash TEXT,
    error_json TEXT,
    input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
    output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
    cost_usd REAL CHECK (cost_usd IS NULL OR cost_usd >= 0),
    duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
    started_at TEXT NOT NULL,
    finished_at TEXT,
    UNIQUE (run_id, node_id, attempt_number),
    FOREIGN KEY (run_id, node_id) REFERENCES graph_nodes(run_id, node_id) ON DELETE RESTRICT,
    CHECK ((result_json IS NULL AND output_hash IS NULL) OR (result_json IS NOT NULL AND output_hash IS NOT NULL)),
    CHECK (
      (result_json IS NULL AND input_tokens IS NULL AND output_tokens IS NULL AND cost_usd IS NULL AND duration_ms IS NULL)
      OR (
        result_json IS NOT NULL
        AND input_tokens IS NOT NULL
        AND output_tokens IS NOT NULL
        AND cost_usd IS NOT NULL
        AND duration_ms IS NOT NULL
      )
    ),
    CHECK (
      (state = 'RUNNING' AND result_json IS NULL AND output_hash IS NULL AND error_json IS NULL AND finished_at IS NULL)
      OR (
        state = 'SUCCEEDED'
        AND result_json IS NOT NULL
        AND output_hash IS NOT NULL
        AND error_json IS NULL
        AND finished_at IS NOT NULL
      )
      OR (
        state IN ('FAILED','BLOCKED')
        AND finished_at IS NOT NULL
        AND (
          (result_json IS NOT NULL AND output_hash IS NOT NULL)
          OR error_json IS NOT NULL
        )
      )
      OR (
        state = 'CANCELLED'
        AND result_json IS NULL
        AND output_hash IS NULL
        AND error_json IS NOT NULL
        AND finished_at IS NOT NULL
      )
    )
  );

  CREATE TABLE graph_transitions (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES graph_runs(run_id) ON DELETE RESTRICT,
    entity_type TEXT NOT NULL CHECK (entity_type IN ('RUN', 'NODE')),
    node_id TEXT,
    from_state TEXT CHECK (from_state IS NULL OR from_state IN (${NODE_STATES})),
    to_state TEXT NOT NULL CHECK (to_state IN (${NODE_STATES})),
    reason TEXT NOT NULL,
    attempt_id TEXT,
    at TEXT NOT NULL,
    previous_hash TEXT,
    transition_hash TEXT NOT NULL,
    CHECK ((entity_type = 'RUN' AND node_id IS NULL) OR (entity_type = 'NODE' AND node_id IS NOT NULL))
  );

  CREATE TABLE graph_run_budgets (
    run_id TEXT PRIMARY KEY REFERENCES graph_runs(run_id) ON DELETE RESTRICT,
    token_ceiling INTEGER NOT NULL CHECK (token_ceiling >= 0),
    dollar_ceiling_usd REAL NOT NULL CHECK (dollar_ceiling_usd >= 0),
    api_concurrency INTEGER NOT NULL CHECK (api_concurrency >= 1),
    used_tokens INTEGER NOT NULL DEFAULT 0 CHECK (used_tokens >= 0),
    used_cost_usd REAL NOT NULL DEFAULT 0 CHECK (used_cost_usd >= 0),
    reserved_tokens INTEGER NOT NULL DEFAULT 0 CHECK (reserved_tokens >= 0),
    reserved_cost_usd REAL NOT NULL DEFAULT 0 CHECK (reserved_cost_usd >= 0),
    active_api_reservations INTEGER NOT NULL DEFAULT 0 CHECK (active_api_reservations >= 0),
    CHECK (reserved_tokens <= token_ceiling),
    CHECK (reserved_cost_usd <= dollar_ceiling_usd),
    CHECK (active_api_reservations <= api_concurrency)
  );

  CREATE TABLE graph_budget_reservations (
    reservation_id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
    max_tokens INTEGER NOT NULL CHECK (max_tokens >= 0),
    max_cost_usd REAL NOT NULL CHECK (max_cost_usd >= 0),
    api_slots INTEGER NOT NULL CHECK (api_slots IN (0, 1)),
    actual_tokens INTEGER CHECK (actual_tokens IS NULL OR actual_tokens >= 0),
    actual_cost_usd REAL CHECK (actual_cost_usd IS NULL OR actual_cost_usd >= 0),
    state TEXT NOT NULL CHECK (state IN ('RESERVED','SETTLED','RELEASED')),
    created_at TEXT NOT NULL,
    settled_at TEXT,
    UNIQUE (run_id, node_id, attempt_number),
    FOREIGN KEY (run_id, node_id) REFERENCES graph_nodes(run_id, node_id) ON DELETE RESTRICT,
    CHECK (
      (state = 'RESERVED' AND actual_tokens IS NULL AND actual_cost_usd IS NULL AND settled_at IS NULL)
      OR (
        state = 'SETTLED'
        AND actual_tokens IS NOT NULL
        AND actual_cost_usd IS NOT NULL
        AND settled_at IS NOT NULL
      )
      OR (state = 'RELEASED' AND actual_tokens IS NULL AND actual_cost_usd IS NULL AND settled_at IS NOT NULL)
    )
  );

  CREATE TABLE graph_scheduler_leases (
    run_id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 128),
    lease_epoch INTEGER NOT NULL CHECK (lease_epoch >= 1),
    acquired_at TEXT NOT NULL,
    heartbeat_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    FOREIGN KEY (run_id) REFERENCES graph_runs(run_id) ON DELETE CASCADE,
    CHECK (heartbeat_at >= acquired_at),
    CHECK (expires_at > heartbeat_at)
  );
  CREATE INDEX idx_graph_nodes_state ON graph_nodes(run_id, state);
  CREATE INDEX idx_graph_attempts_node ON graph_attempts(run_id, node_id, attempt_number);
  CREATE INDEX idx_graph_transitions_run ON graph_transitions(run_id, sequence);
  CREATE INDEX idx_graph_budget_reservations_run ON graph_budget_reservations(run_id, state);
`;
