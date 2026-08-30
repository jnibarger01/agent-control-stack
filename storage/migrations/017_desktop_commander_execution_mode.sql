-- 017_desktop_commander_execution_mode
--
-- Relax the immutable-result dry-run lock so an ACS-authorized real execution
-- through the local Desktop Commander MCP can persist an honest, non-simulated
-- result. The dry_run branch is unchanged; the only new accepted shape is
-- executionMode='desktop_commander' AND simulated=0 AND backend='desktop-commander-mcp'.
--
-- SQLite cannot drop a CHECK constraint in place, so both leaf result tables
-- (nothing FK-references them) are rebuilt with the relaxed constraint and their
-- indexes + append-only / binding guard triggers are recreated verbatim.

-- ---------------------------------------------------------------------------
-- execution_results (compatibility projection, migration 005)
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS execution_results_binding_guard;
DROP TRIGGER IF EXISTS execution_results_immutable_guard;
DROP TRIGGER IF EXISTS execution_results_no_delete;

ALTER TABLE execution_results RENAME TO execution_results__pre017;

CREATE TABLE execution_results (
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
  CHECK (
    (
      json_extract(simulation_metadata_json, '$.executionMode') = 'dry_run'
      AND json_extract(simulation_metadata_json, '$.simulated') = 1
    )
    OR (
      json_extract(simulation_metadata_json, '$.executionMode') = 'desktop_commander'
      AND json_extract(simulation_metadata_json, '$.simulated') = 0
      AND json_extract(simulation_metadata_json, '$.backend') = 'desktop-commander-mcp'
    )
  )
);

INSERT INTO execution_results
  SELECT
    result_id, work_item_id, lease_id, worker_id, idempotency_key, action_hash, outcome,
    started_at, finished_at, exit_code, summary, stdout, stderr, structured_output_json,
    artifacts_json, error, resource_usage_json, simulation_metadata_json, payload_hash, created_at
  FROM execution_results__pre017;

DROP TABLE execution_results__pre017;

CREATE INDEX IF NOT EXISTS idx_execution_results_lease ON execution_results(lease_id);
CREATE INDEX IF NOT EXISTS idx_execution_results_worker_key ON execution_results(worker_id, idempotency_key);

CREATE TRIGGER execution_results_binding_guard
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

CREATE TRIGGER execution_results_immutable_guard
BEFORE UPDATE ON execution_results
BEGIN
  SELECT RAISE(ABORT, 'execution_results: append-only');
END;

CREATE TRIGGER execution_results_no_delete
BEFORE DELETE ON execution_results
BEGIN
  SELECT RAISE(ABORT, 'execution_results: append-only');
END;

-- ---------------------------------------------------------------------------
-- attempt_results (authoritative attempt result, migration 006)
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS attempt_results_binding_guard;
DROP TRIGGER IF EXISTS attempt_results_cancel_race_guard;
DROP TRIGGER IF EXISTS attempt_results_immutable_guard;
DROP TRIGGER IF EXISTS attempt_results_no_delete;

ALTER TABLE attempt_results RENAME TO attempt_results__pre017;

