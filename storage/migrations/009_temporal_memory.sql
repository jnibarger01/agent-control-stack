CREATE TABLE IF NOT EXISTS memory_records (
  id TEXT PRIMARY KEY,
  claim TEXT NOT NULL CHECK (length(trim(claim)) > 0),
  source_type TEXT NOT NULL CHECK (source_type IN ('audit_event', 'file', 'user_message', 'tool_result')),
  source_id TEXT NOT NULL CHECK (length(trim(source_id)) > 0),
  source_hash TEXT NOT NULL CHECK (length(source_hash) = 64 AND source_hash = lower(source_hash)),
  valid_from TEXT NOT NULL CHECK (julianday(valid_from) IS NOT NULL),
  valid_until TEXT CHECK (valid_until IS NULL OR julianday(valid_until) IS NOT NULL),
  confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  tags_json TEXT NOT NULL CHECK (json_valid(tags_json) = 1),
  invalidated_at TEXT CHECK (invalidated_at IS NULL OR julianday(invalidated_at) IS NOT NULL),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_memory_records_active_time
  ON memory_records(valid_from, valid_until, invalidated_at);

CREATE INDEX IF NOT EXISTS idx_memory_records_source
  ON memory_records(source_type, source_id, source_hash);

CREATE TRIGGER IF NOT EXISTS memory_records_no_update
BEFORE UPDATE OF id, claim, source_type, source_id, source_hash, valid_from, confidence, tags_json, created_at
ON memory_records
BEGIN
  SELECT RAISE(ABORT, 'memory_records: immutable history');
END;

CREATE TRIGGER IF NOT EXISTS memory_records_no_delete
BEFORE DELETE ON memory_records
BEGIN
  SELECT RAISE(ABORT, 'memory_records: append-only');
END;
