-- Durable autonomous coding missions. Preparation is recorded before any
-- human approval. Post-approval merge and deployment are separate effects
-- and cannot be replayed once their outcome is known.
CREATE TABLE coding_missions (
  mission_id TEXT PRIMARY KEY CHECK (length(mission_id) BETWEEN 1 AND 128),
  repository TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  summary TEXT NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN (
      'PLANNING',
      'RUNNING',
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
      'DEGRADED'
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
  updated_at TEXT NOT NULL
);

CREATE TABLE coding_operations (
  mission_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  depends_on TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'conflict', 'unknown')),
  claim_token TEXT,
  claimed_at TEXT,
  worker_id TEXT,
  route_json TEXT,
  result_hash TEXT,
  files_json TEXT,
  PRIMARY KEY (mission_id, operation_id),
  FOREIGN KEY (mission_id) REFERENCES coding_missions (mission_id)
);

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

CREATE TABLE coding_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  mission_id TEXT NOT NULL,
  name TEXT NOT NULL,
  body_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX coding_missions_state_idx ON coding_missions (state);
CREATE INDEX coding_events_mission_idx ON coding_events (mission_id, event_id);
