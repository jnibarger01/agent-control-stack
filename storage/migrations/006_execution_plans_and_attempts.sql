CREATE TABLE IF NOT EXISTS execution_plans (
  plan_id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  plan_number INTEGER NOT NULL CHECK (plan_number > 0),
  schema_version TEXT NOT NULL CHECK (schema_version = 'acs.execution-plan.v1'),
  definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
  plan_hash TEXT NOT NULL CHECK (length(plan_hash) = 64 AND plan_hash = lower(plan_hash)),
  subject_input_hash TEXT NOT NULL CHECK (
    length(subject_input_hash) = 64 AND subject_input_hash = lower(subject_input_hash)
  ),
  created_by_actor_id TEXT NOT NULL CHECK (length(trim(created_by_actor_id)) > 0),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (work_item_id, plan_number),
  UNIQUE (work_item_id, plan_hash),
  UNIQUE (plan_id, work_item_id),
  CHECK (length(trim(plan_id)) > 0)
);

CREATE TABLE IF NOT EXISTS execution_plan_heads (
  work_item_id TEXT PRIMARY KEY REFERENCES work_items(id),
  current_plan_id TEXT NOT NULL,
  current_plan_hash TEXT NOT NULL CHECK (
    length(current_plan_hash) = 64 AND current_plan_hash = lower(current_plan_hash)
  ),
  revision INTEGER NOT NULL CHECK (revision > 0),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
  FOREIGN KEY (current_plan_id, work_item_id) REFERENCES execution_plans(plan_id, work_item_id)
);

CREATE TABLE IF NOT EXISTS execution_plan_admissions (
  admission_id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  plan_id TEXT NOT NULL,
  plan_hash TEXT NOT NULL CHECK (length(plan_hash) = 64 AND plan_hash = lower(plan_hash)),
  policy_version TEXT NOT NULL CHECK (length(trim(policy_version)) > 0),
  policy_decision_hash TEXT NOT NULL CHECK (
    length(policy_decision_hash) = 64 AND policy_decision_hash = lower(policy_decision_hash)
  ),
  requires_approval INTEGER NOT NULL CHECK (requires_approval IN (0, 1)),
  admitted_by_actor_id TEXT NOT NULL CHECK (length(trim(admitted_by_actor_id)) > 0),
  admitted_at TEXT NOT NULL CHECK (julianday(admitted_at) IS NOT NULL),
  UNIQUE (plan_id, policy_version, policy_decision_hash),
  UNIQUE (admission_id, work_item_id),
  FOREIGN KEY (plan_id, work_item_id) REFERENCES execution_plans(plan_id, work_item_id)
);

