-- Upgrade legacy work-item-scoped allocations to attempt-scoped ownership.
-- The migration runner skips this body for fresh databases that already have
-- the v2 columns from migration 007.
PRAGMA foreign_keys = OFF;

ALTER TABLE workspace_allocations RENAME TO workspace_allocations_legacy;

CREATE TABLE workspace_allocations (
  allocation_id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  attempt_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  fencing_epoch INTEGER NOT NULL CHECK (fencing_epoch >= 0),
  host_path TEXT NOT NULL CHECK (length(trim(host_path)) > 0),
  branch TEXT NOT NULL CHECK (length(trim(branch)) > 0),
  base_ref TEXT NOT NULL CHECK (length(trim(base_ref)) > 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'cleanup_requested', 'cleanup_failed', 'torn_down')),
  cleanup_attempts INTEGER NOT NULL DEFAULT 0 CHECK (cleanup_attempts >= 0),
  cleanup_requested_at TEXT,
  cleanup_last_error TEXT,
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  torn_down_at TEXT CHECK (torn_down_at IS NULL OR julianday(torn_down_at) IS NOT NULL),
  UNIQUE (allocation_id, work_item_id),
  UNIQUE (attempt_id),
  UNIQUE (host_path)
);

INSERT INTO workspace_allocations
  (allocation_id, work_item_id, attempt_id, lease_id, worker_id, fencing_epoch,
   host_path, branch, base_ref, status, created_at, torn_down_at)
SELECT allocation_id, work_item_id, allocation_id, allocation_id, 'legacy', 0,
       host_path, branch, base_ref, status, created_at, torn_down_at
FROM workspace_allocations_legacy;

DROP TABLE workspace_allocations_legacy;

CREATE UNIQUE INDEX idx_workspace_allocations_one_active_attempt
  ON workspace_allocations(attempt_id) WHERE status <> 'torn_down';

CREATE TRIGGER workspace_allocations_transition_guard
BEFORE UPDATE ON workspace_allocations
WHEN NEW.allocation_id IS NOT OLD.allocation_id
  OR NEW.work_item_id IS NOT OLD.work_item_id
  OR NEW.attempt_id IS NOT OLD.attempt_id
  OR NEW.lease_id IS NOT OLD.lease_id
  OR NEW.worker_id IS NOT OLD.worker_id
  OR NEW.fencing_epoch IS NOT OLD.fencing_epoch
  OR NEW.host_path IS NOT OLD.host_path
  OR NEW.branch IS NOT OLD.branch
  OR NEW.base_ref IS NOT OLD.base_ref
  OR NEW.created_at IS NOT OLD.created_at
  OR OLD.status = 'torn_down'
  OR NEW.status NOT IN ('cleanup_requested', 'cleanup_failed', 'torn_down')
  OR (NEW.status = 'torn_down' AND NEW.torn_down_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'workspace_allocations: immutable binding or invalid transition');
END;

CREATE TRIGGER workspace_allocations_no_delete
BEFORE DELETE ON workspace_allocations
BEGIN
  SELECT RAISE(ABORT, 'workspace_allocations: append-only');
END;
