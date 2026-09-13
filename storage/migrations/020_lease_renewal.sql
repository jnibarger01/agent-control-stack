-- Allow renewing expires_at on active legacy leases (mirrors attempt_leases renewal).
-- Immutable bindings stay immutable; only active leases may push expires_at forward.
DROP TRIGGER IF EXISTS leases_immutable_fields_guard;

CREATE TRIGGER leases_immutable_fields_guard
BEFORE UPDATE ON leases
WHEN NEW.lease_id IS NOT OLD.lease_id
  OR NEW.work_item_id IS NOT OLD.work_item_id
  OR NEW.worker_id IS NOT OLD.worker_id
  OR NEW.token_hash IS NOT OLD.token_hash
  OR NEW.action_hash IS NOT OLD.action_hash
  OR NEW.issued_at IS NOT OLD.issued_at
  OR (
    NEW.expires_at IS NOT OLD.expires_at
    AND NOT (
      OLD.status = 'active'
      AND NEW.status = 'active'
      AND julianday(NEW.expires_at) >= julianday(OLD.expires_at)
    )
  )
  OR (NEW.status IS NOT OLD.status AND NOT (OLD.status = 'active' AND NEW.status IN ('consumed', 'expired', 'revoked')))
  OR (NEW.closed_at IS NOT OLD.closed_at AND NEW.status = 'active')
BEGIN
  SELECT RAISE(ABORT, 'leases: immutable field modified or invalid transition');
END;
