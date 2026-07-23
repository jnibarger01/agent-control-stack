ALTER TABLE work_items ADD COLUMN source_work_item_id TEXT REFERENCES work_items(id);
ALTER TABLE work_items ADD COLUMN lineage_type TEXT CHECK (lineage_type IS NULL OR lineage_type IN ('retry', 'clone'));
ALTER TABLE work_items ADD COLUMN retry_reason TEXT;
ALTER TABLE work_items ADD COLUMN retry_sequence INTEGER NOT NULL DEFAULT 0 CHECK (retry_sequence >= 0);
ALTER TABLE work_items ADD COLUMN root_work_item_id TEXT REFERENCES work_items(id);

CREATE INDEX IF NOT EXISTS idx_work_items_source ON work_items(source_work_item_id);
CREATE INDEX IF NOT EXISTS idx_work_items_root ON work_items(root_work_item_id);

CREATE TABLE IF NOT EXISTS leases (
  lease_id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  worker_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  action_hash TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'consumed', 'expired', 'revoked')),
  closed_at TEXT,
  UNIQUE (lease_id, work_item_id),
  CHECK (length(trim(lease_id)) > 0),
  CHECK (length(trim(worker_id)) > 0),
  CHECK (length(trim(token_hash)) > 0),
  CHECK (length(trim(action_hash)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_leases_one_active_work_item
  ON leases(work_item_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_leases_worker_status ON leases(worker_id, status);
CREATE INDEX IF NOT EXISTS idx_leases_expiry ON leases(status, expires_at);

CREATE TABLE IF NOT EXISTS execution_results (
  result_id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL UNIQUE REFERENCES work_items(id),
  lease_id TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  action_hash TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (
    outcome IN ('succeeded', 'failed', 'cancelled', 'worker_infrastructure_failure', 'blocked', 'lease_expired')
  ),
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  exit_code INTEGER CHECK (exit_code IS NULL OR (exit_code >= -255 AND exit_code <= 255)),
  summary TEXT NOT NULL,
  stdout TEXT,
  stderr TEXT,
  structured_output_json TEXT NOT NULL CHECK (json_valid(structured_output_json)),
  artifacts_json TEXT NOT NULL CHECK (json_valid(artifacts_json)),
  error TEXT,
  resource_usage_json TEXT CHECK (resource_usage_json IS NULL OR json_valid(resource_usage_json)),
  simulation_metadata_json TEXT NOT NULL CHECK (json_valid(simulation_metadata_json)),
  payload_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (worker_id, idempotency_key),
  FOREIGN KEY (lease_id, work_item_id) REFERENCES leases(lease_id, work_item_id),
  CHECK (length(trim(result_id)) > 0),
  CHECK (length(trim(work_item_id)) > 0),
  CHECK (length(trim(lease_id)) > 0),
  CHECK (length(trim(worker_id)) > 0),
  CHECK (length(trim(idempotency_key)) > 0),
  CHECK (length(trim(action_hash)) > 0),
  CHECK (julianday(started_at) IS NOT NULL AND julianday(finished_at) IS NOT NULL AND julianday(finished_at) >= julianday(started_at)),
  CHECK (outcome <> 'succeeded' OR exit_code IS NULL OR exit_code = 0),
  CHECK (outcome <> 'cancelled' OR exit_code IS NULL),
  CHECK (json_extract(simulation_metadata_json, '$.executionMode') = 'dry_run'),
  CHECK (json_extract(simulation_metadata_json, '$.simulated') = 1)
);

CREATE INDEX IF NOT EXISTS idx_execution_results_lease ON execution_results(lease_id);
CREATE INDEX IF NOT EXISTS idx_execution_results_worker_key ON execution_results(worker_id, idempotency_key);

CREATE TRIGGER IF NOT EXISTS execution_results_binding_guard
BEFORE INSERT ON execution_results
WHEN NOT EXISTS (
  SELECT 1 FROM leases
  WHERE lease_id = NEW.lease_id
    AND work_item_id = NEW.work_item_id
    AND worker_id = NEW.worker_id
    AND action_hash = NEW.action_hash
    AND status = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'execution_results: active lease binding is required');
END;

CREATE TRIGGER IF NOT EXISTS work_items_lineage_guard_insert
BEFORE INSERT ON work_items
WHEN (NEW.lineage_type IS NULL AND (NEW.source_work_item_id IS NOT NULL OR NEW.retry_reason IS NOT NULL OR NEW.root_work_item_id IS NOT NULL))
  OR (NEW.lineage_type = 'retry' AND (NEW.source_work_item_id IS NULL OR NEW.retry_reason IS NULL))
  OR (NEW.lineage_type = 'clone' AND NEW.source_work_item_id IS NULL)
  OR (NEW.source_work_item_id IS NOT NULL AND NEW.source_work_item_id = NEW.id)
  OR NEW.retry_sequence < 0
BEGIN
  SELECT RAISE(ABORT, 'work_items: invalid retry or clone lineage');
END;

CREATE TRIGGER IF NOT EXISTS work_items_lineage_guard_update
BEFORE UPDATE ON work_items
WHEN NEW.source_work_item_id IS NOT OLD.source_work_item_id
  OR NEW.lineage_type IS NOT OLD.lineage_type
  OR NEW.retry_reason IS NOT OLD.retry_reason
  OR NEW.retry_sequence IS NOT OLD.retry_sequence
  OR NEW.root_work_item_id IS NOT OLD.root_work_item_id
BEGIN
  SELECT RAISE(ABORT, 'work_items: lineage is immutable');
END;

CREATE TRIGGER IF NOT EXISTS work_items_terminal_immutable_guard
BEFORE UPDATE ON work_items
WHEN OLD.status IN ('succeeded', 'failed', 'cancelled', 'rejected')
  AND (
    NEW.id IS NOT OLD.id OR
    NEW.title IS NOT OLD.title OR
    NEW.requester IS NOT OLD.requester OR
    NEW.requester_subject IS NOT OLD.requester_subject OR
    NEW.status IS NOT OLD.status OR
    NEW.intent IS NOT OLD.intent OR
    NEW.target_json IS NOT OLD.target_json OR
    NEW.requested_actions_json IS NOT OLD.requested_actions_json OR
    NEW.risk IS NOT OLD.risk OR
    NEW.result_json IS NOT OLD.result_json OR
    NEW.worker_id IS NOT OLD.worker_id OR
    NEW.lease_token_hash IS NOT OLD.lease_token_hash OR
    NEW.started_at IS NOT OLD.started_at OR
    NEW.lease_expires_at IS NOT OLD.lease_expires_at OR
    NEW.created_at IS NOT OLD.created_at OR
    NEW.updated_at IS NOT OLD.updated_at
  )
BEGIN
  SELECT RAISE(ABORT, 'work_items: terminal history is immutable');
END;

CREATE TRIGGER IF NOT EXISTS work_items_result_immutable_guard
BEFORE UPDATE ON work_items
WHEN OLD.result_json IS NOT NULL
  AND (
    NEW.id IS NOT OLD.id OR
    NEW.title IS NOT OLD.title OR
    NEW.requester IS NOT OLD.requester OR
    NEW.requester_subject IS NOT OLD.requester_subject OR
    NEW.status IS NOT OLD.status OR
    NEW.intent IS NOT OLD.intent OR
    NEW.target_json IS NOT OLD.target_json OR
    NEW.requested_actions_json IS NOT OLD.requested_actions_json OR
    NEW.risk IS NOT OLD.risk OR
    NEW.result_json IS NOT OLD.result_json OR
    NEW.worker_id IS NOT OLD.worker_id OR
    NEW.lease_token_hash IS NOT OLD.lease_token_hash OR
    NEW.started_at IS NOT OLD.started_at OR
    NEW.lease_expires_at IS NOT OLD.lease_expires_at OR
    NEW.created_at IS NOT OLD.created_at OR
    NEW.updated_at IS NOT OLD.updated_at
  )
BEGIN
  SELECT RAISE(ABORT, 'work_items: accepted result is immutable');
END;

CREATE TRIGGER IF NOT EXISTS leases_immutable_fields_guard
BEFORE UPDATE ON leases
WHEN NEW.lease_id IS NOT OLD.lease_id
  OR NEW.work_item_id IS NOT OLD.work_item_id
  OR NEW.worker_id IS NOT OLD.worker_id
  OR NEW.token_hash IS NOT OLD.token_hash
  OR NEW.action_hash IS NOT OLD.action_hash
  OR NEW.issued_at IS NOT OLD.issued_at
  OR NEW.expires_at IS NOT OLD.expires_at
  OR (NEW.status IS NOT OLD.status AND NOT (OLD.status = 'active' AND NEW.status IN ('consumed', 'expired', 'revoked')))
  OR (NEW.closed_at IS NOT OLD.closed_at AND NEW.status = 'active')
BEGIN
  SELECT RAISE(ABORT, 'leases: immutable field modified or invalid transition');
END;

CREATE TRIGGER IF NOT EXISTS execution_results_immutable_guard
BEFORE UPDATE ON execution_results
BEGIN
  SELECT RAISE(ABORT, 'execution_results: append-only');
END;

CREATE TRIGGER IF NOT EXISTS execution_results_no_delete
BEFORE DELETE ON execution_results
BEGIN
  SELECT RAISE(ABORT, 'execution_results: append-only');
END;
