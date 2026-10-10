-- Allow the cua executor lane and record fenced browser-action checkpoints.
-- SQLite cannot replace the executor_lane CHECK in place. Rebuild the attempts
-- table and every child that references it so existing rows stay addressable.
-- Foreign keys stay enabled: PRAGMA foreign_keys does not change inside the
-- migration transaction, and this migration must not leave them off.

CREATE TABLE work_unit_execution_attempts__061 (
  attempt_id TEXT PRIMARY KEY CHECK (length(attempt_id) BETWEEN 8 AND 96),
  mission_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  unit_attempt INTEGER NOT NULL CHECK (unit_attempt > 0),
  worker_id TEXT NOT NULL,
  executor_lane TEXT NOT NULL CHECK (executor_lane IN ('coder', 'jc', 'dc', 'mcp', 'cua')),
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
  implementer_engine_id TEXT,
  UNIQUE (mission_id, unit_id, unit_attempt),
  FOREIGN KEY (mission_id) REFERENCES coding_missions (mission_id),
  FOREIGN KEY (mission_id, unit_id) REFERENCES coding_operations (mission_id, operation_id)
);

INSERT INTO work_unit_execution_attempts__061 (
  attempt_id, mission_id, unit_id, unit_attempt, worker_id, executor_lane, claim_token_hash,
  dispatch_hash, dispatch_json, authority_json, state, started_at, finished_at, result_hash,
  failure_category, report_hash, report_json, implementer_engine_id
)
SELECT
  attempt_id, mission_id, unit_id, unit_attempt, worker_id, executor_lane, claim_token_hash,
  dispatch_hash, dispatch_json, authority_json, state, started_at, finished_at, result_hash,
  failure_category, report_hash, report_json, implementer_engine_id
FROM work_unit_execution_attempts;

CREATE TABLE work_unit_execution_receipts__061 (
  attempt_id TEXT NOT NULL,
  receipt_index INTEGER NOT NULL CHECK (receipt_index >= 0),
  kind TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (attempt_id, receipt_index),
  FOREIGN KEY (attempt_id) REFERENCES work_unit_execution_attempts__061 (attempt_id) ON DELETE CASCADE
);

INSERT INTO work_unit_execution_receipts__061 (attempt_id, receipt_index, kind, hash, created_at)
SELECT attempt_id, receipt_index, kind, hash, created_at
FROM work_unit_execution_receipts;

DROP TABLE work_unit_execution_receipts;

CREATE TABLE work_unit_verification_usage_reservations__061 (
  reservation_id TEXT PRIMARY KEY CHECK (length(reservation_id) BETWEEN 8 AND 128),
  run_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  execution_attempt_id TEXT NOT NULL,
  verifier_engine_id TEXT NOT NULL,
  tool_calls INTEGER NOT NULL CHECK (tool_calls >= 0),
  model_tokens INTEGER NOT NULL CHECK (model_tokens >= 0),
  spend_micro_usd INTEGER NOT NULL CHECK (spend_micro_usd >= 0),
  state TEXT NOT NULL CHECK (state IN ('active', 'settled')),
  created_at TEXT NOT NULL,
  settled_at TEXT,
  FOREIGN KEY (mission_id) REFERENCES coding_missions (mission_id),
  FOREIGN KEY (execution_attempt_id) REFERENCES work_unit_execution_attempts__061 (attempt_id)
);

INSERT INTO work_unit_verification_usage_reservations__061 (
  reservation_id, run_id, mission_id, execution_attempt_id, verifier_engine_id,
  tool_calls, model_tokens, spend_micro_usd, state, created_at, settled_at
)
SELECT
  reservation_id, run_id, mission_id, execution_attempt_id, verifier_engine_id,
  tool_calls, model_tokens, spend_micro_usd, state, created_at, settled_at
FROM work_unit_verification_usage_reservations;

DROP TABLE work_unit_verification_usage_reservations;

CREATE TABLE work_unit_verification_decisions__061 (
  decision_id TEXT PRIMARY KEY CHECK (length(decision_id) BETWEEN 8 AND 96),
  run_id TEXT NOT NULL UNIQUE CHECK (length(run_id) BETWEEN 8 AND 96),
  mission_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  unit_attempt INTEGER NOT NULL CHECK (unit_attempt > 0),
  execution_attempt_id TEXT NOT NULL,
  execution_report_hash TEXT NOT NULL,
  result_hash TEXT NOT NULL,
  criteria_hash TEXT NOT NULL,
  verification_policy TEXT NOT NULL CHECK (
    verification_policy IN ('lightweight', 'independent', 'multi_verifier', 'release_gate')
  ),
  outcome TEXT NOT NULL CHECK (
    outcome IN ('succeeded', 'failed', 'retryable', 'inconclusive', 'rejected_stale')
  ),
  verdict TEXT CHECK (verdict IS NULL OR verdict IN ('pass', 'fail', 'inconclusive')),
  implementer_worker_id TEXT NOT NULL,
  implementer_engine_id TEXT NOT NULL,
  verifier_engine_ids_json TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (mission_id, unit_id) REFERENCES coding_operations (mission_id, operation_id),
  FOREIGN KEY (execution_attempt_id) REFERENCES work_unit_execution_attempts__061 (attempt_id)
);

