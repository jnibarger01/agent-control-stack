-- Durable execution-attempt identity and normalized receipts for Mission/WorkUnit execution.
-- The claim token is never persisted here: only its stable hash is stored.
CREATE TABLE work_unit_execution_attempts (
  attempt_id TEXT PRIMARY KEY CHECK (length(attempt_id) BETWEEN 8 AND 96),
  mission_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  unit_attempt INTEGER NOT NULL CHECK (unit_attempt > 0),
  worker_id TEXT NOT NULL,
  executor_lane TEXT NOT NULL CHECK (executor_lane IN ('coder', 'jc', 'dc', 'mcp')),
  claim_token_hash TEXT NOT NULL,
  dispatch_hash TEXT NOT NULL,
  dispatch_json TEXT NOT NULL,
  authority_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('started', 'succeeded', 'failed', 'cancelled', 'unknown', 'rejected_stale')),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  result_hash TEXT,
  failure_category TEXT,
  report_hash TEXT,
  report_json TEXT,
  UNIQUE (mission_id, unit_id, unit_attempt),
  FOREIGN KEY (mission_id) REFERENCES coding_missions (mission_id),
  FOREIGN KEY (mission_id, unit_id) REFERENCES coding_operations (mission_id, operation_id)
);

CREATE TABLE work_unit_execution_receipts (
  attempt_id TEXT NOT NULL,
  receipt_index INTEGER NOT NULL CHECK (receipt_index >= 0),
  kind TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (attempt_id, receipt_index),
  FOREIGN KEY (attempt_id) REFERENCES work_unit_execution_attempts (attempt_id) ON DELETE CASCADE
);

CREATE INDEX work_unit_execution_attempts_mission_idx
  ON work_unit_execution_attempts (mission_id, unit_id, unit_attempt);

CREATE INDEX work_unit_execution_attempts_state_idx
  ON work_unit_execution_attempts (state, started_at);
