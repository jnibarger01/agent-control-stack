-- Jev route shadow observations (ADR 0025, shadow stage only).
-- One append-only row per authoritative routing decision records what Jev would have recommended
-- beside what ACS actually decided. It is deliberately NOT part of actor_routing_evidence, which is
-- the replayed source of truth for a resumed decision, so a Jev field can never leak into a replay.
-- The eventual outcome is routing_execution_outcomes joined on decision_id; it is not copied here.
-- mode is constrained to 'shadow'. Advisory or bounded influence needs a new migration and an ADR amendment.

CREATE TABLE IF NOT EXISTS routing_shadow_observations (
  observation_id TEXT PRIMARY KEY,
  decision_id TEXT NOT NULL REFERENCES actor_routing_decisions(decision_id),
  work_item_id TEXT NOT NULL,
  mission_id TEXT,
  source TEXT NOT NULL CHECK (source IN ('jev')),
  mode TEXT NOT NULL CHECK (mode IN ('shadow')),
  status TEXT NOT NULL CHECK (
    status IN ('recommended', 'invalid_recommendation', 'no_recommendation', 'degraded', 'timeout', 'error')
  ),
  recommended_executor_id TEXT,
  confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  model TEXT,
  failure_reason TEXT,
  authoritative_executor_id TEXT,
  authoritative_source TEXT NOT NULL CHECK (authoritative_source IN ('nimble', 'deterministic_fallback')),
  agrees INTEGER CHECK (agrees IS NULL OR agrees IN (0, 1)),
  latency_ms INTEGER CHECK (latency_ms IS NULL OR latency_ms >= 0),
  question_set_version TEXT,
  candidate_json TEXT NOT NULL CHECK (json_valid(candidate_json)),
  probabilities_json TEXT CHECK (probabilities_json IS NULL OR json_valid(probabilities_json)),
  created_at TEXT NOT NULL CHECK (julianday(created_at) IS NOT NULL),
  UNIQUE (decision_id, source),
  CHECK (status = 'recommended' OR status = 'invalid_recommendation' OR agrees IS NULL),
  CHECK ((status IN ('recommended', 'invalid_recommendation')) = (recommended_executor_id IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_routing_shadow_observations_work_item
  ON routing_shadow_observations(work_item_id, created_at DESC);

CREATE TRIGGER IF NOT EXISTS routing_shadow_observations_no_update
BEFORE UPDATE ON routing_shadow_observations
BEGIN
  SELECT RAISE(ABORT, 'routing_shadow_observations: append-only');
END;

CREATE TRIGGER IF NOT EXISTS routing_shadow_observations_no_delete
BEFORE DELETE ON routing_shadow_observations
BEGIN
  SELECT RAISE(ABORT, 'routing_shadow_observations: append-only');
END;
