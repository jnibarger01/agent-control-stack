-- Self-healing mission runtime, slice 5.1: bounded, backed-off, idempotent recovery of stale work-unit claims, with a
-- poison-work stop and an operator escalation record.
--
-- A claim that was released because its worker vanished used to reset the unit and decrement its attempt, so a worker that
-- kept vanishing was retried forever with no delay. Every release is now a durable, append-only recovery record keyed by a
-- hash of the released claim token (the fence), which makes recovery idempotent: recovering the same stale claim twice
-- returns the first decision and changes nothing. The number of records is the unit's recovery count; past the policy
-- limit the unit is stopped as poison work and an escalation is recorded for an operator instead of being retried.
--
-- Recovery only ever follows confirmed non-execution (the executor reported the operation absent). Anything the system
-- cannot prove safe is escalated, never retried.

ALTER TABLE coding_operations ADD COLUMN retry_not_before TEXT;

CREATE TABLE work_unit_recoveries (
  mission_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  claim_fence_hash TEXT NOT NULL CHECK (length(claim_fence_hash) = 64),
  claim_attempt INTEGER NOT NULL CHECK (claim_attempt >= 0),
  worker_id TEXT,
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 120),
  outcome TEXT NOT NULL CHECK (outcome IN ('rescheduled', 'poisoned')),
  retry_not_before TEXT,
  decided_at TEXT NOT NULL,
  PRIMARY KEY (mission_id, unit_id, seq),
  UNIQUE (mission_id, unit_id, claim_fence_hash),
  FOREIGN KEY (mission_id, unit_id) REFERENCES coding_operations (mission_id, operation_id)
);

-- One escalation per unit and kind. It is evidence for an operator, not a control: acknowledging or resolving it is a
-- separate, later action.
CREATE TABLE work_unit_escalations (
  escalation_id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id TEXT NOT NULL,
  unit_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('poison_work', 'recovery_unsafe')),
  detail_json TEXT NOT NULL CHECK (json_valid(detail_json)),
  created_at TEXT NOT NULL,
  UNIQUE (mission_id, unit_id, kind),
  FOREIGN KEY (mission_id, unit_id) REFERENCES coding_operations (mission_id, operation_id)
);

-- Append-only. INSERT OR REPLACE deletes the old row without firing DELETE triggers, so each table also gets a BEFORE
-- INSERT guard that refuses an insert whose key already exists (see migrations 060 and 062).
CREATE TRIGGER work_unit_recoveries_no_update BEFORE UPDATE ON work_unit_recoveries
BEGIN SELECT RAISE(ABORT, 'work_unit_recoveries: append-only'); END;
CREATE TRIGGER work_unit_recoveries_no_delete BEFORE DELETE ON work_unit_recoveries
BEGIN SELECT RAISE(ABORT, 'work_unit_recoveries: append-only'); END;
CREATE TRIGGER work_unit_recoveries_no_replace BEFORE INSERT ON work_unit_recoveries
WHEN EXISTS (
  SELECT 1 FROM work_unit_recoveries
  WHERE mission_id = NEW.mission_id AND unit_id = NEW.unit_id AND (seq = NEW.seq OR claim_fence_hash = NEW.claim_fence_hash)
)
BEGIN SELECT RAISE(ABORT, 'work_unit_recoveries: append-only'); END;

CREATE TRIGGER work_unit_escalations_no_update BEFORE UPDATE ON work_unit_escalations
BEGIN SELECT RAISE(ABORT, 'work_unit_escalations: append-only'); END;
CREATE TRIGGER work_unit_escalations_no_delete BEFORE DELETE ON work_unit_escalations
BEGIN SELECT RAISE(ABORT, 'work_unit_escalations: append-only'); END;
CREATE TRIGGER work_unit_escalations_no_replace BEFORE INSERT ON work_unit_escalations
WHEN EXISTS (
  SELECT 1 FROM work_unit_escalations WHERE mission_id = NEW.mission_id AND unit_id = NEW.unit_id AND kind = NEW.kind
)
BEGIN SELECT RAISE(ABORT, 'work_unit_escalations: append-only'); END;
