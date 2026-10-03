CREATE TABLE mission_deployment_operations (
  id TEXT PRIMARY KEY,
  mission_id TEXT NOT NULL UNIQUE REFERENCES missions(mission_id),
  change_set_hash TEXT NOT NULL CHECK (length(change_set_hash) = 64 AND change_set_hash NOT GLOB '*[^0-9a-f]*'),
  release_id TEXT NOT NULL CHECK (length(release_id) > 0),
  requested_by TEXT NOT NULL CHECK (length(requested_by) > 0),
  permit_id TEXT NOT NULL CHECK (length(permit_id) > 0),
  status TEXT NOT NULL,
  observed_release_id TEXT,
  observed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (status IN ('PENDING', 'EXECUTING', 'SUCCEEDED', 'FAILED', 'UNKNOWN'))
);

CREATE INDEX idx_mission_deployment_operations_status
  ON mission_deployment_operations(status, updated_at);

CREATE TRIGGER mission_deployment_operation_identity_immutable
BEFORE UPDATE OF id, mission_id, change_set_hash, release_id, requested_by, permit_id, created_at
ON mission_deployment_operations
WHEN NEW.id != OLD.id
  OR NEW.mission_id != OLD.mission_id
  OR NEW.change_set_hash != OLD.change_set_hash
  OR NEW.release_id != OLD.release_id
  OR NEW.requested_by != OLD.requested_by
  OR NEW.permit_id != OLD.permit_id
  OR NEW.created_at != OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'deployment operation identity is immutable');
END;

CREATE TRIGGER mission_deployment_operation_terminal
BEFORE UPDATE ON mission_deployment_operations
WHEN OLD.status IN ('SUCCEEDED', 'FAILED') AND NEW.status != OLD.status
BEGIN
  SELECT RAISE(ABORT, 'terminal deployment operation cannot change status');
END;

CREATE TRIGGER mission_deployment_operation_status_transition
BEFORE UPDATE OF status ON mission_deployment_operations
WHEN NEW.status != OLD.status
  AND NOT (
    (OLD.status = 'PENDING' AND NEW.status IN ('EXECUTING', 'SUCCEEDED', 'FAILED', 'UNKNOWN')) OR
    (OLD.status = 'EXECUTING' AND NEW.status IN ('SUCCEEDED', 'FAILED', 'UNKNOWN')) OR
    (OLD.status = 'UNKNOWN' AND NEW.status = 'SUCCEEDED')
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid deployment operation status transition');
END;

CREATE TRIGGER mission_deployment_operation_no_delete
BEFORE DELETE ON mission_deployment_operations
BEGIN
  SELECT RAISE(ABORT, 'deployment operations are immutable audit records');
END;
