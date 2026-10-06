-- Generalize the coding mission runtime into a mission / work-unit runtime (no second store).
--
--   coding_missions   keeps its name, rows and FKs. The state CHECK is widened with CREATED, READY,
--                     WAITING_FOR_DEPENDENCY, RECOVERING and CANCELLED; mission_kind distinguishes the existing
--                     'coding' profile from 'general' missions. Coding-profile columns stay NOT NULL and hold ''
--                     for 'general' missions.
--   coding_operations keeps its name and rows and is the work-unit table. The status CHECK is widened with
--                     ready, claimed, checkpointed, verifying, retryable and cancelled. Added: unit_kind,
--                     attempt, payload_json, parent_unit_id, depth, verification_policy, failure_category,
--                     cancel_external_state.
--   mission_budgets / mission_budget_usage   durable, ACS-enforced caps and reported usage.
--
-- SQLite cannot widen a CHECK in place, and renaming a parent table with foreign keys enabled rewrites its children's
-- REFERENCES clauses. So the four coding_* tables with foreign keys are stashed into plain copies, dropped child-first,
-- recreated under their final names, refilled verbatim from the stash, and the stash is dropped. No table is renamed.
-- Existing missions are never rewritten: they keep their state, version and every column value.

CREATE TABLE stash054_missions AS SELECT * FROM coding_missions;
CREATE TABLE stash054_operations AS SELECT * FROM coding_operations;
CREATE TABLE stash054_effects AS SELECT * FROM coding_effects;
CREATE TABLE stash054_evidence AS SELECT * FROM coding_evidence;

DROP TABLE coding_operations;
DROP TABLE coding_effects;
DROP TABLE coding_evidence;
DROP TABLE coding_missions;

CREATE TABLE coding_missions (
  mission_id TEXT PRIMARY KEY CHECK (length(mission_id) BETWEEN 1 AND 128),
  repository TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  summary TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN (
      'CREATED',
      'PLANNING',
      'READY',
      'RUNNING',
      'WAITING_FOR_DEPENDENCY',
      'RECOVERING',
      'RECONCILING',
      'VALIDATING',
      'PREPARING_CHANGE_SET',
      'PUBLISHING_PROPOSAL',
      'WAITING_FOR_APPROVAL',
      'APPROVED',
      'EXECUTING',
      'VERIFYING',
      'COMPLETED',
      'FAILED',
      'DEGRADED',
      'CANCELLED'
    )
  ),
  version INTEGER NOT NULL CHECK (version > 0),
  head_sha TEXT,
  branch TEXT NOT NULL,
  change_set_hash TEXT,
  validation_json TEXT,
  pr_number INTEGER,
  pr_url TEXT,
  approval_id TEXT,
  approval_hash TEXT,
  approved_change_set_hash TEXT,
  approver_id TEXT,
  grant_id TEXT,
  merge_sha TEXT,
  deployment_id TEXT,
  deployment_required INTEGER NOT NULL CHECK (deployment_required IN (0, 1)),
  deployment_action TEXT NOT NULL,
  deployment_impact TEXT NOT NULL,
  failure_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  mission_kind TEXT NOT NULL DEFAULT 'coding' CHECK (mission_kind IN ('coding', 'general')),
  initiator_id TEXT
);

INSERT INTO coding_missions (
  mission_id, repository, base_ref, base_sha, summary, state, version, head_sha, branch, change_set_hash,
  validation_json, pr_number, pr_url, approval_id, approval_hash, approved_change_set_hash, approver_id, grant_id,
  merge_sha, deployment_id, deployment_required, deployment_action, deployment_impact, failure_code, created_at,
  updated_at
)
SELECT
  mission_id, repository, base_ref, base_sha, summary, state, version, head_sha, branch, change_set_hash,
  validation_json, pr_number, pr_url, approval_id, approval_hash, approved_change_set_hash, approver_id, grant_id,
  merge_sha, deployment_id, deployment_required, deployment_action, deployment_impact, failure_code, created_at,
  updated_at
FROM stash054_missions;

CREATE TABLE coding_operations (
  mission_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  depends_on TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN (
      'pending', 'ready', 'claimed', 'running', 'checkpointed', 'verifying',
      'succeeded', 'failed', 'retryable', 'cancelled', 'conflict', 'unknown'
    )
  ),
  claim_token TEXT,
  claimed_at TEXT,
  worker_id TEXT,
  route_json TEXT,
  result_hash TEXT,
  files_json TEXT,
  unit_kind TEXT NOT NULL DEFAULT 'coding' CHECK (
    unit_kind IN ('planning', 'coding', 'shell', 'tool', 'desktop', 'cua', 'verification', 'agent', 'swarm', 'recovery')
  ),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
  parent_unit_id TEXT,
  depth INTEGER NOT NULL DEFAULT 0 CHECK (depth >= 0),
  verification_policy TEXT NOT NULL DEFAULT 'none' CHECK (
    verification_policy IN ('none', 'lightweight', 'independent', 'multi_verifier', 'release_gate')
  ),
  failure_category TEXT CHECK (
    failure_category IS NULL OR failure_category IN (
      'policy_denied', 'authority_expired', 'lease_lost', 'worker_unavailable', 'tool_failure', 'timeout',
      'invalid_output', 'dependency_failure', 'verification_failure', 'environment_changed',
      'retry_budget_exhausted', 'cancelled', 'unknown'
    )
  ),
  cancel_external_state TEXT CHECK (cancel_external_state IS NULL OR cancel_external_state IN ('none', 'uncertain')),
  PRIMARY KEY (mission_id, operation_id),
  FOREIGN KEY (mission_id) REFERENCES coding_missions (mission_id),
  FOREIGN KEY (mission_id, parent_unit_id) REFERENCES coding_operations (mission_id, operation_id)
);

