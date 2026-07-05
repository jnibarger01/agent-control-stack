CREATE TABLE IF NOT EXISTS audit_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  time_unix_nano TEXT NOT NULL,
  attributes TEXT NOT NULL,
  body TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS work_items (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  requester TEXT NOT NULL,
  status TEXT NOT NULL,
  intent TEXT NOT NULL,
  target_json TEXT NOT NULL,
  requested_actions_json TEXT NOT NULL,
  risk TEXT NOT NULL,
  result_json TEXT,
  worker_id TEXT,
  started_at TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