INSERT INTO work_unit_verification_decisions__061 (
  decision_id, run_id, mission_id, unit_id, unit_attempt, execution_attempt_id, execution_report_hash,
  result_hash, criteria_hash, verification_policy, outcome, verdict, implementer_worker_id,
  implementer_engine_id, verifier_engine_ids_json, evidence_hash, evidence_json, created_at
)
SELECT
  decision_id, run_id, mission_id, unit_id, unit_attempt, execution_attempt_id, execution_report_hash,
  result_hash, criteria_hash, verification_policy, outcome, verdict, implementer_worker_id,
  implementer_engine_id, verifier_engine_ids_json, evidence_hash, evidence_json, created_at
FROM work_unit_verification_decisions;

DROP TABLE work_unit_verification_decisions;

CREATE TABLE work_unit_verification_runs__061 (
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
  FOREIGN KEY (execution_attempt_id) REFERENCES work_unit_execution_attempts__061 (attempt_id),
  FOREIGN KEY (mission_id, unit_id) REFERENCES coding_operations (mission_id, operation_id)
);

INSERT INTO work_unit_verification_runs__061 (
  run_id, execution_attempt_id, mission_id, unit_id, unit_attempt, owner_pid, owner_boot_id,
  owner_process_start_ticks, state, outcome, started_at, settled_at
)
SELECT
  run_id, execution_attempt_id, mission_id, unit_id, unit_attempt, owner_pid, owner_boot_id,
  owner_process_start_ticks, state, outcome, started_at, settled_at
FROM work_unit_verification_runs;

DROP TABLE work_unit_verification_runs;

DROP TABLE work_unit_execution_attempts;

ALTER TABLE work_unit_execution_attempts__061 RENAME TO work_unit_execution_attempts;
ALTER TABLE work_unit_execution_receipts__061 RENAME TO work_unit_execution_receipts;
ALTER TABLE work_unit_verification_usage_reservations__061 RENAME TO work_unit_verification_usage_reservations;
ALTER TABLE work_unit_verification_decisions__061 RENAME TO work_unit_verification_decisions;
ALTER TABLE work_unit_verification_runs__061 RENAME TO work_unit_verification_runs;

CREATE INDEX work_unit_execution_attempts_mission_idx
  ON work_unit_execution_attempts (mission_id, unit_id, unit_attempt);

CREATE INDEX work_unit_execution_attempts_state_idx
  ON work_unit_execution_attempts (state, started_at);

CREATE INDEX work_unit_verification_usage_active_idx
  ON work_unit_verification_usage_reservations (mission_id, state);

CREATE INDEX work_unit_verification_decisions_unit_idx
  ON work_unit_verification_decisions (mission_id, unit_id, unit_attempt, created_at);

CREATE INDEX work_unit_verification_decisions_attempt_idx
  ON work_unit_verification_decisions (execution_attempt_id, created_at);

CREATE UNIQUE INDEX work_unit_verification_one_active_run_idx
  ON work_unit_verification_runs (execution_attempt_id)
  WHERE state IN ('active', 'reconciliation_required');

CREATE INDEX work_unit_verification_runs_unit_idx
  ON work_unit_verification_runs (mission_id, unit_id, unit_attempt, started_at);

CREATE TABLE cua_action_checkpoints (
  attempt_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  unit_attempt INTEGER NOT NULL CHECK (unit_attempt > 0),
  worker_id TEXT NOT NULL,
  claim_token_hash TEXT NOT NULL,
  fencing_token INTEGER,
  sequence INTEGER NOT NULL CHECK (sequence >= 0),
  action_type TEXT NOT NULL CHECK (action_type IN ('observe', 'click', 'type', 'scroll', 'navigate')),
  action_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('planned', 'committed', 'uncertain', 'cancelled')),
  screenshot_hash TEXT,
  receipt_hash TEXT NOT NULL,
  origin TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (attempt_id, sequence),
  FOREIGN KEY (attempt_id) REFERENCES work_unit_execution_attempts (attempt_id) ON DELETE CASCADE
);

CREATE INDEX cua_action_checkpoints_mission_idx
  ON cua_action_checkpoints (mission_id, unit_id, unit_attempt, sequence);
