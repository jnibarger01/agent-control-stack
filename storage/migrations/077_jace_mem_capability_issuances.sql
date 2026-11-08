-- Jace-Mem (acs.jm.v1) capability issuance provenance.
-- Separate from the desktop_commander_* and jace_commander_* tables: different audience, scope
-- vocabulary, signing key and one extra signed binding (the Jace-Mem subject). The subject itself is
-- stored only as a hash; raw nonces are never stored, only hashes. Forward-only.

CREATE TABLE IF NOT EXISTS jace_mem_capability_issuances (
  capability_issuance_id TEXT PRIMARY KEY,
  lease_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  runtime_id TEXT NOT NULL CHECK (length(runtime_id) BETWEEN 1 AND 128),
  tool_name TEXT NOT NULL CHECK (tool_name IN ('session_start', 'session_end', 'session_delete', 'memory_capture', 'memory_search', 'memory_get', 'memory_delete', 'memory_retain_since', 'memory_status', 'memory_search_shared')),
  scope TEXT NOT NULL CHECK (scope IN ('memory.read', 'memory.write', 'memory.delete', 'memory.share')),
  subject_hash TEXT NOT NULL CHECK (length(subject_hash) = 64 AND subject_hash = lower(subject_hash)),
  requester_subject TEXT NOT NULL CHECK (length(requester_subject) BETWEEN 1 AND 256),
  action_hash TEXT NOT NULL CHECK (length(action_hash) = 64 AND action_hash = lower(action_hash)),
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64 AND request_hash = lower(request_hash)),
  invocation_hash TEXT NOT NULL CHECK (length(invocation_hash) = 64 AND invocation_hash = lower(invocation_hash)),
  approval_id TEXT,
  approved_by_actor_id TEXT,
  key_id TEXT NOT NULL CHECK (length(key_id) BETWEEN 1 AND 64),
  nonce_hash TEXT NOT NULL UNIQUE CHECK (length(nonce_hash) = 64 AND nonce_hash = lower(nonce_hash)),
  issued_at TEXT NOT NULL CHECK (julianday(issued_at) IS NOT NULL),
  expires_at TEXT NOT NULL CHECK (julianday(expires_at) IS NOT NULL AND julianday(expires_at) > julianday(issued_at) AND julianday(expires_at) <= julianday(issued_at) + 30.0 / 86400.0),
  -- Tool -> scope is fixed by the acs.jm.v1 manifest.
  CHECK (
    (tool_name IN ('memory_search', 'memory_get', 'memory_status') AND scope = 'memory.read')
    OR (tool_name IN ('session_start', 'session_end', 'memory_capture') AND scope = 'memory.write')
    OR (tool_name IN ('memory_delete', 'session_delete', 'memory_retain_since') AND scope = 'memory.delete')
    OR (tool_name = 'memory_search_shared' AND scope = 'memory.share')
  ),
  -- Deletion and cross-agent sharing are issued only against an approval granted by a human who is
  -- neither the requester nor the ACS admin-mode approver. Nothing else may carry an approval.
  CHECK (
    (scope IN ('memory.delete', 'memory.share') AND approval_id IS NOT NULL AND approved_by_actor_id IS NOT NULL
      AND approved_by_actor_id <> 'acs:admin' AND approved_by_actor_id <> requester_subject)
    OR (scope IN ('memory.read', 'memory.write') AND approval_id IS NULL AND approved_by_actor_id IS NULL)
  ),
  FOREIGN KEY (lease_id, attempt_id, work_item_id) REFERENCES attempt_leases(lease_id, attempt_id, work_item_id),
  FOREIGN KEY (approval_id, work_item_id) REFERENCES execution_plan_approvals(approval_id, work_item_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_jm_capability_one_per_invocation
  ON jace_mem_capability_issuances(lease_id, attempt_id, work_item_id, invocation_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jm_capability_one_per_approval
  ON jace_mem_capability_issuances(approval_id) WHERE approval_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jm_capability_issued ON jace_mem_capability_issuances(runtime_id, issued_at);
CREATE INDEX IF NOT EXISTS idx_jm_capability_subject ON jace_mem_capability_issuances(subject_hash, issued_at);

CREATE TRIGGER IF NOT EXISTS jace_mem_capability_issuances_no_change BEFORE UPDATE ON jace_mem_capability_issuances BEGIN SELECT RAISE(ABORT, 'jace_mem_capability_issuances: append-only'); END;
CREATE TRIGGER IF NOT EXISTS jace_mem_capability_issuances_no_delete BEFORE DELETE ON jace_mem_capability_issuances BEGIN SELECT RAISE(ABORT, 'jace_mem_capability_issuances: append-only'); END;
