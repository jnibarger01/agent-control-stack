CREATE TABLE IF NOT EXISTS observation_outbox (
  observation_id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL,
  trace_id TEXT NOT NULL,
  question_set_version TEXT NOT NULL,
  classifier_version TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'degraded')),
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  classifier_outcome TEXT,
  error TEXT,
  UNIQUE (trace_id, question_set_version, classifier_version),
  FOREIGN KEY (work_item_id) REFERENCES work_items(id)
);

CREATE INDEX IF NOT EXISTS idx_observation_outbox_pending
  ON observation_outbox(status, created_at, observation_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_observation_outbox_running
  ON observation_outbox(started_at)
  WHERE status = 'running';
