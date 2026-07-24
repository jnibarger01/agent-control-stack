CREATE TABLE execution_plans (
  plan_id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  plan_number INTEGER NOT NULL CHECK (plan_number > 0),
  schema_version TEXT NOT NULL CHECK (schema_version = 'acs.execution-plan.v1'),
  definition_json TEXT NOT NULL CHECK (json_valid(definition_json)),
  plan_hash TEXT NOT NULL CHECK (
    length(plan_hash) = 64 AND plan_hash NOT GLOB '*[^a-f0-9]*'
  ),
  subject_input_hash TEXT NOT NULL CHECK (
    length(subject_input_hash) = 64 AND subject_input_hash NOT GLOB '*[^a-f0-9]*'
  ),
  created_by_actor_id TEXT NOT NULL CHECK (length(trim(created_by_actor_id)) > 0),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (work_item_id, plan_number),
  UNIQUE (plan_id, work_item_id),
  UNIQUE (work_item_id, plan_hash),
  CHECK (json_extract(definition_json, '$.schemaVersion') = schema_version),
  CHECK (json_extract(definition_json, '$.workItemId') = work_item_id),
  CHECK (json_extract(definition_json, '$.subjectInputHash') = subject_input_hash)
);

CREATE TABLE execution_plan_heads (
  work_item_id TEXT PRIMARY KEY REFERENCES work_items(id),
  plan_id TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  plan_number INTEGER NOT NULL CHECK (plan_number > 0),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
  FOREIGN KEY (plan_id, work_item_id) REFERENCES execution_plans(plan_id, work_item_id),
  FOREIGN KEY (work_item_id, plan_hash) REFERENCES execution_plans(work_item_id, plan_hash),
  UNIQUE (work_item_id, plan_id, plan_hash)
);

CREATE TABLE execution_plan_admissions (
  admission_id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  plan_id TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  admission_hash TEXT NOT NULL CHECK (
    length(admission_hash) = 64 AND admission_hash NOT GLOB '*[^a-f0-9]*'
  ),
  policy_version TEXT NOT NULL CHECK (length(trim(policy_version)) > 0),
  policy_decision_hash TEXT NOT NULL CHECK (
    length(policy_decision_hash) = 64 AND policy_decision_hash NOT GLOB '*[^a-f0-9]*'
  ),
  decision TEXT NOT NULL CHECK (decision IN ('allow', 'require_approval')),
  required_approval_action_hashes_json TEXT NOT NULL CHECK (
    json_valid(required_approval_action_hashes_json)
    AND json_type(required_approval_action_hashes_json) = 'array'
  ),
  admitted_by_actor_id TEXT NOT NULL CHECK (length(trim(admitted_by_actor_id)) > 0),
  admitted_at TEXT NOT NULL CHECK (julianday(admitted_at) IS NOT NULL),
  FOREIGN KEY (plan_id, work_item_id) REFERENCES execution_plans(plan_id, work_item_id),
  FOREIGN KEY (work_item_id, plan_hash) REFERENCES execution_plans(work_item_id, plan_hash),
  UNIQUE (admission_id, work_item_id),
  UNIQUE (work_item_id, admission_hash),
  UNIQUE (plan_id, policy_version, policy_decision_hash),
  CHECK (
    (decision = 'allow' AND json_array_length(required_approval_action_hashes_json) = 0)
    OR
    (decision = 'require_approval' AND json_array_length(required_approval_action_hashes_json) > 0)
  )
);

CREATE TABLE execution_plan_admission_heads (
  work_item_id TEXT PRIMARY KEY REFERENCES work_items(id),
  admission_id TEXT NOT NULL,
  admission_hash TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL),
  FOREIGN KEY (admission_id, work_item_id)
    REFERENCES execution_plan_admissions(admission_id, work_item_id),
  FOREIGN KEY (work_item_id, admission_hash)
    REFERENCES execution_plan_admissions(work_item_id, admission_hash),
  FOREIGN KEY (plan_id, work_item_id) REFERENCES execution_plans(plan_id, work_item_id),
  FOREIGN KEY (work_item_id, plan_hash) REFERENCES execution_plans(work_item_id, plan_hash),
  UNIQUE (work_item_id, admission_id, admission_hash)
);

