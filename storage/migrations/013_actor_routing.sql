CREATE TABLE IF NOT EXISTS actor_routing_decisions (
  decision_id TEXT PRIMARY KEY,
  work_item_id TEXT NOT NULL REFERENCES work_items(id),
  attempt_id TEXT,
  selected_actor_id TEXT,
  eligible_json TEXT NOT NULL CHECK (json_valid(eligible_json)),
  excluded_json TEXT NOT NULL CHECK (json_valid(excluded_json)),
  scores_json TEXT NOT NULL CHECK (json_valid(scores_json)),
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_actor_routing_decisions_work_item
  ON actor_routing_decisions(work_item_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS actor_routing_decisions_no_update
BEFORE UPDATE ON actor_routing_decisions
BEGIN
  SELECT RAISE(ABORT, 'actor_routing_decisions: append-only');
END;

CREATE TRIGGER IF NOT EXISTS actor_routing_decisions_no_delete
BEFORE DELETE ON actor_routing_decisions
BEGIN
  SELECT RAISE(ABORT, 'actor_routing_decisions: append-only');
END;

CREATE TABLE IF NOT EXISTS actor_reliability_stats (
  actor_id TEXT PRIMARY KEY,
  success_count INTEGER NOT NULL DEFAULT 0 CHECK (success_count >= 0),
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  updated_at TEXT NOT NULL CHECK (julianday(updated_at) IS NOT NULL)
);

CREATE TRIGGER IF NOT EXISTS actor_reliability_stats_no_delete
BEFORE DELETE ON actor_reliability_stats
BEGIN
  SELECT RAISE(ABORT, 'actor_reliability_stats: delete forbidden');
END;
