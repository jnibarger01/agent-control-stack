CREATE TABLE IF NOT EXISTS scheduler_firings (
  firing_id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL CHECK (length(trim(schedule_id)) > 0),
  scheduled_firing_time TEXT NOT NULL CHECK (julianday(scheduled_firing_time) IS NOT NULL),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) = 64 AND idempotency_key = lower(idempotency_key)),
  status TEXT NOT NULL CHECK (status IN ('claimed', 'completed', 'failed')),
  work_item_id TEXT,
  claimed_at TEXT NOT NULL CHECK (julianday(claimed_at) IS NOT NULL),
  completed_at TEXT CHECK (completed_at IS NULL OR julianday(completed_at) IS NOT NULL),
  -- The one identity the scheduler is actually deduplicating on: a given
  -- schedule cannot fire twice for the same grid-aligned instant, no matter
  -- how many scheduler processes race to claim it.
  UNIQUE (schedule_id, scheduled_firing_time)
);

CREATE INDEX IF NOT EXISTS idx_scheduler_firings_status
  ON scheduler_firings(status, claimed_at);

CREATE TRIGGER IF NOT EXISTS scheduler_firings_transition_guard
BEFORE UPDATE ON scheduler_firings
WHEN NEW.firing_id IS NOT OLD.firing_id
  OR NEW.schedule_id IS NOT OLD.schedule_id
  OR NEW.scheduled_firing_time IS NOT OLD.scheduled_firing_time
  OR NEW.idempotency_key IS NOT OLD.idempotency_key
  OR (
    -- Reclaiming a stale in-flight firing: status stays 'claimed', only
    -- claimed_at may move forward. Enforcing "forward only" here (rather
    -- than trusting the caller's staleness check alone) means a reclaim
    -- can never rewind the clock a later reconciliation would judge by.
    OLD.status = 'claimed' AND NEW.status = 'claimed'
    AND (NEW.work_item_id IS NOT NULL OR julianday(NEW.claimed_at) <= julianday(OLD.claimed_at))
  )
  OR (
    OLD.status = 'claimed' AND NEW.status = 'completed'
    AND (NEW.work_item_id IS NULL OR NEW.completed_at IS NULL)
  )
  OR (OLD.status = 'claimed' AND NEW.status = 'failed' AND NEW.completed_at IS NULL)
  OR (OLD.status NOT IN ('claimed') AND NEW.status <> OLD.status)
BEGIN
  SELECT RAISE(ABORT, 'scheduler_firings: invalid transition');
END;

CREATE TRIGGER IF NOT EXISTS scheduler_firings_no_delete
BEFORE DELETE ON scheduler_firings
BEGIN
  SELECT RAISE(ABORT, 'scheduler_firings: append-only');
END;