CREATE TABLE execution_plan_approvals (
  approval_id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  plan_id TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  admission_id TEXT NOT NULL,
  admission_hash TEXT NOT NULL,
  policy_version TEXT NOT NULL CHECK (length(trim(policy_version)) > 0),
  action_hash TEXT NOT NULL CHECK (
    length(action_hash) = 64 AND action_hash NOT GLOB '*[^a-f0-9]*'
  ),
  approval_binding_hash TEXT NOT NULL CHECK (
    length(approval_binding_hash) = 64 AND approval_binding_hash NOT GLOB '*[^a-f0-9]*'
  ),
  approved_by_actor_id TEXT NOT NULL CHECK (length(trim(approved_by_actor_id)) > 0),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  status TEXT NOT NULL CHECK (status IN ('granted', 'consumed', 'expired', 'revoked')),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  expires_at TEXT NOT NULL CHECK (
    julianday(expires_at) IS NOT NULL AND julianday(expires_at) > julianday(created_at)
  ),
  consumed_at TEXT CHECK (consumed_at IS NULL OR julianday(consumed_at) IS NOT NULL),
  FOREIGN KEY (plan_id, work_item_id) REFERENCES execution_plans(plan_id, work_item_id),
  FOREIGN KEY (work_item_id, plan_hash) REFERENCES execution_plans(work_item_id, plan_hash),
  FOREIGN KEY (admission_id, work_item_id)
    REFERENCES execution_plan_admissions(admission_id, work_item_id),
  FOREIGN KEY (work_item_id, admission_hash)
    REFERENCES execution_plan_admissions(work_item_id, admission_hash),
  UNIQUE (admission_id, action_hash),
  CHECK (
    (status = 'consumed' AND consumed_at IS NOT NULL)
    OR
    (status <> 'consumed' AND consumed_at IS NULL)
  )
);

CREATE TABLE execution_attempts (
  attempt_id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  protocol_version TEXT NOT NULL CHECK (protocol_version = 'acs.worker.v2'),
  plan_id TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  admission_id TEXT NOT NULL,
  admission_hash TEXT NOT NULL,
  input_hash TEXT NOT NULL CHECK (
    length(input_hash) = 64 AND input_hash NOT GLOB '*[^a-f0-9]*'
  ),
  worker_id TEXT NOT NULL CHECK (length(trim(worker_id)) > 0),
  fencing_epoch INTEGER NOT NULL CHECK (fencing_epoch > 0),
  status TEXT NOT NULL CHECK (status IN ('leased', 'unknown', 'quarantined')),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  claimed_at TEXT NOT NULL CHECK (julianday(claimed_at) IS NOT NULL),
  FOREIGN KEY (plan_id, work_item_id) REFERENCES execution_plans(plan_id, work_item_id),
  FOREIGN KEY (work_item_id, plan_hash) REFERENCES execution_plans(work_item_id, plan_hash),
  FOREIGN KEY (admission_id, work_item_id)
    REFERENCES execution_plan_admissions(admission_id, work_item_id),
  FOREIGN KEY (work_item_id, admission_hash)
    REFERENCES execution_plan_admissions(work_item_id, admission_hash),
  UNIQUE (work_item_id, attempt_number),
  UNIQUE (attempt_id, work_item_id),
  UNIQUE (attempt_id, fencing_epoch)
);

