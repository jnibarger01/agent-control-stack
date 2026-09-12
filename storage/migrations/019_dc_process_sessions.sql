-- ADR 0016 Slice 4: Desktop Commander process-session persistence.
--
-- Nothing before this migration binds a spawned OS process (a start_process
-- pid) to the work item / caller that started it, so kill_process /
-- interact_with_process / read_process_output have no ownership check beyond
-- generic tool-policy risk classification. This table is that missing
-- binding. Authorization for process-control tools must key off the full
-- (pid, boot_id, proc_start_ticks) identity recorded here, never off pid
-- alone -- pid is reused by the OS across unrelated processes over time.

CREATE TABLE IF NOT EXISTS dc_process_sessions (
  id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL,
  action_hash TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  pid INTEGER NOT NULL,
  boot_id TEXT NOT NULL,
  proc_start_ticks INTEGER NOT NULL,
  dc_session_id TEXT,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'closed', 'lost', 'reconciling')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT,
  closed_at TEXT,
  FOREIGN KEY (work_item_id) REFERENCES work_items(id)
);

-- A given (pid, boot_id) can only be actively owned by one session at a
-- time; the CHECK above still allows multiple historical closed/lost rows
-- for a reused pid, which is exactly the point (reuse must not silently
-- inherit an old session's ownership).
CREATE UNIQUE INDEX IF NOT EXISTS idx_dc_process_sessions_active_identity
  ON dc_process_sessions (pid, boot_id, proc_start_ticks)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_dc_process_sessions_work_item
  ON dc_process_sessions (work_item_id);

CREATE INDEX IF NOT EXISTS idx_dc_process_sessions_status
  ON dc_process_sessions (status);
