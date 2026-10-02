-- NON-CANONICAL FIXTURE. This file is deliberately NOT registered in
-- `migrationFiles` in packages/shared/src/migration.ts and must never be added to
-- the canonical migration order just because of its numeric prefix.
--
-- It exists only to reconstruct an earlier lineage in migration recovery tests, in
-- which this migration's content shipped under version 38 instead of 39. The
-- canonical migration carrying this content is 039_admission_permits.sql.
-- Do not renumber: recovery and its tests depend on these exact filenames.
--
-- Editing this file changes the checksum that migration recovery derives for the
-- historical 38 layout, which is intentional and is detected as checksum drift.
-- Persist admission permit bindings across gateway restarts.
-- Rebuilds the in-memory permit map from active leases on startup.
CREATE TABLE IF NOT EXISTS admission_permits (
  attempt_id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  fencing_epoch INTEGER NOT NULL DEFAULT 0,
  action_hash TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  lane TEXT NOT NULL CHECK (lane IN ('jc', 'dc')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_admission_permits_lease
  ON admission_permits(lease_id);
CREATE INDEX IF NOT EXISTS idx_admission_permits_work_item
  ON admission_permits(work_item_id);