CREATE UNIQUE INDEX idx_execution_attempts_one_active_work_item
  ON execution_attempts(work_item_id)
  WHERE status = 'leased';

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
  input_hash TEXT NOT NULL CHECK (
    length(input_hash) = 64 AND input_hash NOT GLOB '*[^a-f0-9]*'
  ),
  token_hash TEXT NOT NULL CHECK (
    length(token_hash) = 64 AND token_hash NOT GLOB '*[^a-f0-9]*'
  ),
  fencing_epoch INTEGER NOT NULL CHECK (fencing_epoch > 0),
  issued_at TEXT NOT NULL CHECK (julianday(issued_at) IS NOT NULL),
  expires_at TEXT NOT NULL CHECK (
    julianday(expires_at) IS NOT NULL AND julianday(expires_at) > julianday(issued_at)
  ),
  status TEXT NOT NULL CHECK (status IN ('active', 'consumed', 'expired', 'revoked')),
  closed_at TEXT CHECK (closed_at IS NULL OR julianday(closed_at) IS NOT NULL),
  FOREIGN KEY (attempt_id, work_item_id) REFERENCES execution_attempts(attempt_id, work_item_id),
  FOREIGN KEY (attempt_id, fencing_epoch) REFERENCES execution_attempts(attempt_id, fencing_epoch),
  FOREIGN KEY (plan_id, work_item_id) REFERENCES execution_plans(plan_id, work_item_id),
  FOREIGN KEY (work_item_id, plan_hash) REFERENCES execution_plans(work_item_id, plan_hash),
  FOREIGN KEY (admission_id, work_item_id)
    REFERENCES execution_plan_admissions(admission_id, work_item_id),
  FOREIGN KEY (work_item_id, admission_hash)
    REFERENCES execution_plan_admissions(work_item_id, admission_hash),
  UNIQUE (attempt_id, fencing_epoch),
  UNIQUE (lease_id, attempt_id, work_item_id),
  CHECK (
    (status = 'active' AND closed_at IS NULL)
    OR
    (status <> 'active' AND closed_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX idx_attempt_leases_one_active_attempt
  ON attempt_leases(attempt_id)
  WHERE status = 'active';
CREATE INDEX idx_attempt_leases_expiry ON attempt_leases(status, expires_at);
CREATE INDEX idx_attempt_leases_worker ON attempt_leases(worker_id, status);

CREATE TRIGGER execution_plans_immutable_update
BEFORE UPDATE ON execution_plans
BEGIN
  SELECT RAISE(ABORT, 'execution_plans: immutable');
END;

CREATE TRIGGER execution_plans_immutable_delete
BEFORE DELETE ON execution_plans
BEGIN
  SELECT RAISE(ABORT, 'execution_plans: immutable');
END;

CREATE TRIGGER execution_plan_heads_binding_insert
BEFORE INSERT ON execution_plan_heads
WHEN NOT EXISTS (
  SELECT 1 FROM execution_plans
  WHERE work_item_id = NEW.work_item_id
    AND plan_id = NEW.plan_id
    AND plan_hash = NEW.plan_hash
    AND plan_number = NEW.plan_number
)
BEGIN
  SELECT RAISE(ABORT, 'execution_plan_heads: plan binding mismatch');
END;

CREATE TRIGGER execution_plan_heads_binding_update
BEFORE UPDATE ON execution_plan_heads
WHEN NEW.work_item_id IS NOT OLD.work_item_id
  OR NEW.plan_number <= OLD.plan_number
  OR NOT EXISTS (
    SELECT 1 FROM execution_plans
    WHERE work_item_id = NEW.work_item_id
      AND plan_id = NEW.plan_id
      AND plan_hash = NEW.plan_hash
      AND plan_number = NEW.plan_number
  )
BEGIN
  SELECT RAISE(ABORT, 'execution_plan_heads: invalid head transition');
END;

CREATE TRIGGER execution_plan_heads_no_delete
BEFORE DELETE ON execution_plan_heads
BEGIN
  SELECT RAISE(ABORT, 'execution_plan_heads: append-only authority');
END;

CREATE TRIGGER execution_plan_admissions_binding_insert
BEFORE INSERT ON execution_plan_admissions
WHEN NOT EXISTS (
  SELECT 1 FROM execution_plan_heads
  WHERE work_item_id = NEW.work_item_id
    AND plan_id = NEW.plan_id
    AND plan_hash = NEW.plan_hash
)
BEGIN
  SELECT RAISE(ABORT, 'execution_plan_admissions: current plan binding is required');
END;

CREATE TRIGGER execution_plan_admissions_immutable_update
BEFORE UPDATE ON execution_plan_admissions
BEGIN
  SELECT RAISE(ABORT, 'execution_plan_admissions: immutable');
END;

CREATE TRIGGER execution_plan_admissions_immutable_delete
BEFORE DELETE ON execution_plan_admissions
BEGIN
  SELECT RAISE(ABORT, 'execution_plan_admissions: immutable');
END;

CREATE TRIGGER execution_plan_admission_heads_binding_insert
BEFORE INSERT ON execution_plan_admission_heads
WHEN NOT EXISTS (
  SELECT 1
  FROM execution_plan_admissions AS admission
  JOIN execution_plan_heads AS plan_head
    ON plan_head.work_item_id = admission.work_item_id
   AND plan_head.plan_id = admission.plan_id
   AND plan_head.plan_hash = admission.plan_hash
  WHERE admission.work_item_id = NEW.work_item_id
    AND admission.admission_id = NEW.admission_id
    AND admission.admission_hash = NEW.admission_hash
    AND admission.plan_id = NEW.plan_id
    AND admission.plan_hash = NEW.plan_hash
)
BEGIN
  SELECT RAISE(ABORT, 'execution_plan_admission_heads: admission binding mismatch');
END;

CREATE TRIGGER execution_plan_admission_heads_binding_update
BEFORE UPDATE ON execution_plan_admission_heads
WHEN NEW.work_item_id IS NOT OLD.work_item_id
  OR NOT EXISTS (
    SELECT 1
    FROM execution_plan_admissions AS admission
    JOIN execution_plan_heads AS plan_head
      ON plan_head.work_item_id = admission.work_item_id
     AND plan_head.plan_id = admission.plan_id
     AND plan_head.plan_hash = admission.plan_hash
    WHERE admission.work_item_id = NEW.work_item_id
      AND admission.admission_id = NEW.admission_id
      AND admission.admission_hash = NEW.admission_hash
      AND admission.plan_id = NEW.plan_id
      AND admission.plan_hash = NEW.plan_hash
  )
BEGIN
  SELECT RAISE(ABORT, 'execution_plan_admission_heads: invalid head transition');
END;

CREATE TRIGGER execution_plan_admission_heads_no_delete
BEFORE DELETE ON execution_plan_admission_heads
BEGIN
  SELECT RAISE(ABORT, 'execution_plan_admission_heads: append-only authority');
END;

CREATE TRIGGER execution_plan_approvals_binding_insert
BEFORE INSERT ON execution_plan_approvals
WHEN NOT EXISTS (
  SELECT 1
  FROM execution_plan_admissions AS admission
  JOIN execution_plan_admission_heads AS admission_head
    ON admission_head.work_item_id = admission.work_item_id
   AND admission_head.admission_id = admission.admission_id
   AND admission_head.admission_hash = admission.admission_hash
  WHERE admission.work_item_id = NEW.work_item_id
    AND admission.plan_id = NEW.plan_id
    AND admission.plan_hash = NEW.plan_hash
    AND admission.admission_id = NEW.admission_id
    AND admission.admission_hash = NEW.admission_hash
    AND admission.policy_version = NEW.policy_version
    AND admission.decision = 'require_approval'
    AND EXISTS (
      SELECT 1
      FROM json_each(admission.required_approval_action_hashes_json)
      WHERE value = NEW.action_hash
    )
)
BEGIN
  SELECT RAISE(ABORT, 'execution_plan_approvals: admission binding mismatch');
END;

CREATE TRIGGER execution_plan_approvals_transition_guard
BEFORE UPDATE ON execution_plan_approvals
WHEN NEW.approval_id IS NOT OLD.approval_id
  OR NEW.work_item_id IS NOT OLD.work_item_id
  OR NEW.plan_id IS NOT OLD.plan_id
  OR NEW.plan_hash IS NOT OLD.plan_hash
  OR NEW.admission_id IS NOT OLD.admission_id
  OR NEW.admission_hash IS NOT OLD.admission_hash
  OR NEW.policy_version IS NOT OLD.policy_version
  OR NEW.action_hash IS NOT OLD.action_hash
  OR NEW.approval_binding_hash IS NOT OLD.approval_binding_hash
  OR NEW.approved_by_actor_id IS NOT OLD.approved_by_actor_id
  OR NEW.reason IS NOT OLD.reason
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.expires_at IS NOT OLD.expires_at
  OR OLD.status <> 'granted'
  OR NEW.status NOT IN ('consumed', 'expired', 'revoked')
  OR (NEW.status = 'consumed' AND julianday(OLD.expires_at) <= julianday(NEW.consumed_at))
BEGIN
  SELECT RAISE(ABORT, 'execution_plan_approvals: immutable field or invalid transition');
END;

CREATE TRIGGER execution_plan_approvals_no_delete
BEFORE DELETE ON execution_plan_approvals
BEGIN
  SELECT RAISE(ABORT, 'execution_plan_approvals: append-only');
END;

CREATE TRIGGER execution_attempts_binding_insert
BEFORE INSERT ON execution_attempts
WHEN NEW.status <> 'leased'
  OR NOT EXISTS (
    SELECT 1
    FROM execution_plan_heads AS plan_head
    JOIN execution_plan_admission_heads AS admission_head
      ON admission_head.work_item_id = plan_head.work_item_id
     AND admission_head.plan_id = plan_head.plan_id
     AND admission_head.plan_hash = plan_head.plan_hash
    WHERE plan_head.work_item_id = NEW.work_item_id
      AND plan_head.plan_id = NEW.plan_id
      AND plan_head.plan_hash = NEW.plan_hash
      AND admission_head.admission_id = NEW.admission_id
      AND admission_head.admission_hash = NEW.admission_hash
  )
BEGIN
  SELECT RAISE(ABORT, 'execution_attempts: current plan and admission binding required');
END;

CREATE TRIGGER execution_attempts_immutable_update
BEFORE UPDATE ON execution_attempts
BEGIN
  SELECT RAISE(ABORT, 'execution_attempts: immutable in schema v6');
END;

CREATE TRIGGER execution_attempts_immutable_delete
BEFORE DELETE ON execution_attempts
BEGIN
  SELECT RAISE(ABORT, 'execution_attempts: append-only');
END;

CREATE TRIGGER attempt_leases_binding_insert
BEFORE INSERT ON attempt_leases
WHEN NOT EXISTS (
  SELECT 1
  FROM execution_attempts AS attempt
  JOIN execution_plan_heads AS plan_head
    ON plan_head.work_item_id = attempt.work_item_id
   AND plan_head.plan_id = attempt.plan_id
   AND plan_head.plan_hash = attempt.plan_hash
  JOIN execution_plan_admission_heads AS admission_head
    ON admission_head.work_item_id = attempt.work_item_id
   AND admission_head.admission_id = attempt.admission_id
   AND admission_head.admission_hash = attempt.admission_hash
  WHERE attempt.attempt_id = NEW.attempt_id
    AND attempt.work_item_id = NEW.work_item_id
    AND attempt.worker_id = NEW.worker_id
    AND attempt.protocol_version = NEW.protocol_version
    AND attempt.plan_id = NEW.plan_id
    AND attempt.plan_hash = NEW.plan_hash
    AND attempt.admission_id = NEW.admission_id
    AND attempt.admission_hash = NEW.admission_hash
    AND attempt.input_hash = NEW.input_hash
    AND attempt.fencing_epoch = NEW.fencing_epoch
    AND attempt.status = 'leased'
)
OR EXISTS (
  SELECT 1
  FROM execution_plan_admissions AS admission
  JOIN json_each(admission.required_approval_action_hashes_json) AS required
  WHERE admission.admission_id = NEW.admission_id
    AND admission.admission_hash = NEW.admission_hash
    AND admission.decision = 'require_approval'
    AND NOT EXISTS (
      SELECT 1 FROM execution_plan_approvals AS approval
      WHERE approval.admission_id = admission.admission_id
        AND approval.admission_hash = admission.admission_hash
        AND approval.policy_version = admission.policy_version
        AND approval.action_hash = required.value
        AND approval.status = 'granted'
        AND julianday(approval.expires_at) > julianday(NEW.issued_at)
    )
)
BEGIN
  SELECT RAISE(ABORT, 'attempt_leases: attempt, fencing, or approval binding mismatch');
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

CREATE TRIGGER attempt_leases_transition_guard
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
  OR NEW.expires_at IS NOT OLD.expires_at
  OR OLD.status <> 'active'
  OR NEW.status NOT IN ('consumed', 'expired', 'revoked')
BEGIN
  SELECT RAISE(ABORT, 'attempt_leases: immutable field or invalid transition');
END;

CREATE TRIGGER attempt_leases_no_delete
BEFORE DELETE ON attempt_leases
BEGIN
  SELECT RAISE(ABORT, 'attempt_leases: append-only');
END;

CREATE TRIGGER legacy_leases_v6_write_guard
BEFORE INSERT ON leases
BEGIN
  SELECT RAISE(ABORT, 'leases: legacy worker protocol disabled after schema v6');
END;

CREATE TRIGGER legacy_work_item_lease_v6_insert_guard
BEFORE INSERT ON work_items
WHEN NEW.status = 'running'
  OR NEW.worker_id IS NOT NULL
  OR NEW.lease_token_hash IS NOT NULL
  OR NEW.started_at IS NOT NULL
  OR NEW.lease_expires_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'work_items: legacy lease state disabled after schema v6');
END;

CREATE TRIGGER legacy_work_item_lease_v6_update_guard
BEFORE UPDATE ON work_items
WHEN NEW.status = 'running'
  OR NEW.lease_token_hash IS NOT NULL
  OR NEW.lease_expires_at IS NOT NULL
  OR (NEW.worker_id IS NOT OLD.worker_id AND NEW.worker_id IS NOT NULL)
  OR (NEW.started_at IS NOT OLD.started_at AND NEW.started_at IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'work_items: legacy lease state disabled after schema v6');
END;

CREATE TRIGGER legacy_execution_results_v6_write_guard
BEFORE INSERT ON execution_results
BEGIN
  SELECT RAISE(ABORT, 'execution_results: legacy worker protocol disabled after schema v6');
END;

CREATE TRIGGER legacy_work_item_result_v6_insert_guard
BEFORE INSERT ON work_items
WHEN NEW.result_json IS NOT NULL
  OR NEW.status IN ('succeeded', 'failed')
BEGIN
  SELECT RAISE(ABORT, 'work_items: legacy result state disabled after schema v6');
END;

CREATE TRIGGER legacy_work_item_result_v6_update_guard
BEFORE UPDATE ON work_items
WHEN NEW.result_json IS NOT OLD.result_json
  OR (NEW.status IS NOT OLD.status AND NEW.status IN ('succeeded', 'failed'))
BEGIN
  SELECT RAISE(ABORT, 'work_items: legacy result state disabled after schema v6');
END;