INSERT INTO coding_operations (
  mission_id, operation_id, depends_on, title, status, claim_token, claimed_at, worker_id, route_json, result_hash,
  files_json, attempt
)
SELECT
  mission_id, operation_id, depends_on, title, status, claim_token, claimed_at, worker_id, route_json, result_hash,
  files_json,
  -- A unit that was ever claimed has made at least one attempt.
  CASE WHEN claim_token IS NOT NULL OR status IN ('running', 'succeeded', 'failed', 'conflict', 'unknown') THEN 1 ELSE 0 END
FROM stash054_operations;

CREATE TABLE coding_effects (
  mission_id TEXT NOT NULL,
  effect_kind TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('unknown', 'succeeded')),
  external_id TEXT,
  detail_json TEXT,
  PRIMARY KEY (mission_id, effect_kind),
  FOREIGN KEY (mission_id) REFERENCES coding_missions (mission_id)
);

CREATE TABLE coding_evidence (
  mission_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (mission_id, evidence_id),
  FOREIGN KEY (mission_id) REFERENCES coding_missions (mission_id)
);

INSERT INTO coding_effects (mission_id, effect_kind, outcome, external_id, detail_json)
SELECT mission_id, effect_kind, outcome, external_id, detail_json FROM stash054_effects;
INSERT INTO coding_evidence (mission_id, evidence_id, kind, payload_hash, payload_json, created_at)
SELECT mission_id, evidence_id, kind, payload_hash, payload_json, created_at FROM stash054_evidence;

DROP TABLE stash054_operations;
DROP TABLE stash054_effects;
DROP TABLE stash054_evidence;
DROP TABLE stash054_missions;

CREATE INDEX coding_missions_state_idx ON coding_missions (state);
CREATE INDEX coding_operations_status_idx ON coding_operations (mission_id, status);
CREATE INDEX coding_operations_parent_idx ON coding_operations (mission_id, parent_unit_id);

-- Durable mission budgets. A NULL limit means "no cap on that metric", never zero. Limits are written once.
CREATE TABLE mission_budgets (
  mission_id TEXT PRIMARY KEY REFERENCES coding_missions (mission_id),
  max_wall_clock_ms INTEGER CHECK (max_wall_clock_ms IS NULL OR max_wall_clock_ms > 0),
  max_tool_calls INTEGER CHECK (max_tool_calls IS NULL OR max_tool_calls >= 0),
  max_work_units INTEGER CHECK (max_work_units IS NULL OR max_work_units >= 0),
  max_parallel_work_units INTEGER CHECK (max_parallel_work_units IS NULL OR max_parallel_work_units >= 1),
  max_retries_per_work_unit INTEGER CHECK (max_retries_per_work_unit IS NULL OR max_retries_per_work_unit >= 0),
  max_child_depth INTEGER CHECK (max_child_depth IS NULL OR max_child_depth >= 0),
  max_child_work_units INTEGER CHECK (max_child_work_units IS NULL OR max_child_work_units >= 0),
  max_model_tokens INTEGER CHECK (max_model_tokens IS NULL OR max_model_tokens >= 0),
  max_spend_micro_usd INTEGER CHECK (max_spend_micro_usd IS NULL OR max_spend_micro_usd >= 0),
  created_at TEXT NOT NULL
);

-- Usage that only a worker can report. A missing row means "never reported", which is not the same as zero.
CREATE TABLE mission_budget_usage (
  mission_id TEXT NOT NULL REFERENCES coding_missions (mission_id),
  metric TEXT NOT NULL CHECK (metric IN ('tool_calls', 'model_tokens', 'spend_micro_usd')),
  used INTEGER NOT NULL CHECK (used >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (mission_id, metric)
);

CREATE TRIGGER mission_budgets_no_update
BEFORE UPDATE ON mission_budgets
BEGIN
  SELECT RAISE(ABORT, 'mission_budgets: limits are written once');
END;

CREATE TRIGGER mission_budgets_no_delete
BEFORE DELETE ON mission_budgets
BEGIN
  SELECT RAISE(ABORT, 'mission_budgets: limits are written once');
END;

CREATE TRIGGER mission_budget_usage_monotonic
BEFORE UPDATE OF used ON mission_budget_usage
WHEN NEW.used < OLD.used
BEGIN
  SELECT RAISE(ABORT, 'mission_budget_usage: usage never decreases');
END;
