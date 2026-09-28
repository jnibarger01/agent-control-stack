CREATE TABLE IF NOT EXISTS trace_missions (
  work_item_id TEXT PRIMARY KEY,
  trace_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (work_item_id) REFERENCES work_items(id)
);

CREATE TABLE IF NOT EXISTS trace_chain_state (
  producer_key TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  head_hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trace_outbox (
  event_id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  canonical_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  shipped_at TEXT,
  FOREIGN KEY (work_item_id) REFERENCES work_items(id)
);

CREATE INDEX IF NOT EXISTS idx_trace_outbox_unshipped ON trace_outbox(seq) WHERE shipped_at IS NULL;
