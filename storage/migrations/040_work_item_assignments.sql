CREATE TABLE IF NOT EXISTS work_item_assignments (
  work_item_id TEXT PRIMARY KEY REFERENCES work_items(id),
  selected_worker_id TEXT NOT NULL,
  selected_agent_id TEXT,
  routing_decision_id TEXT,
  assigned_by_actor_id TEXT NOT NULL,
  assigned_at TEXT NOT NULL CHECK (julianday(assigned_at) IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_work_item_assignments_worker
  ON work_item_assignments(selected_worker_id);
