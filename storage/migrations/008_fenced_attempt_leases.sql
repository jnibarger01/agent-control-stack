DROP TRIGGER IF EXISTS execution_attempts_transition_guard;
DROP TRIGGER IF EXISTS attempt_leases_transition_guard;
DROP TRIGGER IF EXISTS attempt_leases_binding_guard;
DROP TRIGGER IF EXISTS attempt_leases_consume_approvals;
DROP TRIGGER IF EXISTS attempt_leases_no_delete;
ALTER TABLE attempt_leases RENAME TO attempt_leases_v7;
CREATE TABLE attempt_leases (
  lease_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  worker_id TEXT NOT NULL CHECK (length(trim(worker_id)) > 0),
  protocol_version TEXT NOT NULL CHECK (protocol_version = 'acs.worker.v2'),
  plan_id TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  admission_id TEXT NOT NULL,
  admission_hash TEXT NOT NULL,
  input_hash TEXT NOT NULL CHECK (length(input_hash) = 64 AND input_hash NOT GLOB '*[^a-f0-9]*'),
  token_hash TEXT NOT NULL CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^a-f0-9]*'),
  fencing_epoch INTEGER NOT NULL CHECK (fencing_epoch > 0),
  issued_at TEXT NOT NULL CHECK (julianday(issued_at) IS NOT NULL),
  expires_at TEXT NOT NULL CHECK (julianday(expires_at) IS NOT NULL AND julianday(expires_at) > julianday(issued_at)),
  status TEXT NOT NULL CHECK (status IN ('active', 'consumed', 'expired', 'revoked')),
  closed_at TEXT CHECK (closed_at IS NULL OR julianday(closed_at) IS NOT NULL),
  FOREIGN KEY (attempt_id, work_item_id) REFERENCES execution_attempts(attempt_id, work_item_id),
  FOREIGN KEY (plan_id, work_item_id) REFERENCES execution_plans(plan_id, work_item_id),
  FOREIGN KEY (work_item_id, plan_hash) REFERENCES execution_plans(work_item_id, plan_hash),
  FOREIGN KEY (admission_id, work_item_id) REFERENCES execution_plan_admissions(admission_id, work_item_id),
  FOREIGN KEY (work_item_id, admission_hash) REFERENCES execution_plan_admissions(work_item_id, admission_hash),
  UNIQUE (attempt_id, fencing_epoch),
  UNIQUE (lease_id, attempt_id, work_item_id),
  CHECK ((status = 'active' AND closed_at IS NULL) OR (status <> 'active' AND closed_at IS NOT NULL))
);
INSERT INTO attempt_leases SELECT * FROM attempt_leases_v7;
DROP TABLE attempt_leases_v7;
CREATE UNIQUE INDEX idx_attempt_leases_one_active_attempt ON attempt_leases(attempt_id) WHERE status = 'active';
CREATE INDEX idx_attempt_leases_expiry ON attempt_leases(status, expires_at);
CREATE INDEX idx_attempt_leases_worker ON attempt_leases(worker_id, status);
ALTER TABLE execution_attempts ADD COLUMN started_at TEXT CHECK (started_at IS NULL OR julianday(started_at) IS NOT NULL);

CREATE TRIGGER execution_attempts_transition_guard
BEFORE UPDATE ON execution_attempts
WHEN NEW.attempt_id IS NOT OLD.attempt_id
  OR NEW.work_item_id IS NOT OLD.work_item_id
  OR NEW.attempt_number IS NOT OLD.attempt_number
  OR NEW.protocol_version IS NOT OLD.protocol_version
  OR NEW.plan_id IS NOT OLD.plan_id
  OR NEW.plan_hash IS NOT OLD.plan_hash
  OR NEW.admission_id IS NOT OLD.admission_id
  OR NEW.admission_hash IS NOT OLD.admission_hash
  OR NEW.input_hash IS NOT OLD.input_hash
  OR (NEW.worker_id IS NOT OLD.worker_id AND NEW.fencing_epoch <= OLD.fencing_epoch)
  OR NEW.fencing_epoch < OLD.fencing_epoch
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.claimed_at IS NOT OLD.claimed_at
  OR (OLD.started_at IS NOT NULL AND NEW.started_at IS NOT OLD.started_at)
  OR OLD.status <> 'leased'
  OR NEW.status NOT IN ('leased', 'unknown', 'quarantined')
BEGIN
  SELECT RAISE(ABORT, 'execution_attempts: immutable field or invalid lifecycle transition');
END;

CREATE TRIGGER attempt_leases_binding_guard
BEFORE INSERT ON attempt_leases
WHEN NOT EXISTS (
  SELECT 1 FROM execution_attempts
  WHERE attempt_id = NEW.attempt_id
    AND work_item_id = NEW.work_item_id
    AND protocol_version = NEW.protocol_version
    AND plan_id = NEW.plan_id
    AND plan_hash = NEW.plan_hash
    AND admission_id = NEW.admission_id
    AND admission_hash = NEW.admission_hash
    AND input_hash = NEW.input_hash
    AND worker_id = NEW.worker_id
    AND fencing_epoch = NEW.fencing_epoch
    AND status = 'leased'
)
BEGIN
  SELECT RAISE(ABORT, 'attempt_leases: attempt authority binding mismatch');
END;

CREATE TRIGGER attempt_leases_consume_approvals
AFTER INSERT ON attempt_leases
BEGIN
  UPDATE execution_plan_approvals
  SET status = 'consumed', consumed_at = NEW.issued_at
  WHERE admission_id = NEW.admission_id
    AND admission_hash = NEW.admission_hash
    AND status = 'granted'
    AND julianday(expires_at) > julianday(NEW.issued_at);
END;

CREATE TRIGGER attempt_leases_no_delete
BEFORE DELETE ON attempt_leases
BEGIN
  SELECT RAISE(ABORT, 'attempt_leases: append-only');
END;

CREATE TRIGGER attempt_leases_immutable_guard
BEFORE UPDATE ON attempt_leases
WHEN NEW.lease_id IS NOT OLD.lease_id
  OR NEW.attempt_id IS NOT OLD.attempt_id
  OR NEW.work_item_id IS NOT OLD.work_item_id
  OR NEW.worker_id IS NOT OLD.worker_id
  OR NEW.protocol_version IS NOT OLD.protocol_version
  OR NEW.plan_id IS NOT OLD.plan_id
  OR NEW.plan_hash IS NOT OLD.plan_hash
  OR NEW.admission_id IS NOT OLD.admission_id
  OR NEW.admission_hash IS NOT OLD.admission_hash
  OR NEW.input_hash IS NOT OLD.input_hash
  OR NEW.token_hash IS NOT OLD.token_hash
  OR NEW.fencing_epoch IS NOT OLD.fencing_epoch
  OR NEW.issued_at IS NOT OLD.issued_at
  OR NEW.status NOT IN ('active', 'expired', 'consumed', 'revoked')
  OR (OLD.status <> 'active' AND NEW.status <> OLD.status)
BEGIN
  SELECT RAISE(ABORT, 'attempt_leases: immutable binding or invalid transition');
END;

CREATE INDEX IF NOT EXISTS idx_attempt_leases_attempt_epoch ON attempt_leases(attempt_id, fencing_epoch);
