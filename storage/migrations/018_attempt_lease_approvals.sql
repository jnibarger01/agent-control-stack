-- attempt_leases.approval_id only ever bound a single execution-plan
-- approval to a lease. A plan with multiple approval-required actions needs
-- every required approval represented in, and atomically consumed by, the
-- same lease's authority - not just the first one. This join table extends
-- (without removing) the single-approval column: attempt_leases.approval_id
-- keeps working for single-approval plans, and every additional required
-- approval for a multi-action plan is bound here, validated the same way,
-- and consumed transactionally with the row that records it.
CREATE TABLE IF NOT EXISTS attempt_lease_approvals (
  lease_id TEXT NOT NULL,
  approval_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  action_hash TEXT NOT NULL CHECK (length(action_hash) = 64 AND action_hash = lower(action_hash)),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  PRIMARY KEY (lease_id, approval_id),
  FOREIGN KEY (lease_id, attempt_id, work_item_id)
    REFERENCES attempt_leases(lease_id, attempt_id, work_item_id),
  FOREIGN KEY (approval_id, work_item_id) REFERENCES execution_plan_approvals(approval_id, work_item_id)
);

CREATE INDEX IF NOT EXISTS idx_attempt_lease_approvals_approval
  ON attempt_lease_approvals(approval_id);

-- attempt_leases only has a UNIQUE(lease_id, attempt_id) index, not one over
-- the (lease_id, attempt_id, work_item_id) triple the FK above references -
-- SQLite requires the referenced columns be covered by a unique index.
CREATE UNIQUE INDEX IF NOT EXISTS idx_attempt_leases_lease_attempt_work_item
  ON attempt_leases(lease_id, attempt_id, work_item_id);

CREATE TRIGGER IF NOT EXISTS attempt_lease_approvals_binding_guard
BEFORE INSERT ON attempt_lease_approvals
WHEN NOT EXISTS (
  SELECT 1
  FROM attempt_leases AS leases
  JOIN execution_plan_approvals AS approvals
    ON approvals.approval_id = NEW.approval_id
   AND approvals.work_item_id = NEW.work_item_id
  WHERE leases.lease_id = NEW.lease_id
    AND leases.attempt_id = NEW.attempt_id
    AND leases.work_item_id = NEW.work_item_id
    AND leases.status = 'active'
    AND approvals.plan_hash = leases.plan_hash
    AND approvals.action_hash = NEW.action_hash
    AND approvals.status = 'granted'
    AND julianday(approvals.expires_at) > julianday('now')
)
BEGIN
  SELECT RAISE(ABORT, 'attempt_lease_approvals: lease or approval binding is invalid');
END;

CREATE TRIGGER IF NOT EXISTS attempt_lease_approvals_consume
AFTER INSERT ON attempt_lease_approvals
BEGIN
  -- Consume atomically with the row that binds it to the lease - same
  -- transaction, no separate step where the lease could exist without the
  -- approval being spent, or vice versa.
  UPDATE execution_plan_approvals
  SET status = 'consumed', consumed_at = NEW.created_at
  WHERE approval_id = NEW.approval_id
    AND work_item_id = NEW.work_item_id
    AND status = 'granted';
END;

CREATE TRIGGER IF NOT EXISTS attempt_lease_approvals_no_delete
BEFORE DELETE ON attempt_lease_approvals
BEGIN
  SELECT RAISE(ABORT, 'attempt_lease_approvals: append-only');
END;
