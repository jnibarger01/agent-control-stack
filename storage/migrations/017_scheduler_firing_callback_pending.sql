-- Allow a scheduler firing to durably record the work item it created
-- while remaining in 'claimed' status, so the controller callback
-- (onWorkItemCreated) can be retried after a crash without recreating the
-- work item, and the firing is only ever marked 'completed' once that
-- callback has actually succeeded.
DROP TRIGGER IF EXISTS scheduler_firings_transition_guard;

CREATE TRIGGER scheduler_firings_transition_guard
BEFORE UPDATE ON scheduler_firings
WHEN NEW.firing_id IS NOT OLD.firing_id
  OR NEW.schedule_id IS NOT OLD.schedule_id
  OR NEW.scheduled_firing_time IS NOT OLD.scheduled_firing_time
  OR NEW.idempotency_key IS NOT OLD.idempotency_key
  OR (
    OLD.status = 'claimed' AND NEW.status = 'claimed'
    AND NOT (
      -- Record the work item created for this firing without yet
      -- confirming the callback: work_item_id moves NULL -> X, clock
      -- untouched.
      (OLD.work_item_id IS NULL AND NEW.work_item_id IS NOT NULL AND NEW.claimed_at = OLD.claimed_at)
      OR (
        -- Reclaim a stale in-flight firing (whether or not a work item was
        -- already recorded for it) so the caller can retry the callback,
        -- or the whole firing from scratch: work_item_id is unchanged,
        -- claimed_at only ever moves forward.
        NEW.work_item_id IS OLD.work_item_id
        AND julianday(NEW.claimed_at) > julianday(OLD.claimed_at)
      )
    )
  )
  OR (
    OLD.status = 'claimed' AND NEW.status = 'completed'
    AND (
      NEW.work_item_id IS NULL
      OR NEW.completed_at IS NULL
      -- If a work item was already recorded for this firing (the
      -- callback-pending path), completion must bind the exact same one.
      OR (OLD.work_item_id IS NOT NULL AND NEW.work_item_id IS NOT OLD.work_item_id)
    )
  )
  OR (OLD.status = 'claimed' AND NEW.status = 'failed' AND NEW.completed_at IS NULL)
  OR (OLD.status NOT IN ('claimed') AND NEW.status <> OLD.status)
BEGIN
  SELECT RAISE(ABORT, 'scheduler_firings: invalid transition');
END;
