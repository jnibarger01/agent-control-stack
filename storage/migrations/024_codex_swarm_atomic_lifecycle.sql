-- Add the conservative interrupted terminal state without changing released migration 023.
-- SQLite cannot alter CHECK constraints, so rebuild only this append-only table
-- within the migration transaction managed by applyControlPlaneMigrations.
DROP TRIGGER codex_swarm_dispatch_reservations_transition_guard;
DROP TRIGGER codex_swarm_dispatch_reservations_no_delete;
ALTER TABLE codex_swarm_dispatch_reservations RENAME TO codex_swarm_dispatch_reservations_v023;
CREATE TABLE codex_swarm_dispatch_reservations (
  idempotency_key TEXT PRIMARY KEY CHECK (length(trim(idempotency_key)) > 0),
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  attempt_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  fencing_epoch INTEGER NOT NULL CHECK (fencing_epoch > 0),
  envelope_hash TEXT NOT NULL CHECK (length(envelope_hash) = 64 AND envelope_hash = lower(envelope_hash)),
  start_status TEXT NOT NULL CHECK (start_status IN ('reserved', 'started', 'failed_start', 'cancelled', 'interrupted')),
  start_code TEXT,
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  completed_at TEXT,
  UNIQUE(attempt_id, lease_id, fencing_epoch),
  FOREIGN KEY(attempt_id, work_item_id) REFERENCES execution_attempts(attempt_id, work_item_id),
  FOREIGN KEY(lease_id, attempt_id) REFERENCES attempt_leases(lease_id, attempt_id)
);
INSERT INTO codex_swarm_dispatch_reservations
  SELECT idempotency_key, work_item_id, attempt_id, lease_id, fencing_epoch, envelope_hash, start_status, start_code, created_at, completed_at
  FROM codex_swarm_dispatch_reservations_v023;
DROP TABLE codex_swarm_dispatch_reservations_v023;
CREATE TRIGGER codex_swarm_dispatch_reservations_no_delete BEFORE DELETE ON codex_swarm_dispatch_reservations BEGIN SELECT RAISE(ABORT, 'codex_swarm_dispatch_reservations: append-only'); END;
CREATE TRIGGER codex_swarm_dispatch_reservations_transition_guard
BEFORE UPDATE ON codex_swarm_dispatch_reservations
WHEN NEW.idempotency_key IS NOT OLD.idempotency_key OR NEW.work_item_id IS NOT OLD.work_item_id
  OR NEW.attempt_id IS NOT OLD.attempt_id OR NEW.lease_id IS NOT OLD.lease_id
  OR NEW.fencing_epoch IS NOT OLD.fencing_epoch OR NEW.envelope_hash IS NOT OLD.envelope_hash
  OR OLD.start_status <> 'reserved' OR NEW.start_status NOT IN ('started', 'failed_start', 'cancelled', 'interrupted')
  OR NEW.completed_at IS NULL
BEGIN SELECT RAISE(ABORT, 'codex_swarm_dispatch_reservations: immutable binding or invalid transition'); END;
