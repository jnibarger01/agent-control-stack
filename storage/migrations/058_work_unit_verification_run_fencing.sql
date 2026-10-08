-- A durable per-execution-attempt fence prevents concurrent verifiers from
-- racing decisive evidence. After owner-process death, reserved usage is charged
-- conservatively and the row remains fenced until explicit outcome reconciliation.
CREATE TABLE work_unit_verification_runs (
  run_id TEXT PRIMARY KEY CHECK (length(run_id) BETWEEN 8 AND 96),
  execution_attempt_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  unit_attempt INTEGER NOT NULL CHECK (unit_attempt > 0),
  owner_pid INTEGER,
  owner_boot_id TEXT,
  owner_process_start_ticks TEXT,
  state TEXT NOT NULL CHECK (state IN ('active', 'settled', 'reconciliation_required')),
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('succeeded', 'failed', 'retryable', 'inconclusive', 'rejected_stale')),
  started_at TEXT NOT NULL,
  settled_at TEXT,
  FOREIGN KEY (execution_attempt_id) REFERENCES work_unit_execution_attempts (attempt_id),
  FOREIGN KEY (mission_id, unit_id) REFERENCES coding_operations (mission_id, operation_id)
);

CREATE UNIQUE INDEX work_unit_verification_one_active_run_idx
  ON work_unit_verification_runs (execution_attempt_id)
  WHERE state IN ('active', 'reconciliation_required');

CREATE INDEX work_unit_verification_runs_unit_idx
  ON work_unit_verification_runs (mission_id, unit_id, unit_attempt, started_at);
