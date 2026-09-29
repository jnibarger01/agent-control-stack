-- 029_jace_commander_tool_allowlist
--
-- Move the Jace Commander issuance tool allowlist from a hardcoded CHECK
-- (migration 028: tool_name IN (<eight names>)) into a lookup table that the
-- append-only issuance table foreign-keys into. The database still refuses a
-- capability row for any tool it does not know; adding a tool is now a
-- one-line forward-only INSERT in a later migration instead of rebuilding
-- this audit table each time.
--
-- The tool set here must equal packages/jc-tool-manifest; the root drift test
-- (tests/e2e/jc-tool-contract-drift.test.ts) fails when they differ.
--
-- Everything else in the 028 table is preserved verbatim, including the
-- privileged_exec human-approval CHECK and the append-only triggers.
-- SQLite cannot drop a CHECK in place, so the table is rebuilt (precedent:
-- 021). Nothing FK-references jace_commander_capability_issuances.

CREATE TABLE IF NOT EXISTS jace_commander_tools (
  tool_name TEXT PRIMARY KEY CHECK (tool_name GLOB '[a-z]*' AND length(tool_name) BETWEEN 1 AND 64),
  added_in_migration INTEGER NOT NULL
);

INSERT OR IGNORE INTO jace_commander_tools (tool_name, added_in_migration) VALUES
  ('jc_status', 28),
  ('acs_read', 28),
  ('acs_submit_mission', 28),
  ('swarm_read', 28),
  ('visualizer_read', 28),
  ('mission_router_list', 28),
  ('looptrace_verify', 28),
  ('privileged_exec', 28),
  ('list_directory', 29),
  ('get_file_info', 29),
  ('read_file', 29),
  ('read_multiple_files', 29);

CREATE TRIGGER IF NOT EXISTS jace_commander_tools_no_change BEFORE UPDATE ON jace_commander_tools BEGIN SELECT RAISE(ABORT, 'jace_commander_tools: append-only'); END;
CREATE TRIGGER IF NOT EXISTS jace_commander_tools_no_delete BEFORE DELETE ON jace_commander_tools BEGIN SELECT RAISE(ABORT, 'jace_commander_tools: append-only'); END;

DROP TRIGGER IF EXISTS jace_commander_capability_issuances_no_change;
DROP TRIGGER IF EXISTS jace_commander_capability_issuances_no_delete;
DROP INDEX IF EXISTS idx_jc_capability_one_per_invocation;
DROP INDEX IF EXISTS idx_jc_capability_one_per_approval;
DROP INDEX IF EXISTS idx_jc_capability_issued;

ALTER TABLE jace_commander_capability_issuances RENAME TO jace_commander_capability_issuances__pre029;

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
  expires_at TEXT NOT NULL CHECK (julianday(expires_at) IS NOT NULL AND julianday(expires_at) > julianday(issued_at) AND julianday(expires_at) <= julianday(issued_at) + 30.0 / 86400.0),
  -- privileged_exec is only ever issued against a human-granted approval.
  CHECK (
    (tool_name = 'privileged_exec' AND approval_id IS NOT NULL AND approved_by_actor_id IS NOT NULL AND approved_by_actor_id <> 'acs:admin')
    OR (tool_name <> 'privileged_exec' AND approval_id IS NULL AND approved_by_actor_id IS NULL)
  ),
  FOREIGN KEY (lease_id, attempt_id, work_item_id) REFERENCES attempt_leases(lease_id, attempt_id, work_item_id),
  FOREIGN KEY (approval_id, work_item_id) REFERENCES execution_plan_approvals(approval_id, work_item_id)
);

INSERT INTO jace_commander_capability_issuances
  SELECT
    capability_issuance_id, lease_id, attempt_id, work_item_id, runtime_id, tool_name, action_hash, request_hash,
    invocation_hash, approval_id, approved_by_actor_id, key_id, nonce_hash, issued_at, expires_at
  FROM jace_commander_capability_issuances__pre029;

DROP TABLE jace_commander_capability_issuances__pre029;

CREATE UNIQUE INDEX IF NOT EXISTS idx_jc_capability_one_per_invocation
  ON jace_commander_capability_issuances(lease_id, attempt_id, work_item_id, invocation_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jc_capability_one_per_approval
  ON jace_commander_capability_issuances(approval_id) WHERE approval_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jc_capability_issued ON jace_commander_capability_issuances(runtime_id, issued_at);

CREATE TRIGGER IF NOT EXISTS jace_commander_capability_issuances_no_change BEFORE UPDATE ON jace_commander_capability_issuances BEGIN SELECT RAISE(ABORT, 'jace_commander_capability_issuances: append-only'); END;
CREATE TRIGGER IF NOT EXISTS jace_commander_capability_issuances_no_delete BEFORE DELETE ON jace_commander_capability_issuances BEGIN SELECT RAISE(ABORT, 'jace_commander_capability_issuances: append-only'); END;
