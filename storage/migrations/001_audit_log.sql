CREATE TABLE IF NOT EXISTS audit_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  time_unix_nano TEXT NOT NULL,
  attributes TEXT NOT NULL,
  body TEXT NOT NULL,
  previous_hash TEXT NOT NULL DEFAULT '',
  event_hash TEXT NOT NULL DEFAULT ''
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
  lease_token_hash TEXT,
  started_at TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approval_records (
  work_item_id TEXT NOT NULL,
  action_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL DEFAULT '',
  approval_token_hash TEXT NOT NULL DEFAULT '',
  approved_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'granted',
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL DEFAULT '9999-12-31T23:59:59.999Z',
  consumed_at TEXT,
  PRIMARY KEY (work_item_id, action_hash),
  FOREIGN KEY (work_item_id) REFERENCES work_items(id)
);

CREATE TABLE IF NOT EXISTS connector_records (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  public_key_pem TEXT NOT NULL,
  allowed_scopes_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tunnel_sessions (
  connector_id TEXT NOT NULL,
  tunnel_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_heartbeat_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (connector_id, tunnel_id, session_id),
  FOREIGN KEY (connector_id) REFERENCES connector_records(id)
);
