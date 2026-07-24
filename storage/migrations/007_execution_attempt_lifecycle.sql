DROP TRIGGER execution_attempts_immutable_update;

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
  OR NEW.worker_id IS NOT OLD.worker_id
  OR NEW.fencing_epoch IS NOT OLD.fencing_epoch
  OR NEW.created_at IS NOT OLD.created_at
  OR NEW.claimed_at IS NOT OLD.claimed_at
  OR OLD.status <> 'leased'
  OR NEW.status NOT IN ('unknown', 'quarantined')
BEGIN
  SELECT RAISE(ABORT, 'execution_attempts: immutable field or invalid lifecycle transition');
END;
