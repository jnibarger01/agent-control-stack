-- Durable mission lifecycle. ACS remains the source of truth for mission,
-- operation, change-set, approval, apply, and deployment state. Historical
-- work-item rows are not rewritten.

CREATE TABLE IF NOT EXISTS missions (
  mission_id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL,
  intent TEXT NOT NULL,
  status TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  target_json TEXT NOT NULL,
  base_revision TEXT NOT NULL,
  proposed_mutation_json TEXT,
  requires_mutation INTEGER NOT NULL,
  requires_deployment INTEGER NOT NULL,
  deployment_target TEXT,
  requires_production_verification INTEGER NOT NULL,
  production_verification_json TEXT NOT NULL,
  change_set_id TEXT,
  evidence_seal_hash TEXT,
  failure_code TEXT,
  failure_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (status IN (
    'PLANNED',
    'RUNNING',
    'WAITING_FOR_RESULT',
    'WAITING_FOR_RECONCILIATION',
    'VALIDATING',
    'READY_FOR_CHANGE_SET',
    'WAITING_FOR_APPROVAL',
    'APPROVED',
    'APPLYING',
    'VERIFYING_PRODUCTION',
    'COMPLETED',
    'FAILED',
    'CANCELLED',
    'BLOCKED'
  ))
);

CREATE TABLE IF NOT EXISTS mission_operations (
  operation_id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  operation_type TEXT NOT NULL,
  lane TEXT NOT NULL,
  required_capabilities_json TEXT NOT NULL,
  dependencies_json TEXT NOT NULL,
  mutation_class TEXT NOT NULL,
  retry_policy TEXT NOT NULL,
  max_attempts INTEGER NOT NULL,
  verification_json TEXT NOT NULL,
  status TEXT NOT NULL,
  execution_id TEXT,
  execution_dispatched INTEGER NOT NULL DEFAULT 0,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  claim_worker_id TEXT,
  claim_token TEXT,
  claim_epoch INTEGER NOT NULL DEFAULT 0,
  claim_expires_at TEXT,
  route_decision_json TEXT,
  admission_permit_id TEXT,
  result_json TEXT,
  result_hash TEXT,
  observations_json TEXT,
  failure_code TEXT,
  failure_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (mission_id, operation_key),
  FOREIGN KEY (mission_id) REFERENCES missions(mission_id),
  CHECK (operation_type IN ('execute', 'validate')),
  CHECK (lane IN ('jc', 'dc', 'hermes', 'coding_agent')),
  CHECK (mutation_class IN ('none', 'git', 'external')),
  CHECK (retry_policy IN ('safe_retry', 'fail_closed')),
  CHECK (status IN (
    'PENDING',
    'READY',
    'ROUTED',
    'ADMITTED',
    'CLAIMED',
    'DISPATCHED',
    'UNKNOWN',
    'VERIFYING',
    'SUCCEEDED',
    'FAILED',
    'BLOCKED',
    'CANCELLED'
  ))
);

CREATE INDEX IF NOT EXISTS idx_mission_operations_mission_status
  ON mission_operations (mission_id, status);

CREATE TABLE IF NOT EXISTS mission_events (
  event_id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  operation_id TEXT,
  name TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  previous_hash TEXT NOT NULL,
  event_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (mission_id, idempotency_key),
  FOREIGN KEY (mission_id) REFERENCES missions(mission_id)
);

CREATE INDEX IF NOT EXISTS idx_mission_events_mission ON mission_events (mission_id, created_at);

CREATE TABLE IF NOT EXISTS mission_change_sets (
  change_set_id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  change_set_hash TEXT NOT NULL,
  derived_from_json TEXT NOT NULL,
  target_json TEXT NOT NULL,
  base_revision TEXT NOT NULL,
  proposed_mutation_json TEXT NOT NULL,
  validation_evidence_json TEXT NOT NULL,
  artifact_hashes_json TEXT NOT NULL,
  approval_required INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (mission_id, generation),
  UNIQUE (mission_id, change_set_hash),
  FOREIGN KEY (mission_id) REFERENCES missions(mission_id),
  CHECK (status IN ('proposed', 'waiting_approval', 'approved', 'rejected', 'invalidated', 'applied', 'apply_failed', 'apply_unknown'))
);

