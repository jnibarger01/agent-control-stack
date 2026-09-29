CREATE TABLE IF NOT EXISTS jev_observation_outbox (
  observation_id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  question_set_version TEXT NOT NULL,
  classifier_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'degraded')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  created_at TEXT NOT NULL,
  available_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  classifier_outcome TEXT,
  telemetry_correlation_id TEXT,
  error TEXT,
  UNIQUE (trace_id, question_set_version, classifier_version),
  FOREIGN KEY (work_item_id) REFERENCES work_items(id)
);

CREATE INDEX IF NOT EXISTS idx_jev_observation_pending
  ON jev_observation_outbox(status, available_at, created_at);

CREATE INDEX IF NOT EXISTS idx_jev_observation_work_item
  ON jev_observation_outbox(work_item_id, created_at);
