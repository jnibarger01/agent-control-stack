CREATE TABLE IF NOT EXISTS human_interrupt_requests (
  interrupt_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  plan_hash TEXT NOT NULL CHECK (length(plan_hash) = 64),
  input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
  admission_id TEXT NOT NULL,
  action_hash TEXT NOT NULL CHECK (length(action_hash) = 64),
  checkpoint_json TEXT NOT NULL CHECK (json_valid(checkpoint_json) = 1),
  checkpoint_hash TEXT NOT NULL CHECK (length(checkpoint_hash) = 64),
  prompt TEXT NOT NULL CHECK (length(trim(prompt)) > 0),
  response_spec_json TEXT CHECK (response_spec_json IS NULL OR json_valid(response_spec_json) = 1),
  requested_by_actor_id TEXT NOT NULL CHECK (length(trim(requested_by_actor_id)) > 0),
  fencing_epoch INTEGER NOT NULL CHECK (fencing_epoch > 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  expires_at TEXT NOT NULL CHECK (julianday(expires_at) > julianday(created_at)),
  FOREIGN KEY (attempt_id, work_item_id) REFERENCES execution_attempts(attempt_id, work_item_id),
  FOREIGN KEY (admission_id) REFERENCES execution_plan_admissions(admission_id)
);

CREATE INDEX IF NOT EXISTS idx_human_interrupt_requests_attempt
  ON human_interrupt_requests(attempt_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_human_interrupt_requests_work_item
  ON human_interrupt_requests(work_item_id, created_at DESC);

CREATE TABLE IF NOT EXISTS human_interrupt_resolutions (
  interrupt_id TEXT PRIMARY KEY REFERENCES human_interrupt_requests(interrupt_id),
  decision TEXT NOT NULL CHECK (decision IN ('resume', 'cancel')),
  response_json TEXT CHECK (response_json IS NULL OR json_valid(response_json) = 1),
  response_hash TEXT CHECK (response_hash IS NULL OR length(response_hash) = 64),
  resolved_by_actor_id TEXT NOT NULL CHECK (length(trim(resolved_by_actor_id)) > 0),
  reason TEXT,
  resume_approval_id TEXT REFERENCES execution_plan_approvals(approval_id),
  resolved_at TEXT NOT NULL CHECK (julianday(resolved_at) IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS human_interrupt_resumptions (
  interrupt_id TEXT PRIMARY KEY REFERENCES human_interrupt_requests(interrupt_id),
  lease_id TEXT NOT NULL REFERENCES attempt_leases(lease_id),
  worker_id TEXT NOT NULL CHECK (length(trim(worker_id)) > 0),
  fencing_epoch INTEGER NOT NULL CHECK (fencing_epoch > 0),
  resumed_at TEXT NOT NULL CHECK (julianday(resumed_at) IS NOT NULL)
);

CREATE TRIGGER IF NOT EXISTS human_interrupt_requests_no_update
BEFORE UPDATE ON human_interrupt_requests BEGIN
  SELECT RAISE(ABORT, 'human_interrupt_requests: append-only');
END;
CREATE TRIGGER IF NOT EXISTS human_interrupt_requests_no_delete
BEFORE DELETE ON human_interrupt_requests BEGIN
  SELECT RAISE(ABORT, 'human_interrupt_requests: append-only');
END;
CREATE TRIGGER IF NOT EXISTS human_interrupt_resolutions_no_update
BEFORE UPDATE ON human_interrupt_resolutions BEGIN
  SELECT RAISE(ABORT, 'human_interrupt_resolutions: append-only');
END;
CREATE TRIGGER IF NOT EXISTS human_interrupt_resolutions_no_delete
BEFORE DELETE ON human_interrupt_resolutions BEGIN
  SELECT RAISE(ABORT, 'human_interrupt_resolutions: append-only');
END;
CREATE TRIGGER IF NOT EXISTS human_interrupt_resumptions_no_update
BEFORE UPDATE ON human_interrupt_resumptions BEGIN
  SELECT RAISE(ABORT, 'human_interrupt_resumptions: append-only');
END;
CREATE TRIGGER IF NOT EXISTS human_interrupt_resumptions_no_delete
BEFORE DELETE ON human_interrupt_resumptions BEGIN
  SELECT RAISE(ABORT, 'human_interrupt_resumptions: append-only');
END;

-- A cooperative HITL checkpoint is a valid transition from active execution.
-- The interrupt operation revokes the active lease in the same transaction.
DROP TRIGGER IF EXISTS execution_attempts_transition_guard;
CREATE TRIGGER execution_attempts_transition_guard
BEFORE UPDATE ON execution_attempts
WHEN NEW.attempt_id IS NOT OLD.attempt_id
  OR NEW.work_item_id IS NOT OLD.work_item_id
  OR NEW.plan_id IS NOT OLD.plan_id
  OR NEW.plan_hash IS NOT OLD.plan_hash
  OR NEW.attempt_number IS NOT OLD.attempt_number
  OR NEW.protocol_version IS NOT OLD.protocol_version
  OR NEW.input_hash IS NOT OLD.input_hash
  OR NEW.created_at IS NOT OLD.created_at
  OR NOT (
    (OLD.status = 'pending' AND NEW.status IN ('leased', 'cancelled'))
    OR (OLD.status = 'leased' AND NEW.status IN ('running', 'cancellation_requested', 'interrupted', 'cancelled'))
    OR (OLD.status = 'running' AND NEW.status IN ('cancellation_requested', 'interrupted', 'succeeded', 'failed', 'cancelled', 'unknown'))
    OR (OLD.status = 'cancellation_requested' AND NEW.status IN ('cancelled', 'failed', 'unknown', 'quarantined'))
    OR (OLD.status = 'interrupted' AND NEW.status IN ('leased', 'cancelled'))
    OR (OLD.status = 'unknown' AND NEW.status = 'quarantined')
  )
BEGIN
  SELECT RAISE(ABORT, 'execution_attempts: immutable input or invalid transition');
END;

CREATE TABLE IF NOT EXISTS workspace_allocation_authority_bindings (
  binding_id TEXT PRIMARY KEY,
  allocation_id TEXT NOT NULL REFERENCES workspace_allocations(allocation_id),
  attempt_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  worker_id TEXT NOT NULL CHECK (length(trim(worker_id)) > 0),
  fencing_epoch INTEGER NOT NULL CHECK (fencing_epoch > 0),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (allocation_id, fencing_epoch),
  FOREIGN KEY (lease_id, attempt_id) REFERENCES attempt_leases(lease_id, attempt_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_authority_bindings_latest
  ON workspace_allocation_authority_bindings(allocation_id, fencing_epoch DESC);

CREATE TRIGGER IF NOT EXISTS workspace_allocation_authority_bindings_no_update
BEFORE UPDATE ON workspace_allocation_authority_bindings BEGIN
  SELECT RAISE(ABORT, 'workspace_allocation_authority_bindings: append-only');
END;
CREATE TRIGGER IF NOT EXISTS workspace_allocation_authority_bindings_no_delete
BEFORE DELETE ON workspace_allocation_authority_bindings BEGIN
  SELECT RAISE(ABORT, 'workspace_allocation_authority_bindings: append-only');
END;
