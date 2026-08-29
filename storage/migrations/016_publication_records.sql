CREATE TABLE IF NOT EXISTS publication_records (
  publication_id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  attempt_id TEXT NOT NULL,
  branch TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  pull_request_url TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_publication_records_one_work_item ON publication_records(work_item_id);
CREATE TRIGGER IF NOT EXISTS publication_records_no_update BEFORE UPDATE ON publication_records BEGIN
  SELECT RAISE(ABORT, 'publication_records: append-only');
END;
CREATE TRIGGER IF NOT EXISTS publication_records_no_delete BEFORE DELETE ON publication_records BEGIN
  SELECT RAISE(ABORT, 'publication_records: append-only');
END;
