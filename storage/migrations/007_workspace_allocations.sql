CREATE TABLE IF NOT EXISTS workspace_allocations (
  allocation_id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  host_path TEXT NOT NULL CHECK (length(trim(host_path)) > 0),
  branch TEXT NOT NULL CHECK (length(trim(branch)) > 0),
  base_ref TEXT NOT NULL CHECK (length(trim(base_ref)) > 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'torn_down')),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  torn_down_at TEXT CHECK (torn_down_at IS NULL OR julianday(torn_down_at) IS NOT NULL),
  UNIQUE (allocation_id, work_item_id)
);

-- One live allocation per work item at a time - matches WorkspaceManager's
-- one-worktree-per-work-item design (reused across attempts, not
-- reprovisioned per attempt).
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_allocations_one_active_work_item
  ON workspace_allocations(work_item_id)
  WHERE status = 'active';

CREATE TRIGGER IF NOT EXISTS workspace_allocations_transition_guard
BEFORE UPDATE ON workspace_allocations
WHEN NEW.allocation_id IS NOT OLD.allocation_id
  OR NEW.work_item_id IS NOT OLD.work_item_id
  OR NEW.host_path IS NOT OLD.host_path
  OR NEW.branch IS NOT OLD.branch
  OR NEW.base_ref IS NOT OLD.base_ref
  OR NEW.created_at IS NOT OLD.created_at
  OR OLD.status <> 'active'
  OR NEW.status <> 'torn_down'
  OR NEW.torn_down_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'workspace_allocations: immutable binding or invalid transition');
END;

CREATE TRIGGER IF NOT EXISTS workspace_allocations_no_delete
BEFORE DELETE ON workspace_allocations
BEGIN
  SELECT RAISE(ABORT, 'workspace_allocations: append-only');
END;
