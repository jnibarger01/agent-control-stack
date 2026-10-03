-- 051_jace_commander_universal_admin
-- Admin mode may auto-authorize every approval-gated JC tool, including privileged_exec.
DROP TRIGGER IF EXISTS jace_commander_capability_issuances_no_change;
DROP TRIGGER IF EXISTS jace_commander_capability_issuances_no_delete;
DROP INDEX IF EXISTS idx_jc_capability_one_per_invocation;
DROP INDEX IF EXISTS idx_jc_capability_one_per_approval;
DROP INDEX IF EXISTS idx_jc_capability_issued;

ALTER TABLE jace_commander_capability_issuances
  RENAME TO jace_commander_capability_issuances__pre051;

CREATE TABLE jace_commander_capability_issuances (
  capability_issuance_id TEXT PRIMARY KEY,
  lease_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  runtime_id TEXT NOT NULL CHECK (length(runtime_id) BETWEEN 1 AND 128),
  tool_name TEXT NOT NULL REFERENCES jace_commander_tools(tool_name),
  action_hash TEXT NOT NULL CHECK (length(action_hash) = 64 AND action_hash = lower(action_hash)),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64 AND request_hash = lower(request_hash)),
  invocation_hash TEXT NOT NULL CHECK (length(invocation_hash) = 64 AND invocation_hash = lower(invocation_hash)),
  approval_id TEXT,
  approved_by_actor_id TEXT,
  key_id TEXT NOT NULL,
  nonce_hash TEXT NOT NULL UNIQUE CHECK (length(nonce_hash) = 64 AND nonce_hash = lower(nonce_hash)),
  issued_at TEXT NOT NULL CHECK (julianday(issued_at) IS NOT NULL),
  expires_at TEXT NOT NULL CHECK (
    julianday(expires_at) IS NOT NULL
    AND julianday(expires_at) > julianday(issued_at)
    AND julianday(expires_at) <= julianday(issued_at) + 30.0 / 86400.0
  ),
  CHECK (
    (
      tool_name IN (
        'privileged_exec', 'write_file', 'create_directory', 'move_file', 'edit_block',
        'start_process', 'kill_process', 'git_add', 'git_commit', 'git_fetch', 'git_push'
      )
      AND approval_id IS NOT NULL
      AND approved_by_actor_id IS NOT NULL
    )
    OR (
      tool_name NOT IN (
        'privileged_exec', 'write_file', 'create_directory', 'move_file', 'edit_block',
        'start_process', 'kill_process', 'git_add', 'git_commit', 'git_fetch', 'git_push'
      )
      AND approval_id IS NULL
      AND approved_by_actor_id IS NULL
    )
  ),
  FOREIGN KEY (lease_id, attempt_id, work_item_id)
    REFERENCES attempt_leases(lease_id, attempt_id, work_item_id),
  FOREIGN KEY (approval_id, work_item_id)
    REFERENCES execution_plan_approvals(approval_id, work_item_id)
);

INSERT INTO jace_commander_capability_issuances
  SELECT
    capability_issuance_id, lease_id, attempt_id, work_item_id, runtime_id, tool_name,
    action_hash, request_hash, invocation_hash, approval_id, approved_by_actor_id,
    key_id, nonce_hash, issued_at, expires_at
  FROM jace_commander_capability_issuances__pre051;

DROP TABLE jace_commander_capability_issuances__pre051;

CREATE UNIQUE INDEX IF NOT EXISTS idx_jc_capability_one_per_invocation
  ON jace_commander_capability_issuances(lease_id, attempt_id, work_item_id, invocation_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jc_capability_one_per_approval
  ON jace_commander_capability_issuances(approval_id) WHERE approval_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jc_capability_issued
  ON jace_commander_capability_issuances(runtime_id, issued_at);

CREATE TRIGGER IF NOT EXISTS jace_commander_capability_issuances_no_change
BEFORE UPDATE ON jace_commander_capability_issuances
BEGIN
  SELECT RAISE(ABORT, 'jace_commander_capability_issuances: append-only');
END;

CREATE TRIGGER IF NOT EXISTS jace_commander_capability_issuances_no_delete
BEFORE DELETE ON jace_commander_capability_issuances
BEGIN
  SELECT RAISE(ABORT, 'jace_commander_capability_issuances: append-only');
END;
