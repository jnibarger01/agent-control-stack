-- Durable authoritative verification requirements and decisions.
-- Requirements are fixed before execution; decisions bind the verified verdict
-- to one persisted execution attempt and result.
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

CREATE TABLE work_unit_verification_decisions (
  decision_id TEXT PRIMARY KEY CHECK (length(decision_id) BETWEEN 8 AND 96),
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
  verifier_engine_ids_json TEXT NOT NULL,
  evidence_hash TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (execution_attempt_id, criteria_hash, verifier_engine_ids_json, evidence_hash),
  FOREIGN KEY (mission_id, unit_id) REFERENCES coding_operations (mission_id, operation_id),
  FOREIGN KEY (execution_attempt_id) REFERENCES work_unit_execution_attempts (attempt_id)
);

CREATE INDEX work_unit_verification_decisions_unit_idx
  ON work_unit_verification_decisions (mission_id, unit_id, unit_attempt, created_at);

CREATE INDEX work_unit_verification_decisions_attempt_idx
  ON work_unit_verification_decisions (execution_attempt_id, created_at);