CREATE TABLE IF NOT EXISTS execution_plan_approvals (
  approval_id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  plan_id TEXT NOT NULL,
  plan_hash TEXT NOT NULL CHECK (length(plan_hash) = 64 AND plan_hash = lower(plan_hash)),
  action_hash TEXT NOT NULL CHECK (length(action_hash) = 64 AND action_hash = lower(action_hash)),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64 AND request_hash = lower(request_hash)),
  approved_by_actor_id TEXT NOT NULL CHECK (length(trim(approved_by_actor_id)) > 0),
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('granted', 'consumed', 'invalidated', 'expired')),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  expires_at TEXT NOT NULL CHECK (
    julianday(expires_at) IS NOT NULL AND julianday(expires_at) > julianday(created_at)
  ),
  consumed_at TEXT CHECK (consumed_at IS NULL OR julianday(consumed_at) IS NOT NULL),
  invalidated_at TEXT CHECK (invalidated_at IS NULL OR julianday(invalidated_at) IS NOT NULL),
  invalidation_reason TEXT,
  UNIQUE (approval_id, work_item_id),
  FOREIGN KEY (plan_id, work_item_id) REFERENCES execution_plans(plan_id, work_item_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_plan_approvals_one_granted
  ON execution_plan_approvals(work_item_id, plan_hash, action_hash)
  WHERE status = 'granted';
CREATE INDEX IF NOT EXISTS idx_execution_plan_approvals_lookup
  ON execution_plan_approvals(work_item_id, plan_hash, action_hash, status, expires_at);

CREATE TABLE IF NOT EXISTS execution_attempts (
  attempt_id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  plan_id TEXT NOT NULL,
  plan_hash TEXT NOT NULL CHECK (length(plan_hash) = 64 AND plan_hash = lower(plan_hash)),
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  protocol_version TEXT NOT NULL CHECK (protocol_version = 'acs.worker.v2'),
  input_hash TEXT NOT NULL CHECK (length(input_hash) = 64 AND input_hash = lower(input_hash)),
  status TEXT NOT NULL CHECK (
    status IN (
      'pending',
      'leased',
      'running',
      'cancellation_requested',
      'interrupted',
      'succeeded',
      'failed',
      'cancelled',
      'unknown',
      'quarantined'
    )
  ),
  current_fencing_epoch INTEGER NOT NULL DEFAULT 0 CHECK (current_fencing_epoch >= 0),
  claimed_by_worker_id TEXT,
  started_at TEXT CHECK (started_at IS NULL OR julianday(started_at) IS NOT NULL),
  cancellation_requested_at TEXT CHECK (
    cancellation_requested_at IS NULL OR julianday(cancellation_requested_at) IS NOT NULL
  ),
  terminal_at TEXT CHECK (terminal_at IS NULL OR julianday(terminal_at) IS NOT NULL),
  outcome_code TEXT,
  recovery_reason TEXT,
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
  UNIQUE (work_item_id, attempt_number),
  UNIQUE (attempt_id, work_item_id),
  FOREIGN KEY (plan_id, work_item_id) REFERENCES execution_plans(plan_id, work_item_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_attempts_one_active_work_item
  ON execution_attempts(work_item_id)
  WHERE status IN ('pending', 'leased', 'running', 'cancellation_requested', 'interrupted');
CREATE INDEX IF NOT EXISTS idx_execution_attempts_work_item
  ON execution_attempts(work_item_id, attempt_number);
CREATE INDEX IF NOT EXISTS idx_execution_attempts_status
  ON execution_attempts(status, updated_at);

CREATE TABLE IF NOT EXISTS attempt_leases (
  lease_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  admission_id TEXT NOT NULL,
  approval_id TEXT,
  worker_id TEXT NOT NULL CHECK (length(trim(worker_id)) > 0),
  token_hash TEXT NOT NULL CHECK (length(token_hash) = 64 AND token_hash = lower(token_hash)),
  plan_hash TEXT NOT NULL CHECK (length(plan_hash) = 64 AND plan_hash = lower(plan_hash)),
  input_hash TEXT NOT NULL CHECK (length(input_hash) = 64 AND input_hash = lower(input_hash)),
  fencing_epoch INTEGER NOT NULL CHECK (fencing_epoch > 0),
  protocol_version TEXT NOT NULL CHECK (protocol_version = 'acs.worker.v2'),
  policy_version TEXT NOT NULL CHECK (length(trim(policy_version)) > 0),
  policy_decision_hash TEXT NOT NULL CHECK (
    length(policy_decision_hash) = 64 AND policy_decision_hash = lower(policy_decision_hash)
  ),
  issued_at TEXT NOT NULL CHECK (julianday(issued_at) IS NOT NULL),
  expires_at TEXT NOT NULL CHECK (
    julianday(expires_at) IS NOT NULL AND julianday(expires_at) > julianday(issued_at)
  ),
  max_expires_at TEXT NOT NULL CHECK (
    julianday(max_expires_at) IS NOT NULL AND julianday(max_expires_at) >= julianday(expires_at)
  ),
  last_renewed_at TEXT NOT NULL CHECK (julianday(last_renewed_at) IS NOT NULL),
  status TEXT NOT NULL CHECK (status IN ('active', 'consumed', 'expired', 'revoked')),
  closed_at TEXT CHECK (closed_at IS NULL OR julianday(closed_at) IS NOT NULL),
  UNIQUE (attempt_id, fencing_epoch),
  UNIQUE (lease_id, attempt_id),
  FOREIGN KEY (attempt_id, work_item_id) REFERENCES execution_attempts(attempt_id, work_item_id),
  FOREIGN KEY (admission_id, work_item_id) REFERENCES execution_plan_admissions(admission_id, work_item_id),
  FOREIGN KEY (approval_id, work_item_id) REFERENCES execution_plan_approvals(approval_id, work_item_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_attempt_leases_one_active_attempt
  ON attempt_leases(attempt_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_attempt_leases_expiry
  ON attempt_leases(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_attempt_leases_worker
  ON attempt_leases(worker_id, status);

CREATE TABLE IF NOT EXISTS attempt_results (
  result_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL UNIQUE,
  work_item_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  worker_id TEXT NOT NULL CHECK (length(trim(worker_id)) > 0),
  fencing_epoch INTEGER NOT NULL CHECK (fencing_epoch > 0),
  protocol_version TEXT NOT NULL CHECK (protocol_version = 'acs.worker.v2'),
  idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) > 0),
  plan_hash TEXT NOT NULL CHECK (length(plan_hash) = 64 AND plan_hash = lower(plan_hash)),
  input_hash TEXT NOT NULL CHECK (length(input_hash) = 64 AND input_hash = lower(input_hash)),
  outcome TEXT NOT NULL CHECK (
    outcome IN ('succeeded', 'failed', 'cancelled', 'worker_infrastructure_failure')
  ),
  outcome_certainty TEXT NOT NULL CHECK (outcome_certainty = 'observed'),
  started_at TEXT NOT NULL CHECK (julianday(started_at) IS NOT NULL),
  finished_at TEXT NOT NULL CHECK (
    julianday(finished_at) IS NOT NULL AND julianday(finished_at) >= julianday(started_at)
  ),
  exit_code INTEGER CHECK (exit_code IS NULL OR (exit_code >= -255 AND exit_code <= 255)),
  summary TEXT NOT NULL,
  stdout TEXT,
  stderr TEXT,
  structured_output_json TEXT NOT NULL CHECK (json_valid(structured_output_json)),
  error TEXT,
  resource_usage_json TEXT CHECK (resource_usage_json IS NULL OR json_valid(resource_usage_json)),
  simulation_metadata_json TEXT NOT NULL CHECK (
    json_valid(simulation_metadata_json)
    AND json_extract(simulation_metadata_json, '$.executionMode') = 'dry_run'
    AND json_extract(simulation_metadata_json, '$.simulated') = 1
  ),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64 AND payload_hash = lower(payload_hash)),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (worker_id, idempotency_key),
  FOREIGN KEY (attempt_id, work_item_id) REFERENCES execution_attempts(attempt_id, work_item_id),
  FOREIGN KEY (lease_id, attempt_id) REFERENCES attempt_leases(lease_id, attempt_id),
  CHECK (outcome <> 'succeeded' OR exit_code IS NULL OR exit_code = 0),
  CHECK (outcome <> 'cancelled' OR exit_code IS NULL)
);

CREATE INDEX IF NOT EXISTS idx_attempt_results_work_item
  ON attempt_results(work_item_id, created_at);
CREATE INDEX IF NOT EXISTS idx_attempt_results_lease
  ON attempt_results(lease_id);

CREATE TABLE IF NOT EXISTS attempt_cancellation_requests (
  cancellation_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL UNIQUE,
  work_item_id TEXT NOT NULL,
  requested_by_actor_id TEXT NOT NULL CHECK (length(trim(requested_by_actor_id)) > 0),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  requested_at TEXT NOT NULL CHECK (julianday(requested_at) IS NOT NULL),
  observed_fencing_epoch INTEGER NOT NULL CHECK (observed_fencing_epoch > 0),
  FOREIGN KEY (attempt_id, work_item_id) REFERENCES execution_attempts(attempt_id, work_item_id)
);

CREATE TRIGGER IF NOT EXISTS execution_plans_immutable_guard
BEFORE UPDATE ON execution_plans
BEGIN
  SELECT RAISE(ABORT, 'execution_plans: immutable');
END;

CREATE TRIGGER IF NOT EXISTS execution_plans_no_delete
BEFORE DELETE ON execution_plans
BEGIN
  SELECT RAISE(ABORT, 'execution_plans: append-only');
END;

CREATE TRIGGER IF NOT EXISTS execution_plan_heads_binding_guard_insert
BEFORE INSERT ON execution_plan_heads
WHEN NOT EXISTS (
  SELECT 1 FROM execution_plans
  WHERE plan_id = NEW.current_plan_id
    AND work_item_id = NEW.work_item_id
    AND plan_hash = NEW.current_plan_hash
    AND plan_number = NEW.revision
)
BEGIN
  SELECT RAISE(ABORT, 'execution_plan_heads: current plan binding is invalid');
END;

CREATE TRIGGER IF NOT EXISTS execution_plan_heads_binding_guard_update
BEFORE UPDATE ON execution_plan_heads
WHEN NEW.work_item_id IS NOT OLD.work_item_id
  OR NEW.revision <= OLD.revision
  OR NOT EXISTS (
    SELECT 1 FROM execution_plans
    WHERE plan_id = NEW.current_plan_id
      AND work_item_id = NEW.work_item_id
      AND plan_hash = NEW.current_plan_hash
      AND plan_number = NEW.revision
  )
BEGIN
  SELECT RAISE(ABORT, 'execution_plan_heads: invalid current plan transition');
END;

CREATE TRIGGER IF NOT EXISTS execution_plan_heads_no_delete
BEFORE DELETE ON execution_plan_heads
BEGIN
  SELECT RAISE(ABORT, 'execution_plan_heads: history cannot be detached');
END;

CREATE TRIGGER IF NOT EXISTS execution_plan_admissions_binding_guard
BEFORE INSERT ON execution_plan_admissions
WHEN NOT EXISTS (
  SELECT 1 FROM execution_plans
  WHERE plan_id = NEW.plan_id
    AND work_item_id = NEW.work_item_id
    AND plan_hash = NEW.plan_hash
)
BEGIN
  SELECT RAISE(ABORT, 'execution_plan_admissions: plan binding is invalid');
END;

CREATE TRIGGER IF NOT EXISTS execution_plan_admissions_immutable_guard
BEFORE UPDATE ON execution_plan_admissions
BEGIN
  SELECT RAISE(ABORT, 'execution_plan_admissions: immutable');
END;

CREATE TRIGGER IF NOT EXISTS execution_plan_admissions_no_delete
BEFORE DELETE ON execution_plan_admissions
BEGIN
  SELECT RAISE(ABORT, 'execution_plan_admissions: append-only');
END;

CREATE TRIGGER IF NOT EXISTS execution_plan_approvals_binding_guard
BEFORE INSERT ON execution_plan_approvals
WHEN NOT EXISTS (
  SELECT 1 FROM execution_plans
  WHERE plan_id = NEW.plan_id
    AND work_item_id = NEW.work_item_id
    AND plan_hash = NEW.plan_hash
)
BEGIN
  SELECT RAISE(ABORT, 'execution_plan_approvals: plan binding is invalid');
END;

CREATE TRIGGER IF NOT EXISTS execution_plan_approvals_transition_guard
BEFORE UPDATE ON execution_plan_approvals
WHEN NEW.approval_id IS NOT OLD.approval_id
  OR NEW.work_item_id IS NOT OLD.work_item_id
  OR NEW.plan_id IS NOT OLD.plan_id
  OR NEW.plan_hash IS NOT OLD.plan_hash
  OR NEW.action_hash IS NOT OLD.action_hash
  OR NEW.request_hash IS NOT OLD.request_hash
  OR NEW.approved_by_actor_id IS NOT OLD.approved_by_actor_id
  OR NEW.reason IS NOT OLD.reason
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.expires_at IS NOT OLD.expires_at
  OR OLD.status <> 'granted'
  OR NEW.status NOT IN ('consumed', 'invalidated', 'expired')
  OR (NEW.status = 'consumed' AND NEW.consumed_at IS NULL)
  -- A grant that outlived its expiry must not be consumable just because no
  -- sweeper has flipped it to 'expired' yet; check the clock atomically with
  -- the consuming transition, not only in a separate expiry sweep.
  OR (NEW.status = 'consumed' AND julianday(NEW.consumed_at) > julianday(OLD.expires_at))
  OR (NEW.status = 'invalidated' AND (NEW.invalidated_at IS NULL OR NEW.invalidation_reason IS NULL))
BEGIN
  SELECT RAISE(ABORT, 'execution_plan_approvals: immutable binding or invalid transition');
END;

CREATE TRIGGER IF NOT EXISTS execution_plan_approvals_no_delete
BEFORE DELETE ON execution_plan_approvals
BEGIN
  SELECT RAISE(ABORT, 'execution_plan_approvals: append-only');
END;

CREATE TRIGGER IF NOT EXISTS execution_attempts_binding_guard_insert
BEFORE INSERT ON execution_attempts
-- Must bind to the CURRENT plan head, not merely any historical plan the
-- work item has ever had: once a plan is superseded, attempts against it
-- must stop, even though the old plan/admission rows remain (append-only).
WHEN NOT EXISTS (
  SELECT 1
  FROM execution_plans AS plans
  JOIN execution_plan_heads AS heads
    ON heads.work_item_id = plans.work_item_id
   AND heads.current_plan_id = plans.plan_id
   AND heads.current_plan_hash = plans.plan_hash
  WHERE plans.plan_id = NEW.plan_id
    AND plans.work_item_id = NEW.work_item_id
    AND plans.plan_hash = NEW.plan_hash
)
BEGIN
  SELECT RAISE(ABORT, 'execution_attempts: plan binding is invalid or superseded');
END;

CREATE TRIGGER IF NOT EXISTS execution_attempts_state_guard_insert
BEFORE INSERT ON execution_attempts
WHEN NEW.status <> 'pending'
  OR NEW.current_fencing_epoch <> 0
  OR NEW.claimed_by_worker_id IS NOT NULL
  OR NEW.started_at IS NOT NULL
  OR NEW.cancellation_requested_at IS NOT NULL
  OR NEW.terminal_at IS NOT NULL
  OR NEW.outcome_code IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'execution_attempts: attempts must begin pending');
END;

CREATE TRIGGER IF NOT EXISTS execution_attempts_transition_guard
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
    OR (OLD.status = 'running' AND NEW.status IN ('cancellation_requested', 'succeeded', 'failed', 'cancelled', 'unknown'))
    OR (OLD.status = 'cancellation_requested' AND NEW.status IN ('cancelled', 'failed', 'unknown', 'quarantined'))
    OR (OLD.status = 'interrupted' AND NEW.status IN ('leased', 'cancelled'))
    OR (OLD.status = 'unknown' AND NEW.status = 'quarantined')
  )
BEGIN
  SELECT RAISE(ABORT, 'execution_attempts: immutable input or invalid transition');
END;

CREATE TRIGGER IF NOT EXISTS execution_attempts_state_guard_update
BEFORE UPDATE ON execution_attempts
WHEN NEW.current_fencing_epoch < OLD.current_fencing_epoch
  OR (NEW.status IN ('leased', 'running', 'cancellation_requested') AND (
    NEW.current_fencing_epoch <= 0 OR NEW.claimed_by_worker_id IS NULL
  ))
  OR (NEW.status = 'running' AND NEW.started_at IS NULL)
  OR (NEW.status = 'cancellation_requested' AND NEW.cancellation_requested_at IS NULL)
  OR (NEW.status IN ('succeeded', 'failed', 'cancelled', 'unknown', 'quarantined') AND (
    NEW.terminal_at IS NULL OR NEW.outcome_code IS NULL
  ))
  OR (NEW.status NOT IN ('succeeded', 'failed', 'cancelled', 'unknown', 'quarantined') AND NEW.terminal_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'execution_attempts: invalid state fields');
END;

CREATE TRIGGER IF NOT EXISTS execution_attempts_no_delete
BEFORE DELETE ON execution_attempts
BEGIN
  SELECT RAISE(ABORT, 'execution_attempts: append-only');
END;

CREATE TRIGGER IF NOT EXISTS attempt_leases_binding_guard
BEFORE INSERT ON attempt_leases
-- When the admission required approval, a lease must reference a granted,
-- unexpired, unconsumed approval bound to the same plan - otherwise a
-- policy-admitted high-risk plan could be leased on admission alone, with
-- no proof a human ever approved it. When approval wasn't required, no
-- approval_id may be attached (nothing to bind it to, and it would imply
-- an approval was consumed for dispatch when policy never asked for one).
WHEN NOT EXISTS (
  SELECT 1
  FROM execution_attempts AS attempts
  JOIN execution_plan_admissions AS admissions
    ON admissions.admission_id = NEW.admission_id
   AND admissions.work_item_id = NEW.work_item_id
  WHERE attempts.attempt_id = NEW.attempt_id
    AND attempts.work_item_id = NEW.work_item_id
    AND attempts.plan_hash = NEW.plan_hash
    AND attempts.input_hash = NEW.input_hash
    AND attempts.current_fencing_epoch = NEW.fencing_epoch
    AND attempts.claimed_by_worker_id = NEW.worker_id
    AND attempts.status = 'leased'
    AND admissions.plan_id = attempts.plan_id
    AND admissions.plan_hash = attempts.plan_hash
    AND admissions.policy_version = NEW.policy_version
    AND admissions.policy_decision_hash = NEW.policy_decision_hash
    AND (
      (admissions.requires_approval = 0 AND NEW.approval_id IS NULL)
      OR (
        admissions.requires_approval = 1
        AND NEW.approval_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM execution_plan_approvals AS approvals
          WHERE approvals.approval_id = NEW.approval_id
            AND approvals.work_item_id = NEW.work_item_id
            AND approvals.plan_id = admissions.plan_id
            AND approvals.plan_hash = admissions.plan_hash
            AND approvals.status = 'granted'
            AND julianday(approvals.expires_at) > julianday('now')
        )
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'attempt_leases: attempt, admission, fence, or approval binding is invalid');
END;

CREATE TRIGGER IF NOT EXISTS attempt_leases_consume_approval
AFTER INSERT ON attempt_leases
WHEN NEW.approval_id IS NOT NULL
BEGIN
  -- Consume atomically with lease issuance, in the same transaction as the
  -- INSERT this fires from - there is no separate step where dispatch could
  -- succeed without the approval being spent, or vice versa.
  UPDATE execution_plan_approvals
  SET status = 'consumed', consumed_at = NEW.issued_at
  WHERE approval_id = NEW.approval_id
    AND work_item_id = NEW.work_item_id
    AND status = 'granted';
END;

CREATE TRIGGER IF NOT EXISTS attempt_leases_transition_guard
BEFORE UPDATE ON attempt_leases
WHEN NEW.lease_id IS NOT OLD.lease_id
  OR NEW.attempt_id IS NOT OLD.attempt_id
  OR NEW.work_item_id IS NOT OLD.work_item_id
  OR NEW.admission_id IS NOT OLD.admission_id
  OR NEW.approval_id IS NOT OLD.approval_id
  OR NEW.worker_id IS NOT OLD.worker_id
  OR NEW.token_hash IS NOT OLD.token_hash
  OR NEW.plan_hash IS NOT OLD.plan_hash
  OR NEW.input_hash IS NOT OLD.input_hash
  OR NEW.fencing_epoch IS NOT OLD.fencing_epoch
  OR NEW.protocol_version IS NOT OLD.protocol_version
  OR NEW.policy_version IS NOT OLD.policy_version
  OR NEW.policy_decision_hash IS NOT OLD.policy_decision_hash
  OR NEW.issued_at IS NOT OLD.issued_at
  OR NEW.max_expires_at IS NOT OLD.max_expires_at
  OR (
    OLD.status = 'active'
    AND NEW.status = 'active'
    AND (
      julianday(NEW.expires_at) < julianday(OLD.expires_at)
      OR julianday(NEW.expires_at) > julianday(NEW.max_expires_at)
      OR julianday(NEW.last_renewed_at) < julianday(OLD.last_renewed_at)
      OR NEW.closed_at IS NOT NULL
    )
  )
  OR (
    OLD.status = 'active'
    AND NEW.status IN ('consumed', 'expired', 'revoked')
    AND NEW.closed_at IS NULL
  )
  OR OLD.status <> 'active'
  OR NEW.status NOT IN ('active', 'consumed', 'expired', 'revoked')
BEGIN
  SELECT RAISE(ABORT, 'attempt_leases: immutable binding or invalid transition');
END;

CREATE TRIGGER IF NOT EXISTS attempt_leases_no_delete
BEFORE DELETE ON attempt_leases
BEGIN
  SELECT RAISE(ABORT, 'attempt_leases: append-only');
END;

CREATE TRIGGER IF NOT EXISTS attempt_results_binding_guard
BEFORE INSERT ON attempt_results
WHEN NOT EXISTS (
  SELECT 1
  FROM attempt_leases AS leases
  JOIN execution_attempts AS attempts
    ON attempts.attempt_id = NEW.attempt_id
   AND attempts.work_item_id = NEW.work_item_id
  WHERE leases.lease_id = NEW.lease_id
    AND leases.attempt_id = NEW.attempt_id
    AND leases.worker_id = NEW.worker_id
    AND leases.fencing_epoch = NEW.fencing_epoch
    AND leases.protocol_version = NEW.protocol_version
    AND leases.plan_hash = NEW.plan_hash
    AND leases.input_hash = NEW.input_hash
    AND leases.status = 'active'
    -- 'active' status alone is insufficient: a lease whose wall-clock expiry
    -- has passed but hasn't been swept to 'expired' yet must still be
    -- rejected here, in the same transaction as result acceptance.
    AND julianday(leases.expires_at) > julianday('now')
    AND attempts.current_fencing_epoch = NEW.fencing_epoch
    AND attempts.claimed_by_worker_id = NEW.worker_id
    AND attempts.status IN ('running', 'cancellation_requested')
)
BEGIN
  SELECT RAISE(ABORT, 'attempt_results: active attempt lease and fence binding is required');
END;

CREATE TRIGGER IF NOT EXISTS attempt_results_cancel_race_guard
BEFORE INSERT ON attempt_results
WHEN NEW.outcome = 'succeeded'
  AND EXISTS (
    SELECT 1 FROM execution_attempts
    WHERE attempt_id = NEW.attempt_id AND status = 'cancellation_requested'
  )
BEGIN
  SELECT RAISE(ABORT, 'attempt_results: success is forbidden after cancellation');
END;

CREATE TRIGGER IF NOT EXISTS attempt_results_immutable_guard
BEFORE UPDATE ON attempt_results
BEGIN
  SELECT RAISE(ABORT, 'attempt_results: append-only');
END;

CREATE TRIGGER IF NOT EXISTS attempt_results_no_delete
BEFORE DELETE ON attempt_results
BEGIN
  SELECT RAISE(ABORT, 'attempt_results: append-only');
END;

CREATE TRIGGER IF NOT EXISTS attempt_cancellation_requests_binding_guard
BEFORE INSERT ON attempt_cancellation_requests
WHEN NOT EXISTS (
  SELECT 1 FROM execution_attempts
  WHERE attempt_id = NEW.attempt_id
    AND work_item_id = NEW.work_item_id
    AND current_fencing_epoch = NEW.observed_fencing_epoch
    AND status IN ('leased', 'running', 'cancellation_requested')
)
BEGIN
  SELECT RAISE(ABORT, 'attempt_cancellation_requests: active attempt binding is required');
END;

CREATE TRIGGER IF NOT EXISTS attempt_cancellation_requests_immutable_guard
BEFORE UPDATE ON attempt_cancellation_requests
BEGIN
  SELECT RAISE(ABORT, 'attempt_cancellation_requests: immutable');
END;

CREATE TRIGGER IF NOT EXISTS attempt_cancellation_requests_no_delete
BEFORE DELETE ON attempt_cancellation_requests
BEGIN
  SELECT RAISE(ABORT, 'attempt_cancellation_requests: append-only');
END;

DROP TRIGGER IF EXISTS work_items_state_guard_insert;
DROP TRIGGER IF EXISTS work_items_state_guard_update;

CREATE TRIGGER work_items_state_guard_insert
BEFORE INSERT ON work_items
BEGIN
  SELECT RAISE(ABORT, 'work_items: invalid status')
    WHERE NEW.status IS NULL OR NEW.status NOT IN (
      'draft', 'pending_policy', 'needs_approval', 'approved', 'running', 'cancelling',
      'succeeded', 'failed', 'blocked', 'cancelled', 'rejected', 'unknown', 'quarantined'
    );
  SELECT RAISE(ABORT, 'work_items: invalid risk')
    WHERE NEW.risk IS NULL OR NEW.risk NOT IN ('low', 'medium', 'high', 'critical');
  SELECT RAISE(ABORT, 'work_items: target_json must be valid JSON')
    WHERE NEW.target_json IS NULL OR json_valid(NEW.target_json) = 0;
  SELECT RAISE(ABORT, 'work_items: requested_actions_json must be valid JSON')
    WHERE NEW.requested_actions_json IS NULL OR json_valid(NEW.requested_actions_json) = 0;
  SELECT RAISE(ABORT, 'work_items: result_json must be valid JSON')
    WHERE NEW.result_json IS NOT NULL AND json_valid(NEW.result_json) = 0;
END;

CREATE TRIGGER work_items_state_guard_update
BEFORE UPDATE ON work_items
BEGIN
  SELECT RAISE(ABORT, 'work_items: invalid status')
    WHERE NEW.status IS NULL OR NEW.status NOT IN (
      'draft', 'pending_policy', 'needs_approval', 'approved', 'running', 'cancelling',
      'succeeded', 'failed', 'blocked', 'cancelled', 'rejected', 'unknown', 'quarantined'
    );
  SELECT RAISE(ABORT, 'work_items: invalid risk')
    WHERE NEW.risk IS NULL OR NEW.risk NOT IN ('low', 'medium', 'high', 'critical');
  SELECT RAISE(ABORT, 'work_items: target_json must be valid JSON')
    WHERE NEW.target_json IS NULL OR json_valid(NEW.target_json) = 0;
  SELECT RAISE(ABORT, 'work_items: requested_actions_json must be valid JSON')
    WHERE NEW.requested_actions_json IS NULL OR json_valid(NEW.requested_actions_json) = 0;
  SELECT RAISE(ABORT, 'work_items: result_json must be valid JSON')
    WHERE NEW.result_json IS NOT NULL AND json_valid(NEW.result_json) = 0;
END;

DROP TRIGGER IF EXISTS work_items_terminal_immutable_guard;

CREATE TRIGGER work_items_terminal_immutable_guard
BEFORE UPDATE ON work_items
WHEN OLD.status IN ('succeeded', 'failed', 'cancelled', 'rejected', 'unknown', 'quarantined')
  AND NOT (
    OLD.status = 'unknown'
    AND NEW.status = 'quarantined'
    AND NEW.id IS OLD.id
    AND NEW.title IS OLD.title
    AND NEW.requester IS OLD.requester
    AND NEW.requester_subject IS OLD.requester_subject
    AND NEW.intent IS OLD.intent
    AND NEW.target_json IS OLD.target_json
    AND NEW.requested_actions_json IS OLD.requested_actions_json
    AND NEW.risk IS OLD.risk
    AND NEW.result_json IS OLD.result_json
    AND NEW.worker_id IS OLD.worker_id
    AND NEW.lease_token_hash IS OLD.lease_token_hash
    AND NEW.started_at IS OLD.started_at
    AND NEW.lease_expires_at IS OLD.lease_expires_at
    AND NEW.created_at IS OLD.created_at
  )
  AND NOT (
    OLD.status IN ('failed', 'quarantined')
    AND OLD.result_json IS NULL
    AND NEW.status = 'pending_policy'
    AND NEW.id IS OLD.id
    AND NEW.title IS OLD.title
    AND NEW.requester IS OLD.requester
    AND NEW.requester_subject IS OLD.requester_subject
    AND NEW.intent IS OLD.intent
    AND NEW.target_json IS OLD.target_json
    AND NEW.requested_actions_json IS OLD.requested_actions_json
    AND NEW.risk IS OLD.risk
    AND NEW.result_json IS OLD.result_json
    AND NEW.worker_id IS OLD.worker_id
    AND NEW.lease_token_hash IS OLD.lease_token_hash
    AND NEW.started_at IS OLD.started_at
    AND NEW.lease_expires_at IS OLD.lease_expires_at
    AND NEW.created_at IS OLD.created_at
  )
BEGIN
  SELECT RAISE(ABORT, 'work_items: terminal history is immutable');
END;

-- Recreate this guard after the terminal guard so accepted legacy results keep
-- their more specific immutability failure contract.
DROP TRIGGER IF EXISTS work_items_result_immutable_guard;

CREATE TRIGGER work_items_result_immutable_guard
BEFORE UPDATE ON work_items
WHEN OLD.result_json IS NOT NULL
  AND (
    NEW.id IS NOT OLD.id OR
    NEW.title IS NOT OLD.title OR
    NEW.requester IS NOT OLD.requester OR
    NEW.requester_subject IS NOT OLD.requester_subject OR
    NEW.status IS NOT OLD.status OR
    NEW.intent IS NOT OLD.intent OR
    NEW.target_json IS NOT OLD.target_json OR
    NEW.requested_actions_json IS NOT OLD.requested_actions_json OR
    NEW.risk IS NOT OLD.risk OR
    NEW.result_json IS NOT OLD.result_json OR
    NEW.worker_id IS NOT OLD.worker_id OR
    NEW.lease_token_hash IS NOT OLD.lease_token_hash OR
    NEW.started_at IS NOT OLD.started_at OR
    NEW.lease_expires_at IS NOT OLD.lease_expires_at OR
    NEW.created_at IS NOT OLD.created_at OR
    NEW.updated_at IS NOT OLD.updated_at
  )
BEGIN
  SELECT RAISE(ABORT, 'work_items: accepted result is immutable');
END;