CREATE TABLE IF NOT EXISTS mission_approvals (
  approval_id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  change_set_id TEXT NOT NULL,
  change_set_hash TEXT NOT NULL,
  decision TEXT NOT NULL,
  approver_id TEXT NOT NULL,
  request_hash TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (change_set_hash, approver_id, decision),
  FOREIGN KEY (mission_id) REFERENCES missions(mission_id),
  CHECK (decision IN ('approved', 'rejected'))
);

CREATE TABLE IF NOT EXISTS mission_applications (
  mission_id TEXT PRIMARY KEY,
  change_set_id TEXT NOT NULL,
  change_set_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  expected_base_revision TEXT NOT NULL,
  observed_revision TEXT,
  reason TEXT,
  started_at TEXT,
  completed_at TEXT,
  FOREIGN KEY (mission_id) REFERENCES missions(mission_id),
  CHECK (status IN ('not_started', 'started', 'succeeded', 'failed', 'unknown'))
);

CREATE TABLE IF NOT EXISTS mission_deployments (
  mission_id TEXT PRIMARY KEY,
  target TEXT NOT NULL,
  expected_revision TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL,
  observed_version TEXT,
  restart_status TEXT,
  health_status TEXT,
  reason TEXT,
  started_at TEXT,
  completed_at TEXT,
  FOREIGN KEY (mission_id) REFERENCES missions(mission_id),
  CHECK (status IN ('not_started', 'started', 'succeeded', 'failed', 'unknown'))
);

CREATE TABLE IF NOT EXISTS mission_verifications (
  verification_id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL,
  operation_id TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL,
  kind TEXT NOT NULL,
  expected_condition TEXT NOT NULL,
  observed_result TEXT,
  evidence_ref TEXT,
  outcome TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (mission_id, operation_id, stage, kind),
  FOREIGN KEY (mission_id) REFERENCES missions(mission_id),
  CHECK (stage IN ('operation', 'production')),
  CHECK (outcome IN ('passed', 'failed', 'unsupported'))
);

CREATE TRIGGER IF NOT EXISTS mission_operations_success_terminal
BEFORE UPDATE ON mission_operations
WHEN OLD.status = 'SUCCEEDED' AND NEW.status != 'SUCCEEDED'
BEGIN
  SELECT RAISE(ABORT, 'completed operation cannot change status');
END;

CREATE TRIGGER IF NOT EXISTS mission_operations_success_requires_result
BEFORE UPDATE ON mission_operations
WHEN NEW.status = 'SUCCEEDED' AND (NEW.result_hash IS NULL OR length(NEW.result_hash) != 64)
BEGIN
  SELECT RAISE(ABORT, 'operation result must be persisted before success');
END;

CREATE TRIGGER IF NOT EXISTS mission_operations_result_immutable
BEFORE UPDATE ON mission_operations
WHEN OLD.result_hash IS NOT NULL AND NEW.result_hash IS NOT NULL AND OLD.result_hash != NEW.result_hash
BEGIN
  SELECT RAISE(ABORT, 'operation result is immutable');
END;

CREATE TRIGGER IF NOT EXISTS mission_operations_execution_identity_immutable
BEFORE UPDATE ON mission_operations
WHEN OLD.execution_id IS NOT NULL AND NEW.execution_id IS NOT NULL AND OLD.execution_id != NEW.execution_id
BEGIN
  SELECT RAISE(ABORT, 'execution identity is immutable');
END;

CREATE TRIGGER IF NOT EXISTS missions_completed_terminal
BEFORE UPDATE ON missions
WHEN OLD.status = 'COMPLETED' AND NEW.status != 'COMPLETED'
BEGIN
  SELECT RAISE(ABORT, 'completed mission cannot change status');
END;
