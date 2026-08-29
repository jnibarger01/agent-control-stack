-- Import the title markers used by scheduler versions before scheduler_firings
-- existed. This is a one-time compatibility bridge; new scheduler lookups use
-- the indexed canonical key and never scan work_items.
INSERT OR IGNORE INTO scheduler_firings
  (firing_id, schedule_id, scheduled_firing_time, idempotency_key, status,
   work_item_id, claimed_at, completed_at)
SELECT
  'firing_legacy_' || substr(w.title, instr(w.title, '[acs-scheduler-firing:') + 22, 64),
  'legacy:' || substr(w.title, instr(w.title, '[acs-scheduler-firing:') + 22, 64),
  w.created_at,
  substr(w.title, instr(w.title, '[acs-scheduler-firing:') + 22, 64),
  'completed',
  w.id,
  w.created_at,
  w.updated_at
FROM work_items AS w
WHERE instr(w.title, '[acs-scheduler-firing:') > 0
  AND substr(w.title, instr(w.title, '[acs-scheduler-firing:') + 86, 1) = ']'
  AND lower(substr(w.title, instr(w.title, '[acs-scheduler-firing:') + 22, 64))
      = substr(w.title, instr(w.title, '[acs-scheduler-firing:') + 22, 64)
  AND substr(w.title, instr(w.title, '[acs-scheduler-firing:') + 22, 64)
      NOT GLOB '*[^0-9a-f]*'
  AND length(substr(w.title, instr(w.title, '[acs-scheduler-firing:') + 22, 64)) = 64;
