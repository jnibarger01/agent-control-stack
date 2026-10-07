-- Durable authoritative verification requirements, verifier invocations, and decisions.
-- Migration 057 also quarantines pre-057 in-flight verified units because their rubric and
-- implementer engine identity were never durably bound before execution.
ALTER TABLE work_unit_execution_attempts ADD COLUMN implementer_engine_id TEXT;

CREATE TABLE work_unit_verification_requirements (
  mission_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  criteria_hash TEXT NOT NULL,
  criteria_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (mission_id, unit_id),
  FOREIGN KEY (mission_id, unit_id) REFERENCES coding_operations (mission_id, operation_id)
);

CREATE TRIGGER work_unit_verification_requirements_immutable_update
BEFORE UPDATE ON work_unit_verification_requirements
BEGIN
  SELECT RAISE(ABORT, 'verification requirement is immutable');
END;

CREATE TRIGGER work_unit_verification_requirements_immutable_delete
BEFORE DELETE ON work_unit_verification_requirements
BEGIN
  SELECT RAISE(ABORT, 'verification requirement is immutable');
END;

CREATE TABLE work_unit_verification_quarantine (
  mission_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  quarantined_at TEXT NOT NULL,
  PRIMARY KEY (mission_id, unit_id),
  FOREIGN KEY (mission_id, unit_id) REFERENCES coding_operations (mission_id, operation_id)
);

INSERT INTO work_unit_verification_quarantine (mission_id, unit_id, reason, quarantined_at)
SELECT mission_id, operation_id, 'migration_057_missing_verification_authority', datetime('now')
FROM coding_operations
WHERE verification_policy <> 'none'
  AND attempt > 0
  AND status IN ('claimed', 'running', 'checkpointed', 'verifying', 'unknown', 'retryable', 'failed');

UPDATE coding_operations
SET status = 'failed',
    failure_category = 'verification_failure'
WHERE EXISTS (
  SELECT 1
  FROM work_unit_verification_quarantine q
  WHERE q.mission_id = coding_operations.mission_id
    AND q.unit_id = coding_operations.operation_id
);

CREATE TABLE work_unit_verification_usage_reservations (
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
  FOREIGN KEY (execution_attempt_id) REFERENCES work_unit_execution_attempts (attempt_id)
);

CREATE INDEX work_unit_verification_usage_active_idx
  ON work_unit_verification_usage_reservations (mission_id, state);

CREATE TABLE work_unit_verification_decisions (
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
  FOREIGN KEY (execution_attempt_id) REFERENCES work_unit_execution_attempts (attempt_id)
);

CREATE INDEX work_unit_verification_decisions_unit_idx
  ON work_unit_verification_decisions (mission_id, unit_id, unit_attempt, created_at);

CREATE INDEX work_unit_verification_decisions_attempt_idx
  ON work_unit_verification_decisions (execution_attempt_id, created_at);
