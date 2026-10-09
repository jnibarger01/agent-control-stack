-- Forward fix for migration 057 (Codex P1 on #286): 057 quarantined every
-- verified unit with attempt > 0 and rewrote it to failed/verification_failure,
-- including units that were already terminal (succeeded or cancelled). That
-- corrupted terminal history and left their missions (COMPLETED/CANCELLED)
-- inconsistent with their units.
--
-- 057 has already shipped on main, so its checksum is fixed and it may have run
-- on deployed or development databases. This migration repairs its effect
-- instead of editing it. On a fresh database, or one where 057 touched no
-- terminal unit, every statement here matches zero rows.
--
-- A unit is restored only when it is still exactly in the state 057 left it in
-- (failed / verification_failure) and 057 recorded a terminal previous_status.
-- If anything changed the unit after 057 (operator retry or reconciliation),
-- it is left alone. 054 always writes failure_category = 'cancelled' with a
-- cancelled status, and a succeeded unit carries no failure category.
-- The quarantine row is removed for restored units, because a terminal unit has
-- no in-flight verification authority to reconcile. The restore is recorded in
-- coding_events so the repair stays auditable.

INSERT INTO coding_events (mission_id, name, body_json, created_at)
SELECT q.mission_id,
       'verification.migration_057_terminal_restored',
       json_object('unitId', q.unit_id, 'restoredStatus', q.previous_status, 'reason', q.reason),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM work_unit_verification_quarantine q
JOIN coding_operations o
  ON o.mission_id = q.mission_id AND o.operation_id = q.unit_id
WHERE q.reason = 'migration_057_missing_verification_authority'
  AND q.previous_status IN ('succeeded', 'cancelled')
  AND o.status = 'failed'
  AND o.failure_category = 'verification_failure'
ORDER BY q.mission_id, q.unit_id;

UPDATE coding_operations
SET status = (
      SELECT q.previous_status
      FROM work_unit_verification_quarantine q
      WHERE q.mission_id = coding_operations.mission_id
        AND q.unit_id = coding_operations.operation_id
    ),
    failure_category = CASE (
      SELECT q.previous_status
      FROM work_unit_verification_quarantine q
      WHERE q.mission_id = coding_operations.mission_id
        AND q.unit_id = coding_operations.operation_id
    ) WHEN 'cancelled' THEN 'cancelled' ELSE NULL END
WHERE status = 'failed'
  AND failure_category = 'verification_failure'
  AND EXISTS (
    SELECT 1
    FROM work_unit_verification_quarantine q
    WHERE q.mission_id = coding_operations.mission_id
      AND q.unit_id = coding_operations.operation_id
      AND q.reason = 'migration_057_missing_verification_authority'
      AND q.previous_status IN ('succeeded', 'cancelled')
  );

DELETE FROM work_unit_verification_quarantine
WHERE reason = 'migration_057_missing_verification_authority'
  AND previous_status IN ('succeeded', 'cancelled')
  AND EXISTS (
    SELECT 1
    FROM coding_operations o
    WHERE o.mission_id = work_unit_verification_quarantine.mission_id
      AND o.operation_id = work_unit_verification_quarantine.unit_id
      AND o.status = work_unit_verification_quarantine.previous_status
  );