CREATE TABLE attempt_results (
  result_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL UNIQUE,
  work_item_id TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  worker_id TEXT NOT NULL CHECK (length(trim(worker_id)) > 0),
  fencing_epoch INTEGER NOT NULL CHECK (fencing_epoch > 0),
  protocol_version TEXT NOT NULL CHECK (protocol_version = 'acs.worker.v2'),
  idempotency_key TEXT NOT NULL CHECK (length(trim(idempotency_key)) > 0),
  plan_hash TEXT NOT NULL CHECK (length(plan_hash) = 64 AND plan_hash = lower(plan_hash)),
  input_hash TEXT NOT NULL CHECK (length(input_hash) = 64 AND input_hash = lower(input_hash)),
  outcome TEXT NOT NULL CHECK (
    outcome IN ('succeeded', 'failed', 'cancelled', 'worker_infrastructure_failure')
  ),
  outcome_certainty TEXT NOT NULL CHECK (outcome_certainty = 'observed'),
  started_at TEXT NOT NULL CHECK (julianday(started_at) IS NOT NULL),
  finished_at TEXT NOT NULL CHECK (
    julianday(finished_at) IS NOT NULL AND julianday(finished_at) >= julianday(started_at)
  ),
  exit_code INTEGER CHECK (exit_code IS NULL OR (exit_code >= -255 AND exit_code <= 255)),
  summary TEXT NOT NULL,
  stdout TEXT,
  stderr TEXT,
  structured_output_json TEXT NOT NULL CHECK (json_valid(structured_output_json)),
  error TEXT,
  resource_usage_json TEXT CHECK (resource_usage_json IS NULL OR json_valid(resource_usage_json)),
  simulation_metadata_json TEXT NOT NULL CHECK (
    json_valid(simulation_metadata_json)
    AND (
      (
        json_extract(simulation_metadata_json, '$.executionMode') = 'dry_run'
        AND json_extract(simulation_metadata_json, '$.simulated') = 1
      )
      OR (
        json_extract(simulation_metadata_json, '$.executionMode') = 'desktop_commander'
        AND json_extract(simulation_metadata_json, '$.simulated') = 0
        AND json_extract(simulation_metadata_json, '$.backend') = 'desktop-commander-mcp'
      )
    )
  ),
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64 AND payload_hash = lower(payload_hash)),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (worker_id, idempotency_key),
  FOREIGN KEY (attempt_id, work_item_id) REFERENCES execution_attempts(attempt_id, work_item_id),
  FOREIGN KEY (lease_id, attempt_id) REFERENCES attempt_leases(lease_id, attempt_id),
  CHECK (outcome <> 'succeeded' OR exit_code IS NULL OR exit_code = 0),
  CHECK (outcome <> 'cancelled' OR exit_code IS NULL)
);

INSERT INTO attempt_results
  SELECT
    result_id, attempt_id, work_item_id, lease_id, worker_id, fencing_epoch, protocol_version,
    idempotency_key, plan_hash, input_hash, outcome, outcome_certainty, started_at, finished_at,
    exit_code, summary, stdout, stderr, structured_output_json, error, resource_usage_json,
    simulation_metadata_json, payload_hash, created_at
  FROM attempt_results__pre017;

DROP TABLE attempt_results__pre017;

CREATE INDEX IF NOT EXISTS idx_attempt_results_work_item
  ON attempt_results(work_item_id, created_at);
CREATE INDEX IF NOT EXISTS idx_attempt_results_lease
  ON attempt_results(lease_id);

CREATE TRIGGER attempt_results_binding_guard
BEFORE INSERT ON attempt_results
WHEN NOT EXISTS (
  SELECT 1
  FROM attempt_leases AS leases
  JOIN execution_attempts AS attempts
    ON attempts.attempt_id = NEW.attempt_id
   AND attempts.work_item_id = NEW.work_item_id
  WHERE leases.lease_id = NEW.lease_id
    AND leases.attempt_id = NEW.attempt_id
    AND leases.worker_id = NEW.worker_id
    AND leases.fencing_epoch = NEW.fencing_epoch
    AND leases.protocol_version = NEW.protocol_version
    AND leases.plan_hash = NEW.plan_hash
    AND leases.input_hash = NEW.input_hash
    AND leases.status = 'active'
    AND julianday(leases.expires_at) > julianday('now')
    AND attempts.current_fencing_epoch = NEW.fencing_epoch
    AND attempts.claimed_by_worker_id = NEW.worker_id
    AND attempts.status IN ('running', 'cancellation_requested')
)
BEGIN
  SELECT RAISE(ABORT, 'attempt_results: active attempt lease and fence binding is required');
END;

CREATE TRIGGER attempt_results_cancel_race_guard
BEFORE INSERT ON attempt_results
WHEN NEW.outcome = 'succeeded'
  AND EXISTS (
    SELECT 1 FROM execution_attempts
    WHERE attempt_id = NEW.attempt_id AND status = 'cancellation_requested'
  )
BEGIN
  SELECT RAISE(ABORT, 'attempt_results: success is forbidden after cancellation');
END;

CREATE TRIGGER attempt_results_immutable_guard
BEFORE UPDATE ON attempt_results
BEGIN
  SELECT RAISE(ABORT, 'attempt_results: append-only');
END;

CREATE TRIGGER attempt_results_no_delete
BEFORE DELETE ON attempt_results
BEGIN
  SELECT RAISE(ABORT, 'attempt_results: append-only');
END;
