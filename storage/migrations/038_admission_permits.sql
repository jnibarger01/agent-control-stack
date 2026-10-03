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